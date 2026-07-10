import type { GameId } from '@esfl/contracts';
import type { Match, Player, Prisma, Team } from '../../generated/client';

/** Contexte de rapprochement fourni aux providers : équipes et rosters locaux. */
export interface MatchContext {
  teamA: Team | null;
  teamB: Team | null;
  /** Joueurs locaux des deux équipes (référentiel Pandascore). */
  players: Player[];
}

/** Ligne de stats retournée par un provider, indexée sur nos ids internes. */
export interface ProviderStatLine {
  playerId: string;
  raw: Prisma.InputJsonValue;
  normalized: Prisma.InputJsonValue;
  /** Détail par manche (MapStatsEntry[]) quand la source le fournit. */
  perMap?: Prisma.InputJsonValue | null;
}

/** Détail d'une manche quand la source le connaît (map, score par équipe). */
export interface ProviderGameInfo {
  position: number;
  map?: string | null;
  scoreA?: number | null;
  scoreB?: number | null;
}

export interface ProviderResult {
  lines: ProviderStatLine[];
  /** Enrichissement des manches (fusionné dans match.gamesSummary). */
  games?: ProviderGameInfo[];
}

/**
 * Adapter de stats détaillées par jeu. Contrat : retourner null (ou lever)
 * si les stats ne sont pas encore disponibles, le job ingest-stats retentera
 * avec backoff. Chaque provider utilise politeFetch (1 req/s par hôte).
 */
export interface GameStatsProvider {
  readonly source: string;
  readonly gameId: GameId;
  fetchStats(match: Match, context: MatchContext): Promise<ProviderResult | null>;
}
