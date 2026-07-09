import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { GameId, QUEUES, StatsIngestedEvent } from '@esfl/contracts';
import { Queue } from 'bullmq';
import type { Match, Prisma } from '../../generated/client';
import { PrismaService } from '../prisma.service';
import { GridStatsProvider } from './grid.provider';
import { LeaguepediaStatsProvider } from './leaguepedia.provider';
import { OctaneStatsProvider } from './octane.provider';
import type { GameStatsProvider, MatchContext } from './provider';
import { VlrStatsProvider } from './vlr.provider';

@Injectable()
export class StatsIngestionService {
  private readonly logger = new Logger(StatsIngestionService.name);
  private readonly providers: GameStatsProvider[];

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUES.STATS_INGESTED) private readonly statsIngestedQueue: Queue,
    grid: GridStatsProvider,
    vlr: VlrStatsProvider,
    leaguepedia: LeaguepediaStatsProvider,
    octane: OctaneStatsProvider,
  ) {
    this.providers = [grid, vlr, leaguepedia, octane];
  }

  /**
   * Récupère les stats détaillées d'un match terminé et publie stats.ingested.
   * Lève si les stats ne sont pas encore publiées par la source externe :
   * le job BullMQ `ingest-stats` retentera avec backoff exponentiel.
   */
  async ingestForMatchId(matchId: string): Promise<void> {
    const match = await this.prisma.match.findUnique({ where: { id: matchId } });
    if (!match) {
      this.logger.warn(`ingest-stats : match inconnu ${matchId}`);
      return;
    }

    const existing = await this.prisma.playerMatchStats.count({ where: { matchId } });
    if (existing > 0) {
      await this.publish(match, 'existing');
      return;
    }

    const provider = this.providers.find((candidate) => candidate.gameId === match.gameId);
    if (!provider) {
      this.logger.warn(`Aucun provider de stats pour ${match.gameId} (match ${matchId})`);
      return;
    }

    const context = await this.loadContext(match);
    const result = await provider.fetchStats(match, context);
    if (!result || result.lines.length === 0) {
      throw new Error(
        `Stats indisponibles pour le match ${matchId} via ${provider.source}, nouvelle tentative planifiée`,
      );
    }

    for (const line of result.lines) {
      await this.prisma.playerMatchStats.upsert({
        where: { matchId_playerId: { matchId: match.id, playerId: line.playerId } },
        create: {
          matchId: match.id,
          playerId: line.playerId,
          gameId: match.gameId,
          source: provider.source,
          raw: line.raw,
          normalized: line.normalized,
        },
        update: { raw: line.raw, normalized: line.normalized, source: provider.source },
      });
    }
    if (result.games?.length) {
      await this.mergeGamesSummary(match, result.games);
    }
    this.logger.log(
      `${result.lines.length} lignes de stats ${provider.source} pour le match ${matchId}`,
    );
    await this.publish(match, provider.source);
  }

  /** Fusionne le détail des manches du provider (map, scores) avec celui de Pandascore (winner, durée). */
  private async mergeGamesSummary(
    match: Match,
    providerGames: Array<{ position: number; map?: string | null; scoreA?: number | null; scoreB?: number | null }>,
  ): Promise<void> {
    const existing = Array.isArray(match.gamesSummary)
      ? (match.gamesSummary as Array<Record<string, unknown>>)
      : [];
    const byPosition = new Map(existing.map((entry) => [Number(entry.position), { ...entry }]));
    for (const game of providerGames) {
      const entry = byPosition.get(game.position) ?? { position: game.position, winner: null };
      if (game.map != null) entry.map = game.map;
      if (game.scoreA != null) entry.scoreA = game.scoreA;
      if (game.scoreB != null) entry.scoreB = game.scoreB;
      byPosition.set(game.position, entry);
    }
    const merged = [...byPosition.values()].sort(
      (a, b) => Number(a.position) - Number(b.position),
    );
    await this.prisma.match.update({
      where: { id: match.id },
      data: { gamesSummary: merged as unknown as Prisma.InputJsonValue },
    });
  }

  private async loadContext(match: Match): Promise<MatchContext> {
    const teamIds = [match.teamAId, match.teamBId].filter((id): id is string => Boolean(id));
    const [teams, players] = await Promise.all([
      this.prisma.team.findMany({ where: { id: { in: teamIds } } }),
      this.prisma.player.findMany({ where: { teamId: { in: teamIds } } }),
    ]);
    return {
      teamA: teams.find((team) => team.id === match.teamAId) ?? null,
      teamB: teams.find((team) => team.id === match.teamBId) ?? null,
      players,
    };
  }

  private async publish(match: Match, source: string): Promise<void> {
    const event: StatsIngestedEvent = {
      matchId: match.id,
      gameId: match.gameId as GameId,
      source,
      ingestedAt: new Date().toISOString(),
    };
    await this.statsIngestedQueue.add('stats-ingested', event, {
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
    this.logger.log(`stats.ingested publié pour ${match.id} (source: ${source})`);
  }
}
