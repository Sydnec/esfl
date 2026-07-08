import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Match, Player, Prisma } from '../../generated/client';
import { buildPlayerIndex, matchPlayer, teamNamesMatch } from './matching';
import { politeFetch } from './polite-fetch';
import type { GameStatsProvider, MatchContext, ProviderStatLine } from './provider';

const CENTRAL_DATA_URL = 'https://api.grid.gg/central-data/graphql';
const SERIES_STATE_URL = 'https://api.grid.gg/live-data-feed/series-state/graphql';

export interface GridSeriesStateTeam {
  name?: string;
  players?: Array<{
    name?: string;
    kills?: number;
    deaths?: number;
    killAssistsGiven?: number;
  }>;
}

export interface GridSeriesState {
  finished?: boolean;
  teams?: GridSeriesStateTeam[];
}

/** Mappe l'état final d'une série Grid vers nos stats CS2 normalisées. */
export function mapGridSeriesState(state: GridSeriesState, players: Player[]): ProviderStatLine[] {
  const index = buildPlayerIndex(players);
  const lines: ProviderStatLine[] = [];
  for (const team of state.teams ?? []) {
    for (const entry of team.players ?? []) {
      if (!entry.name) continue;
      const local = matchPlayer(index, entry.name);
      if (!local) continue;
      lines.push({
        playerId: local.id,
        raw: entry as unknown as Prisma.InputJsonValue,
        normalized: {
          kills: entry.kills ?? 0,
          deaths: entry.deaths ?? 0,
          assists: entry.killAssistsGiven ?? 0,
          adr: null,
          rating: null,
        },
      });
    }
  }
  return lines;
}

@Injectable()
export class GridStatsProvider implements GameStatsProvider {
  readonly source = 'grid';
  readonly gameId = 'cs2' as const;
  private readonly logger = new Logger(GridStatsProvider.name);

  constructor(private readonly config: ConfigService) {}

  async fetchStats(match: Match, context: MatchContext): Promise<ProviderStatLine[] | null> {
    const apiKey = this.config.get<string>('GRID_API_KEY');
    if (!apiKey) {
      this.logger.warn('GRID_API_KEY absent : pas de stats CS2');
      return null;
    }
    if (!context.teamA || !context.teamB) return null;
    const reference = match.beginAt ?? match.scheduledAt;
    if (!reference) return null;

    const seriesId = await this.findSeriesId(apiKey, reference, context.teamA.name, context.teamB.name);
    if (!seriesId) {
      this.logger.warn(
        `Grid : série ${context.teamA.name} vs ${context.teamB.name} introuvable`,
      );
      return null;
    }

    const state = await this.graphql<{ seriesState?: GridSeriesState }>(
      SERIES_STATE_URL,
      apiKey,
      `query ($id: ID!) {
        seriesState(id: $id) {
          finished
          teams { name players { name kills deaths killAssistsGiven } }
        }
      }`,
      { id: seriesId },
    );
    if (!state?.seriesState?.finished) {
      // Série pas encore clôturée côté Grid : on laisse le retry faire son travail.
      return null;
    }
    const lines = mapGridSeriesState(state.seriesState, context.players);
    if (lines.length === 0) {
      this.logger.warn(`Grid : aucun joueur rapproché pour le match ${match.id}`);
      return null;
    }
    return lines;
  }

  private async findSeriesId(
    apiKey: string,
    reference: Date,
    teamAName: string,
    teamBName: string,
  ): Promise<string | null> {
    const gte = new Date(reference.getTime() - 36 * 3600 * 1000).toISOString();
    const lte = new Date(reference.getTime() + 36 * 3600 * 1000).toISOString();
    const data = await this.graphql<{
      allSeries?: {
        edges?: Array<{
          node?: { id?: string; teams?: Array<{ baseInfo?: { name?: string } }> };
        }>;
      };
    }>(
      CENTRAL_DATA_URL,
      apiKey,
      `query ($gte: String, $lte: String) {
        allSeries(
          first: 50
          filter: { startTimeScheduled: { gte: $gte, lte: $lte } }
          orderBy: StartTimeScheduled
        ) {
          edges { node { id teams { baseInfo { name } } } }
        }
      }`,
      { gte, lte },
    );
    const edges = data?.allSeries?.edges ?? [];
    for (const edge of edges) {
      const names = (edge.node?.teams ?? []).map((team) => team.baseInfo?.name ?? '');
      if (names.length < 2) continue;
      const matches =
        (teamNamesMatch(names[0], teamAName) && teamNamesMatch(names[1], teamBName)) ||
        (teamNamesMatch(names[0], teamBName) && teamNamesMatch(names[1], teamAName));
      if (matches && edge.node?.id) {
        return edge.node.id;
      }
    }
    return null;
  }

  private async graphql<T>(
    url: string,
    apiKey: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T | null> {
    try {
      const response = await politeFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ query, variables }),
      });
      if (!response.ok) {
        this.logger.warn(`Grid ${url} → ${response.status}`);
        return null;
      }
      const payload = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
      if (payload.errors?.length) {
        this.logger.warn(`Grid GraphQL : ${payload.errors.map((e) => e.message).join(' | ')}`);
        return null;
      }
      return payload.data ?? null;
    } catch (error) {
      this.logger.warn(`Grid injoignable : ${String(error)}`);
      return null;
    }
  }
}
