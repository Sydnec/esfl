import { Injectable, Logger, NotFoundException } from '@nestjs/common';
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
import { enqueueIngestStats, INGESTION_QUEUE } from './ingestion.constants';

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
    @InjectQueue(INGESTION_QUEUE) private readonly ingestionQueue: Queue,
  ) {}

  /** Upsert des séries en cours/à venir de tous les jeux. */
  async syncSeries(): Promise<number> {
    let count = 0;
    for (const game of GAME_IDS) {
      const series = await this.pandascore.listActiveSeries(game);
      for (const serie of series) {
        await this.upsertCompetition(game, serie);
        count += 1;
      }
    }
    this.logger.log(`syncSeries : ${count} compétitions synchronisées`);
    return count;
  }

  /** Synchronise matchs + équipes d'une compétition, publie les fins de match. */
  async syncMatchesForCompetition(competitionId: string): Promise<void> {
    const competition = await this.prisma.competition.findUnique({ where: { id: competitionId } });
    if (!competition) {
      throw new NotFoundException(`Compétition inconnue : ${competitionId}`);
    }
    const game = competition.gameId as GameId;
    const matches = await this.pandascore.listMatchesForSerie(game, competition.pandascoreId);
    for (const match of matches) {
      await this.upsertMatch(competition, match);
    }
  }

  /**
   * Compétitions à synchroniser en continu : suivies par au moins une ligue
   * ET actives (sans date de fin ou terminées depuis moins de 3 jours).
   * Le ciblage sur les compétitions suivies est ce qui protège le quota
   * Pandascore : le référentiel complet peut contenir des centaines de séries.
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
      where: { id: { in: followed }, OR: [{ endAt: null }, { endAt: { gte: cutoff } }] },
    });
  }

  async syncAllActiveMatches(): Promise<void> {
    const competitions = await this.followedActiveCompetitions();
    for (const competition of competitions) {
      try {
        await this.syncMatchesForCompetition(competition.id);
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

  /** Sync ciblé d'une compétition (déclenché quand une ligue l'ajoute). */
  async syncCompetition(competitionId: string): Promise<void> {
    await this.syncMatchesForCompetition(competitionId);
    await this.syncRostersForCompetition(competitionId);
  }

  /**
   * Fenêtre « live » : 1 requête par compétition suivie sur [-12h, +6h] pour
   * détecter rapidement débuts et fins de match (cadence 3 min, quota tenu).
   */
  async syncLiveWindow(): Promise<void> {
    const competitions = await this.followedActiveCompetitions();
    const from = new Date(Date.now() - 12 * 3600 * 1000);
    const to = new Date(Date.now() + 6 * 3600 * 1000);
    for (const competition of competitions) {
      try {
        const matches = await this.pandascore.listMatchesInWindow(
          competition.gameId as GameId,
          competition.pandascoreId,
          from,
          to,
        );
        for (const match of matches) {
          await this.upsertMatch(competition, match);
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
      tier: serie.tier,
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

  private async upsertMatch(competition: Competition, match: PSMatch): Promise<void> {
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

    // finishedEventSent : « fin de match traitée » (enqueue des stats fait).
    if (saved.status === 'finished' && !saved.finishedEventSent) {
      // Stats uniquement pour les fins de match récentes : quand une ligue
      // ajoute une compétition en cours, ses matchs déjà anciens n'auront
      // jamais de roster — inutile de dépenser du budget API pour eux.
      // Dates toutes nulles (trou de données Pandascore) : on tente quand même.
      const finishedAt = saved.endAt ?? saved.beginAt ?? saved.scheduledAt;
      const isRecent =
        !finishedAt || Date.now() - finishedAt.getTime() < 48 * 3600 * 1000;
      if (isRecent) {
        await enqueueIngestStats(this.ingestionQueue, saved.id);
      }
      // Flag posé en dernier : si l'enqueue échoue, il n'est pas persisté
      // et le cycle suivant retente (jobId déterministe, pas de doublon).
      await this.prisma.match.update({
        where: { id: saved.id },
        data: { finishedEventSent: true },
      });
    }
  }

}
