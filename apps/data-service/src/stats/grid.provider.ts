import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Match, Prisma, Team } from '../../generated/client';
import { PrismaService } from '../prisma.service';
import { inferOpponentAlias, OpponentPair, TeamRef, teamMatches } from './matching';
import { politeFetch } from './polite-fetch';
import type { GameStatsProvider, MatchContext, ProviderResult, ProviderStatLine } from './provider';

// Hôte Open Platform (api-op) : les clés Open Access n'ont aucun droit sur api.grid.gg.
const CENTRAL_DATA_URL = 'https://api-op.grid.gg/central-data/graphql';
const SERIES_STATE_URL = 'https://api-op.grid.gg/live-data-feed/series-state/graphql';
// Id du titre « Counter Strike 2 » chez Grid (requête `titles`).
const CS2_TITLE_ID = '28';
const SERIES_PAGE_SIZE = 50;
const SERIES_MAX_PAGES = 4;
// Corrélation adverse : affiches à moins de 2h du coup d'envoi local.
const ALIAS_MAX_DELTA_MS = 2 * 3600 * 1000;

export interface GridSeriesStateTeam {
  name?: string;
  players?: Array<{
    name?: string;
    kills?: number;
    deaths?: number;
    killAssistsGiven?: number;
    /** Objectifs CS2 : plantBomb, defuseBomb, explodeBomb… */
    objectives?: Array<{ type?: string; completionCount?: number }>;
  }>;
}

export interface GridSeriesStateGame {
  sequenceNumber?: number;
  map?: { name?: string } | null;
  teams?: Array<{ name?: string; score?: number }>;
  started?: boolean;
  finished?: boolean;
}

export interface GridSeriesState {
  finished?: boolean;
  teams?: GridSeriesStateTeam[];
  games?: GridSeriesStateGame[];
}

interface GridSeriesConnection {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string };
  edges?: Array<{
    node?: {
      id?: string;
      startTimeScheduled?: string;
      teams?: Array<{ baseInfo?: { name?: string } }>;
    };
  }>;
}

/** Manches Grid → détail map + score, côté A/B résolu par noms d'équipes.
 * La map en cours (started, pas finished) est incluse pour l'affichage live ;
 * les manches d'un BO pas encore jouées (ni started ni finished) sont exclues. */
export function mapGridGames(
  state: GridSeriesState,
  teamA: TeamRef,
  teamB: TeamRef,
): Array<{ position: number; map: string | null; scoreA: number | null; scoreB: number | null }> {
  return (state.games ?? [])
    .filter((game) => (game.finished !== false || game.started === true) && game.sequenceNumber)
    .map((game) => {
      const sideA = (game.teams ?? []).find((team) => teamMatches(team.name ?? '', teamA));
      const sideB = (game.teams ?? []).find((team) => teamMatches(team.name ?? '', teamB));
      return {
        position: game.sequenceNumber as number,
        map: game.map?.name ?? null,
        scoreA: sideA?.score ?? null,
        scoreB: sideB?.score ?? null,
      };
    });
}

