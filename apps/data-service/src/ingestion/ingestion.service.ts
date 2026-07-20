import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { GAME_IDS, GameId } from '@esfl/contracts';
import type { Competition, Prisma, Team } from '../../generated/client';
import { Queue } from 'bullmq';
import { pandascoreUpdate, providerUpdate } from '../common/field-precedence';
import { createPlayerSafely } from '../common/player-create';
import { mergeGamesSummary } from '../common/games-summary';
import { buildPlayerIndex, matchPlayer, normalizeName } from '../stats/matching';
import type { StarterRef } from '../stats/provider';
import { LeaguepediaStatsProvider } from '../stats/leaguepedia.provider';
import { VlrStatsProvider } from '../stats/vlr.provider';
import { PandascoreClient } from '../pandascore/pandascore.client';
import type { PSMatch, PSSerie, PSStream, PSTeamRef } from '../pandascore/pandascore.types';
import { PrismaService } from '../prisma.service';
import { LiveEventsService } from '../live/live-events.service';
import {
  enqueueEnrichTeam,
  enqueueIngestStats,
  INGESTION_QUEUE,
  STATS_BACKFILL_DAYS,
} from './ingestion.constants';

/** Durée de cache des rosters spécialisés (une équipe apparaît dans N compétitions). */
const STARTER_CACHE_TTL_MS = 6 * 3600 * 1000;

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

  /** Cache mémoire des titulaires par équipe (source spécialisée), TTL court. */
  private readonly starterCache = new Map<string, { starters: StarterRef[] | null; at: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly pandascore: PandascoreClient,
    private readonly liveEvents: LiveEventsService,
    private readonly config: ConfigService,
    private readonly vlr: VlrStatsProvider,
    private readonly leaguepedia: LeaguepediaStatsProvider,
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
      select: { id: true, gameId: true },
    });
    // Entrelacement round-robin par jeu : la file mélange les hôtes (VLR,
    // Cargo, Grid, ballchasing) et le worker concurrent recouvre leurs
    // attentes — une file groupée par jeu avancerait au rythme d'une seule
    // source.
    const byGame = new Map<string, Array<{ id: string }>>();
    for (const match of finished) {
      byGame.set(match.gameId, [...(byGame.get(match.gameId) ?? []), match]);
    }
    const buckets = [...byGame.values()];
    for (let index = 0; buckets.some((bucket) => index < bucket.length); index += 1) {
      for (const bucket of buckets) {
        const match = bucket[index];
        if (match) await enqueueIngestStats(this.ingestionQueue, match.id);
      }
    }
    // Les stats vont créer des joueurs côté provider : le sync des rosters
    // Pandascore les adoptera (photos, nationalités…) sans attendre le cycle
    // 24h. Enfilé après les stats : la file est FIFO, il passera à la fin.
    await this.ingestionQueue
      .add('sync-rosters', {}, { removeOnComplete: true, removeOnFail: 5 })
      .catch((error) => this.logger.warn(`enqueue sync-rosters post-backfill : ${String(error)}`));
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

      // Les joueurs ne sont plus créés depuis Pandascore : les fiches naissent
      // côté provider (match ingéré, fetchStarters). Ici on ne fait que
      // rapprocher (pose du pandascoreId) et compléter les champs manquants —
      // jamais écraser une donnée provider.
      for (const player of team.players) {
        const enrichment = {
          name: player.name,
          firstName: player.first_name,
          lastName: player.last_name,
          imageUrl: player.image_url,
          role: player.role,
          nationality: player.nationality,
        };
        const existing = await this.prisma.player.findUnique({
          where: { pandascoreId: player.id },
        });
        if (existing) {
          const fallback = pandascoreUpdate(enrichment, existing.fieldSources);
          await this.prisma.player.update({
            where: { id: existing.id },
            // Le roster courant appartient aux matchs/starters : Pandascore ne
            // rattache une équipe qu'aux fiches qui n'en ont plus.
            data: existing.teamId ? fallback : { ...fallback, teamId: localTeam.id },
          });
          continue;
        }
        const orphan = matchPlayer(orphanIndex, player.name);
        if (orphan) {
          // Adoption : la fiche provider gagne son pandascoreId (la source
          // reste provider, les champs provider restent maîtres).
          const orphanFull = orphans.find((candidate) => candidate.id === orphan.id);
          await this.prisma.player.update({
            where: { id: orphan.id },
            data: {
              ...pandascoreUpdate(enrichment, orphanFull?.fieldSources),
              pandascoreId: player.id,
            },
          });
          orphanIndex.delete(normalizeName(orphan.name));
          this.logger.log(`Fiche ${orphan.name} adoptée par Pandascore #${player.id}`);
        }
        // Joueur inconnu côté provider : on attend qu'il y apparaisse (pas de
        // fiche 100 % Pandascore).
      }

      // Réconciliation « titulaires actuels » : source spécialisée (Leaguepedia
      // LoL, VLR Valorant) en priorité, sinon roster courant Pandascore.
      await this.reconcileActiveRoster(localTeam, currentPandascoreIds);
    }
  }

  /**
   * Marque `active` les seuls titulaires : source spécialisée du jeu si elle
   * répond, sinon fallback sur le roster courant Pandascore. Garde-fou : on ne
   * désactive jamais toute une équipe sur une liste vide.
   */
  private async reconcileActiveRoster(team: Team, pandascoreIds: number[]): Promise<void> {
    const starters = await this.fetchSpecializedStarters(team);
    if (starters && starters.length > 0) {
      await this.applyStarterRoster(team, starters);
      return;
    }
    if (pandascoreIds.length > 0) {
      // Fallback Pandascore : ne juge que les fiches qu'il connaît
      // (pandascoreId posé) — les fiches provider non adoptées gardent leur
      // statut, décidé par les matchs ingérés / fetchStarters.
      await this.prisma.player.updateMany({
        where: { teamId: team.id, pandascoreId: { not: null } },
        data: { active: false },
      });
      await this.prisma.player.updateMany({
        where: { teamId: team.id, pandascoreId: { in: pandascoreIds } },
        data: { active: true },
      });
    }
  }

  /** Titulaires via la source spécialisée du jeu (cache court par équipe). */
  private async fetchSpecializedStarters(team: Team): Promise<StarterRef[] | null> {
    const provider =
      team.gameId === 'valorant' ? this.vlr : team.gameId === 'lol' ? this.leaguepedia : null;
    if (!provider) return null;
    const key = `${team.gameId}:${team.id}`;
    const cached = this.starterCache.get(key);
    if (cached && Date.now() - cached.at < STARTER_CACHE_TTL_MS) return cached.starters;
    // Id provider appris depuis un match résolu : la source tape la bonne équipe
    // directement (plus de recherche par nom faillible).
    const providerId =
      (team.providerIds as Record<string, string> | null)?.[provider.source] ?? null;
    const starters = await provider
      .fetchStarters(team.name, team.aliases ?? [], providerId)
      .catch((error) => {
        this.logger.warn(`Roster ${provider.source} « ${team.name} » : ${String(error)}`);
        return null;
      });
    this.starterCache.set(key, { starters, at: Date.now() });
    return starters;
  }

  /**
   * Applique un roster de titulaires : résout chaque nom vers un joueur local
   * (crée les recrues absentes de Pandascore), active ceux-là et désactive le
   * reste de l'équipe. Publique : aussi utilisée par l'enrichissement d'équipe
   * (roster lu sur la fiche provider).
   */
  async applyStarterRoster(team: Team, starters: StarterRef[]): Promise<void> {
    const source = team.gameId === 'lol' ? 'leaguepedia' : 'vlr';
    const teamPlayers = await this.prisma.player.findMany({ where: { teamId: team.id } });
    const index = buildPlayerIndex(teamPlayers);
    const byId = new Map(teamPlayers.map((player) => [player.id, player]));
    // Index par id provider : un titulaire dont l'id est déjà connu est rattaché
    // sans ambiguïté (fiable après une première ingestion de match).
    const byProviderId = new Map<string, { id: string; name: string }>();
    for (const player of teamPlayers) {
      const id = (player.providerIds as Record<string, string> | null)?.[source];
      if (id) byProviderId.set(id, player);
    }
    const activeIds = new Set<string>();
    for (const starter of starters) {
      // Métadonnées publiées par la source (rôle, photo, pays Leaguepedia) :
      // provider = source de vérité, appliquées à la création comme aux fiches
      // existantes (complète Canna/Busio dès le passage rosters).
      const profile = {
        role: starter.role ?? null,
        imageUrl: starter.imageUrl ?? null,
        nationality: starter.nationality ?? null,
      };
      let local =
        (starter.externalId ? byProviderId.get(starter.externalId) : undefined) ??
        matchPlayer(index, starter.name);
      if (!local) {
        const seed = providerUpdate(profile, source, { name: source });
        // Création tolérante à la course : `sync-rosters` et `enrich-team`
        // peuvent traiter la même équipe en parallèle sur le même worker.
        const created = await createPlayerSafely(this.prisma, {
          name: starter.name,
          gameId: team.gameId,
          teamId: team.id,
          source,
          providerIds: starter.externalId ? { [source]: starter.externalId } : undefined,
          ...seed.data,
          // Champs posés par le provider : possédés d'entrée.
          fieldSources: seed.fieldSources,
        });
        local = { id: created.id, name: created.name };
        index.set(normalizeName(created.name), local);
        if (starter.externalId) byProviderId.set(starter.externalId, local);
      } else {
        const full = byId.get(local.id);
        if (full) {
          const { data, fieldSources } = providerUpdate(profile, source, full.fieldSources);
          const changed = Object.entries(data).some(
            ([key, value]) => (full as unknown as Record<string, unknown>)[key] !== value,
          );
          if (changed) {
            await this.prisma.player.update({
              where: { id: local.id },
              data: { ...data, fieldSources },
            });
          }
        }
      }
      activeIds.add(local.id);
    }
    await this.prisma.player.updateMany({ where: { teamId: team.id }, data: { active: false } });
    await this.prisma.player.updateMany({
      where: { teamId: team.id, id: { in: [...activeIds] } },
      data: { active: true },
    });
    // Roster « au présent » : un backfill de vieux match ne doit pas le régresser.
    await this.prisma.team.update({
      where: { id: team.id },
      data: { rosterSyncedAt: new Date() },
    });
  }

  /**
   * Rosters de TOUTES les compétitions actives (plus de distinction suivie /
   * non suivie) : la réconciliation des titulaires actuels doit s'appliquer
   * partout, sinon une équipe d'un tournoi non suivi garde tous ses anciens
   * joueurs pickables. Borné par l'espacement Pandascore (4 s).
   */
  async syncAllActiveRosters(): Promise<void> {
    const competitions = await this.activeCompetitions();
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
    // CS2 n'a pas de source de roster pré-match (pas de fetchStarters) :
    // les joueurs naissent à l'ingestion d'un match. On amorce donc les boards
    // en ingérant les derniers matchs finis des équipes de la compétition.
    const competition = await this.prisma.competition.findUnique({ where: { id: competitionId } });
    if (competition && competition.gameId === 'cs2') {
      await this.ingestionQueue
        .add(
          'backfill-team-players',
          { competitionId },
          { jobId: `backfill-team-players-${competitionId}`, removeOnComplete: true, removeOnFail: 20 },
        )
        .catch((error) =>
          this.logger.warn(`enqueue backfill-team-players ${competitionId} : ${String(error)}`),
        );
    }
  }

  /**
   * Amorçage des joueurs CS2/RL d'une compétition fraîchement suivie : enqueue
   * l'ingestion des derniers matchs finis (déjà au catalogue, non-forfait, sans
   * stats) impliquant ses équipes — tous tournois confondus, bornés par équipe.
   * Les matchs qui ont déjà des stats ont déjà créé leurs joueurs.
   */
  async backfillTeamPlayers(competitionId: string): Promise<number> {
    const competition = await this.prisma.competition.findUnique({
      where: { id: competitionId },
      include: { teams: true },
    });
    if (!competition) return 0;
    const teamIds = competition.teams.map((entry) => entry.teamId);
    if (teamIds.length === 0) return 0;
    const since = new Date(Date.now() - STATS_BACKFILL_DAYS * 2 * 24 * 3600 * 1000);
    const matchIds = new Set<string>();
    for (const teamId of teamIds) {
      const recent = await this.prisma.match.findMany({
        where: {
          gameId: competition.gameId,
          status: 'finished',
          forfeit: false,
          endAt: { gte: since },
          stats: { none: {} },
          OR: [{ teamAId: teamId }, { teamBId: teamId }],
        },
        orderBy: { endAt: 'desc' },
        take: 5,
        select: { id: true },
      });
      for (const match of recent) matchIds.add(match.id);
    }
    for (const matchId of matchIds) {
      await enqueueIngestStats(this.ingestionQueue, matchId);
    }
    if (matchIds.size > 0) {
      this.logger.log(
        `Backfill joueurs ${competition.name} : ${matchIds.size} match(s) ré-ingéré(s)`,
      );
    }
    return matchIds.size;
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
    const data = {
      name: ref.name,
      acronym: ref.acronym,
      imageUrl: ref.image_url,
      location: ref.location,
    };
    const existing = await this.prisma.team.findUnique({ where: { pandascoreId: ref.id } });
    let team: Team;
    if (existing) {
      // Fallback Pandascore : ne ré-écrase jamais un champ possédé par un provider.
      team = await this.prisma.team.update({
        where: { id: existing.id },
        data: pandascoreUpdate(data, existing.fieldSources),
      });
    } else {
      team = await this.prisma.team.create({
        data: { pandascoreId: ref.id, gameId: game, ...data },
      });
      // Nouvelle équipe : rapprochement provider proactif + enrichissement.
      await enqueueEnrichTeam(this.ingestionQueue, team.id).catch((error) =>
        this.logger.warn(`enqueue enrich-team ${team.id} : ${String(error)}`),
      );
    }
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
