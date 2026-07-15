import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { GAME_IDS, GameId } from '@esfl/contracts';
import type { Competition, Prisma } from '../../generated/client';
import { Queue } from 'bullmq';
import { mergeGamesSummary } from '../common/games-summary';
import { FantasyClient } from '../fantasy-client/fantasy.client';
import { buildPlayerIndex, matchPlayer, normalizeName } from '../stats/matching';
import { PandascoreClient } from '../pandascore/pandascore.client';
import type { PSMatch, PSSerie, PSStream, PSTeamRef } from '../pandascore/pandascore.types';
import { PrismaService } from '../prisma.service';
import { LiveEventsService } from '../live/live-events.service';
import { enqueueIngestStats, INGESTION_QUEUE, STATS_BACKFILL_DAYS } from './ingestion.constants';

/** Rang des tiers Pandascore (s le plus haut). Sert à choisir le tier d'une série. */
const TIER_RANK: Record<string, number> = { s: 5, a: 4, b: 3, c: 2, d: 1 };

/**
 * Tier d'une compétition : le tier Pandascore est porté par les tournois, pas
 * la série (`serie.tier` est toujours null). On retient le tier le plus élevé
 * parmi les tournois de la série. Null si aucun tier connu.
 */
function bestTier(tournaments?: Array<{ tier: string | null }> | null): string | null {
  let best: string | null = null;
  let bestRank = 0;
  for (const tournament of tournaments ?? []) {
    const tier = tournament.tier?.toLowerCase() ?? null;
    const rank = tier ? (TIER_RANK[tier] ?? 0) : 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = tier;
    }
  }
  return best;
}

/** Filtre catalogue : tiers S/A/B uniquement (tier null accepté, c/d exclus). */
const TIER_ALLOWED: Prisma.CompetitionWhereInput = {
  OR: [{ tier: null }, { tier: { notIn: ['c', 'd'] } }],
};