/** Mappe l'état final d'une série Grid vers nos stats CS2 normalisées. */
export function mapGridSeriesState(
  state: GridSeriesState,
  teamA: TeamRef,
  teamB: TeamRef,
): ProviderStatLine[] {
  const lines: ProviderStatLine[] = [];
  for (const team of state.teams ?? []) {
    const side = teamMatches(team.name ?? '', teamA)
      ? 'A'
      : teamMatches(team.name ?? '', teamB)
        ? 'B'
        : null;
    for (const entry of team.players ?? []) {
      if (!entry.name) continue;
      const objectiveCount = (type: string): number =>
        (entry.objectives ?? []).find((objective) => objective.type === type)?.completionCount ?? 0;
      lines.push({
        externalName: entry.name,
        side,
        raw: entry as unknown as Prisma.InputJsonValue,
        normalized: {
          kills: entry.kills ?? 0,
          deaths: entry.deaths ?? 0,
          assists: entry.killAssistsGiven ?? 0,
          // ADR et rating absents du series state Grid open access.
          adr: null,
          rating: null,
          plants: objectiveCount('plantBomb'),
          defuses: objectiveCount('defuseBomb'),
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

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async fetchStats(match: Match, context: MatchContext): Promise<ProviderResult | null> {
    const state = await this.fetchSeriesState(match, context);
    if (!state) return null;
    if (!state.seriesState.finished) {
      // Série pas encore clôturée côté Grid : on laisse le retry faire son travail.
      return null;
    }
    return this.buildResult(match, context, state, { silent: false });
  }

  /**
   * Instantané live : le series state Grid est alimenté pendant la série,
   * la même requête que le post-match suffit — sans exiger `finished`.
   */
  async fetchLiveStats(match: Match, context: MatchContext): Promise<ProviderResult | null> {
    // Match hors couverture Grid : inutile de chercher la série à chaque cycle.
    if (match.gridCovered === false) return null;
    const state = await this.fetchSeriesState(match, context);
    if (!state) return null;
    return this.buildResult(match, context, state, { silent: true });
  }

  /** Series state d'un match : seriesId mémorisé (statsPageUrl) ou recherche Central Data. */
  private async fetchSeriesState(
    match: Match,
    context: MatchContext,
  ): Promise<{ seriesId: string; seriesState: GridSeriesState } | null> {
    const apiKey = this.config.get<string>('GRID_API_KEY');
    if (!apiKey) {
      this.logger.warn('GRID_API_KEY absent : pas de stats CS2');
      return null;
    }
    if (!context.teamA || !context.teamB) return null;
    const reference = match.beginAt ?? match.scheduledAt;
    if (!reference) return null;

    const seriesId =
      match.statsPageUrl ?? (await this.findSeries(reference, context.teamA, context.teamB));
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
          teams {
            name
            players { name kills deaths killAssistsGiven objectives { type completionCount } }
          }
          games { sequenceNumber started finished map { name } teams { name score } }
        }
      }`,
      { id: seriesId },
    );
    if (!state?.seriesState) return null;
    return { seriesId, seriesState: state.seriesState };
  }

  private buildResult(
    match: Match,
    context: MatchContext,
    { seriesId, seriesState }: { seriesId: string; seriesState: GridSeriesState },
    { silent }: { silent: boolean },
  ): ProviderResult | null {
    if (!context.teamA || !context.teamB) return null;
    const lines = mapGridSeriesState(seriesState, context.teamA, context.teamB);
    if (lines.length === 0) {
      if (!silent) this.logger.warn(`Grid : aucune ligne de stats pour le match ${match.id}`);
      return null;
    }
    return {
      lines,
      games: mapGridGames(seriesState, context.teamA, context.teamB),
      // Mémorisé dans match.statsPageUrl : les fetchs suivants (live 3 min,
      // retries post-match) sautent la recherche Central Data.
      pageUrl: seriesId,
    };
  }

  /**
   * Id de la série Grid correspondant à un match : séries CS2 uniquement
   * (titleIds), fenêtre ±12h, paginé — une fenêtre trop large tous jeux
   * confondus déborde du `first: 50` et fait rater la rencontre. Null si
   * Grid ne la référence pas — sert aussi à marquer la couverture CS2.
   *
   * Si une seule des deux équipes est reconnue, corrélation par l'adversaire :
   * le nom inconnu de l'affiche la plus proche du coup d'envoi (± 2h, candidat
   * unique) est appris comme alias de l'équipe locale adverse.
   */
  async findSeries(reference: Date, teamA: Team, teamB: Team): Promise<string | null> {
    const apiKey = this.config.get<string>('GRID_API_KEY');
    if (!apiKey) return null;
    const gte = new Date(reference.getTime() - 12 * 3600 * 1000).toISOString();
    const lte = new Date(reference.getTime() + 12 * 3600 * 1000).toISOString();

    const pairs: Array<OpponentPair & { seriesId: string }> = [];
    let after: string | null = null;
    for (let page = 0; page < SERIES_MAX_PAGES; page += 1) {
      const connection = await this.fetchSeriesPage(apiKey, gte, lte, after);
      for (const edge of connection?.edges ?? []) {
        const names = (edge.node?.teams ?? []).map((team) => team.baseInfo?.name ?? '');
        if (names.length < 2 || !edge.node?.id) continue;
        const matches =
          (teamMatches(names[0], teamA) && teamMatches(names[1], teamB)) ||
          (teamMatches(names[0], teamB) && teamMatches(names[1], teamA));
        if (matches) {
          return edge.node.id;
        }
        const startMs = edge.node.startTimeScheduled
          ? Date.parse(edge.node.startTimeScheduled)
          : NaN;
        pairs.push({
          seriesId: edge.node.id,
          nameA: names[0],
          nameB: names[1],
          deltaMs: Number.isNaN(startMs) ? null : startMs - reference.getTime(),
        });
      }
      if (!connection?.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) break;
      after = connection.pageInfo.endCursor;
    }

    const inferred = inferOpponentAlias(pairs, teamA, teamB, ALIAS_MAX_DELTA_MS);
    if (!inferred) return null;
    const target = inferred.team === 'A' ? teamA : teamB;
    await this.learnAlias(target, inferred.alias);
    const learned = pairs.find(
      (pair) => pair.nameA === inferred.alias || pair.nameB === inferred.alias,
    );
    return learned?.seriesId ?? null;
  }

  /** Persiste un alias appris et met à jour l'objet en mémoire (contexte du fetch en cours). */
  private async learnAlias(team: Team, alias: string): Promise<void> {
    await this.prisma.team.update({
      where: { id: team.id },
      data: { aliases: { push: alias } },
    });
    team.aliases = [...(team.aliases ?? []), alias];
    this.logger.log(`Alias appris via Grid : « ${alias} » → ${team.name}`);
  }

  private async fetchSeriesPage(
    apiKey: string,
    gte: string,
    lte: string,
    after: string | null,
  ): Promise<GridSeriesConnection | null> {
    const data = await this.graphql<{ allSeries?: GridSeriesConnection }>(
      CENTRAL_DATA_URL,
      apiKey,
      `query ($gte: String, $lte: String, $first: Int, $after: Cursor) {
        allSeries(
          first: $first
          after: $after
          filter: {
            titleIds: { in: ["${CS2_TITLE_ID}"] }
            startTimeScheduled: { gte: $gte, lte: $lte }
          }
          orderBy: StartTimeScheduled
        ) {
          pageInfo { hasNextPage endCursor }
          edges { node { id startTimeScheduled teams { baseInfo { name } } } }
        }
      }`,
      { gte, lte, first: SERIES_PAGE_SIZE, after },
    );
    return data?.allSeries ?? null;
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
