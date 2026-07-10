import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Match, Prisma } from '../../generated/client';
import { teamNamesMatch } from './matching';
import { politeFetch } from './polite-fetch';
import type { GameStatsProvider, MatchContext, ProviderResult, ProviderStatLine } from './provider';

// Hôte Open Platform (api-op) : les clés Open Access n'ont aucun droit sur api.grid.gg.
const CENTRAL_DATA_URL = 'https://api-op.grid.gg/central-data/graphql';
const SERIES_STATE_URL = 'https://api-op.grid.gg/live-data-feed/series-state/graphql';

export interface GridSeriesStateTeam {
  name?: string;
  players?: Array<{
    name?: string;
    kills?: number;
    deaths?: number;
    killAssistsGiven?: number;
  }>;
}

export interface GridSeriesStateGame {
  sequenceNumber?: number;
  map?: { name?: string } | null;
  teams?: Array<{ name?: string; score?: number }>;
  finished?: boolean;
}

export interface GridSeriesState {
  finished?: boolean;
  teams?: GridSeriesStateTeam[];
  games?: GridSeriesStateGame[];
}

/** Manches Grid → détail map + score, côté A/B résolu par noms d'équipes. */
export function mapGridGames(
  state: GridSeriesState,
  teamAName: string,
  teamBName: string,
): Array<{ position: number; map: string | null; scoreA: number | null; scoreB: number | null }> {
  return (state.games ?? [])
    .filter((game) => game.finished !== false && game.sequenceNumber)
    .map((game) => {
      const teamA = (game.teams ?? []).find((team) => teamNamesMatch(team.name ?? '', teamAName));
      const teamB = (game.teams ?? []).find((team) => teamNamesMatch(team.name ?? '', teamBName));
      return {
        position: game.sequenceNumber as number,
        map: game.map?.name ?? null,
        scoreA: teamA?.score ?? null,
        scoreB: teamB?.score ?? null,
      };
    });
}

/** Mappe l'état final d'une série Grid vers nos stats CS2 normalisées. */
export function mapGridSeriesState(
  state: GridSeriesState,
  teamAName: string,
  teamBName: string,
): ProviderStatLine[] {
  const lines: ProviderStatLine[] = [];
  for (const team of state.teams ?? []) {
    const side = teamNamesMatch(team.name ?? '', teamAName)
      ? 'A'
      : teamNamesMatch(team.name ?? '', teamBName)
        ? 'B'
        : null;
    for (const entry of team.players ?? []) {
      if (!entry.name) continue;
      lines.push({
        externalName: entry.name,
        side,
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

  async fetchStats(match: Match, context: MatchContext): Promise<ProviderResult | null> {
    const apiKey = this.config.get<string>('GRID_API_KEY');
    if (!apiKey) {
      this.logger.warn('GRID_API_KEY absent : pas de stats CS2');
      return null;
    }
    if (!context.teamA || !context.teamB) return null;
    const reference = match.beginAt ?? match.scheduledAt;
    if (!reference) return null;

    const seriesId = await this.findSeries(reference, context.teamA.name, context.teamB.name);
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
          games { sequenceNumber finished map { name } teams { name score } }
        }
      }`,
      { id: seriesId },
    );
    if (!state?.seriesState?.finished) {
      // Série pas encore clôturée côté Grid : on laisse le retry faire son travail.
      return null;
    }
    const lines = mapGridSeriesState(state.seriesState, context.teamA.name, context.teamB.name);
    if (lines.length === 0) {
      this.logger.warn(`Grid : aucune ligne de stats pour le match ${match.id}`);
      return null;
    }
    return {
      lines,
      games: mapGridGames(state.seriesState, context.teamA.name, context.teamB.name),
    };
  }

  /**
   * Id de la série Grid correspondant à un match (fenêtre ±36h + noms
   * d'équipes). Null si Grid ne référence pas la rencontre — sert aussi à
   * marquer la couverture des matchs CS2.
   */
  async findSeries(reference: Date, teamAName: string, teamBName: string): Promise<string | null> {
    const apiKey = this.config.get<string>('GRID_API_KEY');
    if (!apiKey) return null;
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
