import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { GameId, QUEUES, StatsIngestedEvent } from '@esfl/contracts';
import { Queue } from 'bullmq';
import type { Match, Prisma } from '../../generated/client';
import { PrismaService } from '../prisma.service';

/** Ligne de stats retournée par un provider, indexée sur nos ids internes. */
export interface ProviderStatLine {
  playerId: string;
  raw: Prisma.InputJsonValue;
  normalized: Prisma.InputJsonValue;
}

/**
 * Adapter de stats détaillées par jeu. Implémentations prévues :
 * - cs2 : Grid.gg Open Access (nécessite GRID_API_KEY, candidature gratuite)
 * - valorant : VLR.gg (API communautaire non officielle, ex: vlrggapi auto-hébergée)
 * - lol : Leaguepedia Cargo API (publique)
 * - rl : Octane zsr API (publique, https://zsr.octane.gg)
 * Le défi principal est le rapprochement des entités (noms de joueurs/équipes
 * externes → ids Pandascore locaux) : à traiter provider par provider.
 */
export interface GameStatsProvider {
  readonly source: string;
  readonly gameId: GameId;
  fetchStats(match: Match): Promise<ProviderStatLine[] | null>;
}

@Injectable()
export class GridStatsProvider implements GameStatsProvider {
  readonly source = 'grid';
  readonly gameId = 'cs2' as const;

  async fetchStats(_match: Match): Promise<ProviderStatLine[] | null> {
    // TODO : brancher Grid.gg Open Access une fois la clé obtenue (GRID_API_KEY).
    return null;
  }
}

@Injectable()
export class VlrStatsProvider implements GameStatsProvider {
  readonly source = 'vlr';
  readonly gameId = 'valorant' as const;

  async fetchStats(_match: Match): Promise<ProviderStatLine[] | null> {
    // TODO : scraper/API VLR.gg (rapprochement par noms d'équipes + date).
    return null;
  }
}

@Injectable()
export class LeaguepediaStatsProvider implements GameStatsProvider {
  readonly source = 'leaguepedia';
  readonly gameId = 'lol' as const;

  async fetchStats(_match: Match): Promise<ProviderStatLine[] | null> {
    // TODO : Cargo API Leaguepedia (table ScoreboardPlayers).
    return null;
  }
}

@Injectable()
export class OctaneStatsProvider implements GameStatsProvider {
  readonly source = 'octane';
  readonly gameId = 'rl' as const;

  async fetchStats(_match: Match): Promise<ProviderStatLine[] | null> {
    // TODO : zsr.octane.gg /matches (rapprochement par équipes + date).
    return null;
  }
}

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
   * Tente d'obtenir les stats détaillées d'un match terminé puis publie
   * stats.ingested. Si des stats existent déjà (seed, run précédent),
   * publie directement.
   */
  async ingestForMatch(match: Match): Promise<void> {
    const existing = await this.prisma.playerMatchStats.count({ where: { matchId: match.id } });
    if (existing > 0) {
      await this.publish(match, 'existing');
      return;
    }

    const provider = this.providers.find((candidate) => candidate.gameId === match.gameId);
    const lines = provider ? await provider.fetchStats(match) : null;
    if (!provider || !lines || lines.length === 0) {
      this.logger.warn(
        `Pas de stats disponibles pour le match ${match.id} (${match.gameId}) — provider à brancher`,
      );
      return;
    }

    for (const line of lines) {
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
    await this.publish(match, provider.source);
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
