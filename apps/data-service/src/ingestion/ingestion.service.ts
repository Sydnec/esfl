import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { GAME_IDS, GameId, MatchFinishedEvent, QUEUES } from '@esfl/contracts';
import type { Competition } from '../../generated/client';
import { Queue } from 'bullmq';
import { PandascoreClient } from '../pandascore/pandascore.client';
import type { PSMatch, PSSerie, PSTeamRef } from '../pandascore/pandascore.types';
import { PrismaService } from '../prisma.service';
import { StatsIngestionService } from '../stats/stats-ingestion';

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pandascore: PandascoreClient,
    @InjectQueue(QUEUES.MATCH_FINISHED) private readonly matchFinishedQueue: Queue,
    private readonly statsIngestion: StatsIngestionService,
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

  /** Compétitions actives = sans date de fin ou terminées depuis moins de 3 jours. */
  async syncAllActiveMatches(): Promise<void> {
    const cutoff = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    const competitions = await this.prisma.competition.findMany({
      where: { OR: [{ endAt: null }, { endAt: { gte: cutoff } }] },
    });
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
      for (const player of team.players) {
        await this.prisma.player.upsert({
          where: { pandascoreId: player.id },
          create: {
            pandascoreId: player.id,
            gameId: game,
            name: player.name,
            firstName: player.first_name,
            lastName: player.last_name,
            imageUrl: player.image_url,
            role: player.role,
            teamId: localTeam.id,
          },
          update: {
            name: player.name,
            imageUrl: player.image_url,
            role: player.role,
            teamId: localTeam.id,
          },
        });
      }
    }
  }

  async syncAllActiveRosters(): Promise<void> {
    const cutoff = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    const competitions = await this.prisma.competition.findMany({
      where: { OR: [{ endAt: null }, { endAt: { gte: cutoff } }] },
      select: { id: true, name: true },
    });
    for (const competition of competitions) {
      try {
        await this.syncRostersForCompetition(competition.id);
      } catch (error) {
        this.logger.error(`syncRosters ${competition.name} : ${String(error)}`);
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
      },
      update: { name: ref.name, acronym: ref.acronym, imageUrl: ref.image_url },
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

    const winnerRef = opponents.find((o) => o.id === match.winner_id);
    const winnerTeam = winnerRef
      ? await this.prisma.team.findUnique({ where: { pandascoreId: winnerRef.id } })
      : null;

    const status = match.status === 'postponed' ? 'not_started' : match.status;
    const saved = await this.prisma.match.upsert({
      where: { pandascoreId: match.id },
      create: {
        pandascoreId: match.id,
        gameId: game,
        competitionId: competition.id,
        name: match.name,
        status,
        scheduledAt: match.scheduled_at ? new Date(match.scheduled_at) : null,
        beginAt: match.begin_at ? new Date(match.begin_at) : null,
        endAt: match.end_at ? new Date(match.end_at) : null,
        teamAId: teamAId ?? null,
        teamBId: teamBId ?? null,
        scoreA: scoreFor(teamAId),
        scoreB: scoreFor(teamBId),
        winnerTeamId: winnerTeam?.id ?? null,
      },
      update: {
        name: match.name,
        status,
        scheduledAt: match.scheduled_at ? new Date(match.scheduled_at) : null,
        beginAt: match.begin_at ? new Date(match.begin_at) : null,
        endAt: match.end_at ? new Date(match.end_at) : null,
        teamAId: teamAId ?? null,
        teamBId: teamBId ?? null,
        scoreA: scoreFor(teamAId),
        scoreB: scoreFor(teamBId),
        winnerTeamId: winnerTeam?.id ?? null,
      },
    });

    if (saved.status === 'finished' && !saved.finishedEventSent) {
      await this.publishMatchFinished({
        matchId: saved.id,
        gameId: game,
        competitionId: competition.id,
        finishedAt: (saved.endAt ?? new Date()).toISOString(),
      });
      await this.prisma.match.update({
        where: { id: saved.id },
        data: { finishedEventSent: true },
      });
      await this.statsIngestion.ingestForMatch(saved);
    }
  }

  async publishMatchFinished(event: MatchFinishedEvent): Promise<void> {
    await this.matchFinishedQueue.add('match-finished', event, {
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
    this.logger.log(`match.finished publié pour ${event.matchId}`);
  }
}