/** Stream à afficher : français en priorité, sinon le flux officiel. */
function pickStream(streams: PSStream[] | null): string | null {
  if (!streams?.length) return null;
  const french = streams.find((s) => s.language?.toLowerCase().startsWith('fr') && s.raw_url);
  if (french?.raw_url) return french.raw_url;
  return streams.find((s) => s.official && s.raw_url)?.raw_url ?? null;
}

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pandascore: PandascoreClient,
    private readonly fantasyClient: FantasyClient,
    private readonly liveEvents: LiveEventsService,
    private readonly config: ConfigService,
    @InjectQueue(INGESTION_QUEUE) private readonly ingestionQueue: Queue,
  ) {}

  /** Upsert des séries en cours/à venir de tous les jeux. */
  async syncSeries(): Promise<number> {
    let count = 0;
    for (const game of GAME_IDS) {
      const series = await this.pandascore.listActiveSeries(game);
      for (const serie of series) {
        // Catalogue restreint aux tiers S/A/B : on ignore le tier-2/3 (c/d). Le
        // tier null (non encore classé) reste accepté. Tier porté par les tournois.
        const tier = serie.tier ?? bestTier(serie.tournaments);
        if (tier === 'c' || tier === 'd') continue;
        await this.upsertCompetition(game, serie);
        count += 1;
      }
    }
    this.logger.log(`syncSeries : ${count} compétitions synchronisées`);
    return count;
  }

  /**
   * Synchronise matchs + équipes d'une compétition. `enqueueStats` déclenche
   * l'ingestion des stats détaillées à la fin des matchs (activé pour toutes
   * les compétitions ; le paramètre reste un garde-fou pour les appels ciblés).
   */
  async syncMatchesForCompetition(competitionId: string, enqueueStats = true): Promise<void> {
    const competition = await this.prisma.competition.findUnique({ where: { id: competitionId } });
    if (!competition) {
      throw new NotFoundException(`Compétition inconnue : ${competitionId}`);
    }
    const game = competition.gameId as GameId;
    const matches = await this.pandascore.listMatchesForSerie(game, competition.pandascoreId);
    for (const match of matches) {
      await this.upsertMatch(competition, match, enqueueStats);
    }
  }

  /**
   * Compétitions suivies par au moins une ligue ET actives — le périmètre
   * des rosters, la donnée la plus chère à synchroniser et utile uniquement
   * au fantasy (picks).
   */
  private async followedActiveCompetitions() {
    const followed = await this.fantasyClient.followedCompetitionIds();
    if (followed === null) {
      this.logger.warn('Compétitions suivies indisponibles — cycle de sync sauté');
      return [];
    }
    if (followed.length === 0) return [];
    const cutoff = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    return this.prisma.competition.findMany({
      where: {
        id: { in: followed },
        hidden: false,
        AND: [TIER_ALLOWED, { OR: [{ endAt: null }, { endAt: { gte: cutoff } }] }],
      },
    });
  }

  /**
   * Toutes les compétitions actives du catalogue (sans date de fin ou
   * terminées depuis moins de 3 jours) : le planning de la page d'accueil
   * montre tous les matchs, pas seulement ceux des compétitions suivies.
   * L'espacement des requêtes Pandascore (4 s) borne le débit du cycle.
   */
  private activeCompetitions() {
    const cutoff = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    return this.prisma.competition.findMany({
      // Irrécupérables + tier c/d : exclus de la synchro (retirés des données).
      where: {
        hidden: false,
        AND: [TIER_ALLOWED, { OR: [{ endAt: null }, { endAt: { gte: cutoff } }] }],
      },
      orderBy: { beginAt: 'asc' },
    });
  }

  /**
   * Backfill historique (premier démarrage, base vide) : ingère le catalogue et
   * les matchs de toutes les séries dont l'activité chevauche [since, now], puis
   * met en file l'ingestion des stats de tous les matchs finis depuis `since`.
   * Idempotent (upserts + jobId déterministe), lancé en arrière-plan par un job
   * BullMQ ; le throttle Pandascore et la sérialisation de la file bornent la
   * charge (l'ingestion s'étale sur plusieurs heures selon le volume).
   */
  async backfillHistory(since: Date): Promise<void> {
    this.logger.log(
      `Backfill historique depuis ${since.toISOString().slice(0, 10)} : catalogue + matchs…`,
    );
    let competitions = 0;
    for (const game of GAME_IDS) {
      let series: PSSerie[];
      try {
        series = await this.pandascore.listSeriesSince(game, since);
      } catch (error) {
        this.logger.error(`Backfill ${game} : listing des séries échoué (${String(error)})`);
        continue;
      }
      for (const serie of series) {
        const tier = serie.tier ?? bestTier(serie.tournaments);
        if (tier === 'c' || tier === 'd') continue;
        try {
          const competition = await this.upsertCompetition(game, serie);
          // enqueueStats=false : le gating < 48h ignorerait l'historique ; les
          // stats sont mises en file en masse ci-dessous pour tous les finis.
          await this.syncMatchesForCompetition(competition.id, false);
          competitions += 1;
        } catch (error) {
          this.logger.error(`Backfill série ${serie.id} : ${String(error)}`);
        }
      }
    }

    // Stats de tous les matchs finis (hors forfait) depuis `since`. CS2 encore
    // non vérifié (gridCovered null) inclus : la vérif de couverture fera le tri.
    const finished = await this.prisma.match.findMany({
      where: {
        status: 'finished',
        forfeit: false,
        endAt: { gte: since },
        competition: { hidden: false, AND: [TIER_ALLOWED] },
        OR: [{ gameId: { not: 'cs2' } }, { gridCovered: true }, { gridCovered: null }],
      },
      select: { id: true },
    });
    for (const match of finished) {
      await enqueueIngestStats(this.ingestionQueue, match.id);
    }
    this.logger.log(
      `Backfill historique : ${competitions} compétitions, ${finished.length} matchs finis mis en file pour les stats`,
    );
  }

  async syncAllActiveMatches(): Promise<void> {
    const competitions = await this.activeCompetitions();
    for (const competition of competitions) {
      try {
        // Stats détaillées ingérées pour TOUTES les compétitions, pas seulement
        // les suivies : le throttle par hôte des sources et le job de backfill
        // bornent la charge (la file sérialise, seule la latence augmente).
        await this.syncMatchesForCompetition(competition.id, true);
      } catch (error) {
        this.logger.error(`syncMatches ${competition.name} : ${String(error)}`);
      }
    }
  }

  /** Récupère les rosters des équipes engagées dans une compétition. */
  async syncRostersForCompetition(competitionId: string): Promise<void> {
    const competition = await this.prisma.competition.findUnique({
      where: { id: competitionId },
      include: { teams: { include: { team: true } } },
    });
    if (!competition) {
      throw new NotFoundException(`Compétition inconnue : ${competitionId}`);
    }
    const game = competition.gameId as GameId;
    const pandascoreTeamIds = competition.teams.map((entry) => entry.team.pandascoreId);
    const teams = await this.pandascore.listTeamsWithPlayers(game, pandascoreTeamIds);
    for (const team of teams) {
      const localTeam = await this.prisma.team.findUnique({
        where: { pandascoreId: team.id },
      });
      if (!localTeam) continue;

      // Roster courant Pandascore : sert à ne garder actifs que les titulaires
      // du moment (les départs / remplaçants d'un seul match sont désactivés).
      const currentPandascoreIds = team.players.map((player) => player.id);

      // Fiches créées par les providers de stats (pandascoreId null) dans
      // cette équipe : candidates à l'adoption quand Pandascore rattrape.
      const orphans = await this.prisma.player.findMany({
        where: { teamId: localTeam.id, pandascoreId: null },
      });
      const orphanIndex = buildPlayerIndex(orphans);

      for (const player of team.players) {
        const enrichment = {
          name: player.name,
          firstName: player.first_name,
          lastName: player.last_name,
          imageUrl: player.image_url,
          role: player.role,
          nationality: player.nationality,
          teamId: localTeam.id,
        };
        const existing = await this.prisma.player.findUnique({
          where: { pandascoreId: player.id },
        });
        if (existing) {
          await this.prisma.player.update({ where: { id: existing.id }, data: enrichment });
          continue;
        }
        const orphan = matchPlayer(orphanIndex, player.name);
        if (orphan) {
          // Adoption : la fiche provider devient la fiche Pandascore.
          await this.prisma.player.update({
            where: { id: orphan.id },
            data: { ...enrichment, pandascoreId: player.id, source: 'pandascore' },
          });
          orphanIndex.delete(normalizeName(orphan.name));
          this.logger.log(`Fiche ${orphan.name} adoptée par Pandascore #${player.id}`);
          continue;
        }
        await this.prisma.player.create({
          data: { ...enrichment, pandascoreId: player.id, gameId: game },
        });
      }

      // Réconciliation « titulaires actuels » : tout le monde inactif, puis on
      // réactive le roster courant. Garde-fou : liste vide (hoquet API) → on ne
      // touche à rien pour ne pas masquer toute une équipe par erreur.
      if (currentPandascoreIds.length > 0) {
        await this.prisma.player.updateMany({
          where: { teamId: localTeam.id },
          data: { active: false },
        });
        await this.prisma.player.updateMany({
          where: { teamId: localTeam.id, pandascoreId: { in: currentPandascoreIds } },
          data: { active: true },
        });
      }
    }
  }

  async syncAllActiveRosters(): Promise<void> {
    const competitions = await this.followedActiveCompetitions();
    for (const competition of competitions) {
      try {
        await this.syncRostersForCompetition(competition.id);
      } catch (error) {
        this.logger.error(`syncRosters ${competition.name} : ${String(error)}`);
      }
    }
  }

  /** Sync ciblé d'une compétition (déclenché quand une ligue l'ajoute) : suivie, donc stats incluses. */
  async syncCompetition(competitionId: string): Promise<void> {
    await this.syncMatchesForCompetition(competitionId, true);
    await this.syncRostersForCompetition(competitionId);
  }

  /**
   * Fenêtre « live » : 1 requête par compétition sur [-12h, +6h] pour
   * détecter rapidement débuts et fins de match (cadence 3 min, quota tenu).
   */
  async syncLiveWindow(): Promise<void> {
    const from = new Date(Date.now() - 12 * 3600 * 1000);
    const to = new Date(Date.now() + 6 * 3600 * 1000);
    // Cadence 3 min × toutes les compétitions actives exploserait le quota :
    // on ne paie que celles dont l'état local montre un match dans la fenêtre
    // (running, ou programmé dedans) — déterminé en base, gratuitement.
    const concerned = await this.prisma.match.groupBy({
      by: ['competitionId'],
      where: {
        OR: [{ status: 'running' }, { scheduledAt: { gte: from, lte: to } }],
      },
    });
    const competitions = await this.prisma.competition.findMany({
      where: { id: { in: concerned.map((group) => group.competitionId) } },
    });
    for (const competition of competitions) {
      try {
        const matches = await this.pandascore.listMatchesInWindow(
          competition.gameId as GameId,
          competition.pandascoreId,
          from,
          to,
        );
        for (const match of matches) {
          // Toutes les compétitions (pas seulement les suivies) : stats ingérées.
          await this.upsertMatch(competition, match, true);
        }
      } catch (error) {
        this.logger.error(`syncLive ${competition.name} : ${String(error)}`);
      }
    }
  }

  private upsertCompetition(game: GameId, serie: PSSerie): Promise<Competition> {
    const name = [serie.league?.name, serie.full_name].filter(Boolean).join(' ');
    const data = {
      gameId: game,
      name: name || `Série ${serie.id}`,
      slug: serie.slug,
      tier: serie.tier ?? bestTier(serie.tournaments),
      beginAt: serie.begin_at ? new Date(serie.begin_at) : null,
      endAt: serie.end_at ? new Date(serie.end_at) : null,
      imageUrl: serie.league?.image_url ?? null,
    };
    return this.prisma.competition.upsert({
      where: { pandascoreId: serie.id },
      create: { pandascoreId: serie.id, ...data },
      update: data,
    });
  }

  private async upsertTeam(game: GameId, competitionId: string, ref: PSTeamRef): Promise<string> {
    const team = await this.prisma.team.upsert({
      where: { pandascoreId: ref.id },
      create: {
        pandascoreId: ref.id,
        gameId: game,
        name: ref.name,
        acronym: ref.acronym,
        imageUrl: ref.image_url,
        location: ref.location,
      },
      update: {
        name: ref.name,
        acronym: ref.acronym,
        imageUrl: ref.image_url,
        location: ref.location,
      },
    });
    await this.prisma.competitionTeam.upsert({
      where: { competitionId_teamId: { competitionId, teamId: team.id } },
      create: { competitionId, teamId: team.id },
      update: {},
    });
    return team.id;
  }

  private async upsertMatch(
    competition: Competition,
    match: PSMatch,
    enqueueStats: boolean,
  ): Promise<void> {
    const game = competition.gameId as GameId;
    const opponents = match.opponents.filter((o) => o.type === 'Team').map((o) => o.opponent);
    const [teamAId, teamBId] = await Promise.all(
      opponents.slice(0, 2).map((ref) => this.upsertTeam(game, competition.id, ref)),
    );

    const scoreFor = (localTeamId: string | undefined): number | null => {
      if (!localTeamId) return null;
      const ref = opponents.find((_, index) => index === (localTeamId === teamAId ? 0 : 1));
      const result = match.results?.find((r) => r.team_id === ref?.id);
      return result?.score ?? null;
    };

    // Le vainqueur est forcément l'un des deux opposants déjà upsertés :
    // son id local se déduit de sa position, sans requête.
    const winnerIndex = match.winner_id
      ? opponents.slice(0, 2).findIndex((o) => o.id === match.winner_id)
      : -1;
    const winnerTeamId = winnerIndex === 0 ? teamAId : winnerIndex === 1 ? teamBId : null;

    const status = match.status === 'postponed' ? 'not_started' : match.status;
    // Manches gagnées : winner.id pandascore → côté A ou B du match local.
    // Fusion avec l'existant : ne pas écraser l'enrichissement des providers
    // de stats (map, scores par manche).
    const current = await this.prisma.match.findUnique({
      where: { pandascoreId: match.id },
      select: { gamesSummary: true, status: true, scoreA: true, scoreB: true },
    });
    const gamesSummary = mergeGamesSummary(
      current?.gamesSummary,
      (match.games ?? [])
        .filter((g) => g.finished || g.status === 'running')
        .sort((a, b) => a.position - b.position)
        .map((g) => ({
          position: g.position,
          lengthSec: g.length,
          winner:
            g.winner?.id && g.winner.id === opponents[0]?.id
              ? 'A'
              : g.winner?.id && g.winner.id === opponents[1]?.id
                ? 'B'
                : null,
        })),
    ) as unknown as Prisma.InputJsonValue;
    const shared = {
      name: match.name,
      status,
      scheduledAt: match.scheduled_at ? new Date(match.scheduled_at) : null,
      beginAt: match.begin_at ? new Date(match.begin_at) : null,
      endAt: match.end_at ? new Date(match.end_at) : null,
      teamAId: teamAId ?? null,
      teamBId: teamBId ?? null,
      scoreA: scoreFor(teamAId),
      scoreB: scoreFor(teamBId),
      winnerTeamId: winnerTeamId ?? null,
      forfeit: match.forfeit,
      tournamentId: match.tournament?.id ?? null,
      tournamentName: match.tournament?.name ?? null,
      bestOf: match.number_of_games,
      streamUrl: pickStream(match.streams_list),
      gamesSummary,
    };
    const saved = await this.prisma.match.upsert({
      where: { pandascoreId: match.id },
      create: {
        pandascoreId: match.id,
        gameId: game,
        competitionId: competition.id,
        ...shared,
      },
      update: shared,
    });

    // Signal front : ce qui est visible sur une page match a changé.
    const visibleChange =
      !current ||
      current.status !== saved.status ||
      current.scoreA !== saved.scoreA ||
      current.scoreB !== saved.scoreB;
    if (visibleChange) {
      this.liveEvents.emitMatchUpdated({ matchId: saved.id, gameId: game });
    }

    // Stats détaillées à la fin d'un match récent (< 48h), pour toutes les
    // compétitions. enqueueStats reste un garde-fou (false ne déclenche rien).
    // Dates toutes nulles (trou de données Pandascore) : on tente quand même.
    // Forfait : aucune stat à récupérer (personne n'a joué) — on saute.
    if (enqueueStats && saved.status === 'finished' && !saved.forfeit && !saved.finishedEventSent) {
      const finishedAt = saved.endAt ?? saved.beginAt ?? saved.scheduledAt;
      const isRecent =
        !finishedAt || Date.now() - finishedAt.getTime() < 48 * 3600 * 1000;
      if (isRecent) {
        await enqueueIngestStats(this.ingestionQueue, saved.id);
        // Flag posé après l'enqueue : s'il échoue, il n'est pas persisté et
        // le cycle suivant retente (jobId déterministe, pas de doublon).
        await this.prisma.match.update({
          where: { id: saved.id },
          data: { finishedEventSent: true },
        });
      }
    }
  }

  /**
   * Rattrapage des sources publiées tardivement : ré-arme l'ingestion des
   * stats pour tout match terminé encore sans stats dans l'horizon
   * (`STATS_BACKFILL_DAYS`, surchargeable par env). Le flux normal n'enqueue
   * qu'une fois dans les 48h de la fin du match ; si la source (Grid, upload
   * ballchasing…) ne publie qu'après, le match reste sans stats à vie. Ici on
   * relance `enqueueIngestStats` : la dédup par jobId sert d'auto-throttle
   * (une chaîne de retries vivante n'est pas doublée, une chaîne échouée
   * repart) et le job `ingest-stats` refait findSeries + diagnostic + persist.
   * Tous jeux : le provider est choisi par gameId côté ingestion. Borné en
   * horizon et en volume (quota des sources rate-limitées).
   */
  async retryStatsBackfill(): Promise<number> {
    const days = Number(this.config.get('STATS_BACKFILL_DAYS')) || STATS_BACKFILL_DAYS;
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
    const matches = await this.prisma.match.findMany({
      where: {
        status: 'finished',
        stats: { none: {} },
        teamAId: { not: null },
        teamBId: { not: null },
        scheduledAt: { gte: cutoff },
        // Inutile de re-tenter les compétitions déclarées irrécupérables.
        competition: { hidden: false },
      },
      orderBy: { scheduledAt: 'desc' },
      take: 50,
      select: { id: true },
    });
    for (const match of matches) {
      await enqueueIngestStats(this.ingestionQueue, match.id);
    }
    if (matches.length) {
      this.logger.log(`retry-stats-backfill : ${matches.length} match(s) sans stats ré-armés`);
    }
    return matches.length;
  }

  /**
   * Détecte les compétitions irrécupérables et les masque (`hidden`). Une
   * compétition est irrécupérable quand au moins `MIN_NO_COVERAGE` de ses
   * matchs terminés ont été **tentés puis diagnostiqués `no-coverage`** (la
   * source ne référence pas la rencontre) et qu'aucun match n'a de stats. On
   * s'appuie sur le diagnostic d'échec, pas sur l'âge : une compétition jamais
   * ingérée (ex. LCK non suivie) reste récupérable et n'est PAS masquée — seul
   * un échec confirmé à la source compte (cas XSE, absente du feed Grid).
   * Idempotent et réversible : repasse `hidden` à false dès qu'une stat arrive.
   */
  async flagUnrecoverableCompetitions(): Promise<number> {
    const MIN_NO_COVERAGE = 5;

    const [noCoverageByComp, withStats, competitions] = await Promise.all([
      // Matchs tentés et confirmés absents de la source (retries épuisés).
      this.prisma.match.groupBy({
        by: ['competitionId'],
        where: { status: 'finished', statsFailureKind: 'no-coverage' },
        _count: { _all: true },
      }),
      this.prisma.match.findMany({
        where: { status: 'finished', stats: { some: {} } },
        select: { competitionId: true },
        distinct: ['competitionId'],
      }),
      this.prisma.competition.findMany({ select: { id: true, hidden: true } }),
    ]);
    const noCoverageMap = new Map(
      noCoverageByComp.map((row) => [row.competitionId, row._count._all]),
    );
    const withStatsIds = new Set(withStats.map((row) => row.competitionId));

    let changed = 0;
    for (const competition of competitions) {
      const unrecoverable =
        (noCoverageMap.get(competition.id) ?? 0) >= MIN_NO_COVERAGE &&
        !withStatsIds.has(competition.id);
      if (unrecoverable !== competition.hidden) {
        await this.prisma.competition.update({
          where: { id: competition.id },
          data: { hidden: unrecoverable },
        });
        changed += 1;
        this.logger.log(
          `Compétition ${competition.id} ${unrecoverable ? 'masquée (irrécupérable)' : 'ré-affichée (récupérable)'}`,
        );
      }
    }
    return changed;
  }
}
