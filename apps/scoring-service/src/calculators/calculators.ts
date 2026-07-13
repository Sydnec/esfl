import {
  Cs2Stats,
  cs2StatsSchema,
  GameId,
  LolStats,
  lolStatsSchema,
  RlStats,
  rlStatsSchema,
  ValorantStats,
  valorantStatsSchema,
} from '@esfl/contracts';

/**
 * Formules v3 : les compteurs (kills, buts…) sont ramenés à une moyenne par
 * map avant barème, pour qu'une bonne performance vaille ~20-35 points quel
 * que soit le format (Bo1, Bo3, Bo5) et le jeu. Les taux déjà moyennés sur le
 * match (adr, acs, csPerMin) et les bonus de match (win) ne sont pas divisés.
 * Versionnées : tout changement doit passer par une nouvelle version pour
 * permettre un recalcul cohérent.
 *
 * v3 : CS2 enrichi au-delà du K/A/D — l'ADR étant absent de Grid open-access,
 * on valorise les manches ouvertes (firstKills) et les objectifs
 * (plants/defuses), seules données réellement disponibles.
 */
export const SCORING_VERSION = 'v3';

export interface ScoreResult {
  points: number;
  breakdown: Record<string, number>;
}

/** Sous-ensemble du match nécessaire au comptage des maps jouées. */
export interface MatchMapsInfo {
  gamesSummary?: Array<{ position: number; winner: 'A' | 'B' | null }> | null;
  scoreA?: number | null;
  scoreB?: number | null;
}

/**
 * Nombre de maps jouées : manches décidées de gamesSummary (winner non nul,
 * les manches en cours restent à null), sinon scoreA+scoreB (seed et anciens
 * matchs sans détail des manches), sinon 1.
 */
export function mapsPlayed(match: MatchMapsInfo): number {
  const decided = (match.gamesSummary ?? []).filter((game) => game.winner != null).length;
  if (decided > 0) return decided;
  const fromScore = (match.scoreA ?? 0) + (match.scoreB ?? 0);
  return fromScore > 0 ? fromScore : 1;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function scoreCs2(stats: Cs2Stats, maps: number): ScoreResult {
  const breakdown = {
    kills: (stats.kills / maps) * 2,
    assists: (stats.assists / maps) * 1,
    deaths: -(stats.deaths / maps),
    // ADR indisponible via Grid open-access (0 en pratique) ; conservé pour
    // le jour où une source le fournit.
    adr: (stats.adr ?? 0) * 0.05,
    // Manches ouvertes : forte valeur d'impact, comme les first kills Valorant.
    firstKills: ((stats.firstKills ?? 0) / maps) * 1.5,
    // Objectifs : contribution modérée au-delà du fragging pur.
    plants: ((stats.plants ?? 0) / maps) * 0.5,
    defuses: ((stats.defuses ?? 0) / maps) * 0.5,
  };
  return finalize(breakdown);
}

export function scoreValorant(stats: ValorantStats, maps: number): ScoreResult {
  const breakdown = {
    kills: (stats.kills / maps) * 1.5,
    assists: (stats.assists / maps) * 0.8,
    deaths: -(stats.deaths / maps),
    acs: (stats.acs ?? 0) * 0.05,
    firstKills: ((stats.firstKills ?? 0) / maps) * 1.5,
  };
  return finalize(breakdown);
}

export function scoreLol(stats: LolStats, maps: number): ScoreResult {
  const breakdown = {
    kills: (stats.kills / maps) * 3,
    assists: (stats.assists / maps) * 1.5,
    deaths: -(stats.deaths / maps) * 2,
    csPerMin: (stats.csPerMin ?? 0) * 1,
    win: stats.win ? 5 : 0,
  };
  return finalize(breakdown);
}

export function scoreRl(stats: RlStats, maps: number): ScoreResult {
  const breakdown = {
    goals: (stats.goals / maps) * 8,
    assists: (stats.assists / maps) * 5,
    saves: (stats.saves / maps) * 4,
    shots: (stats.shots / maps) * 1,
    score: ((stats.score ?? 0) / maps) * 0.01,
  };
  return finalize(breakdown);
}

function finalize(breakdown: Record<string, number>): ScoreResult {
  const rounded = Object.fromEntries(
    Object.entries(breakdown).map(([key, value]) => [key, round(value)]),
  );
  return {
    points: round(Object.values(rounded).reduce((sum, value) => sum + value, 0)),
    breakdown: rounded,
  };
}

/** Valide les stats normalisées puis applique la formule du jeu. Null si invalide. */
export function computeScore(gameId: GameId, normalized: unknown, maps: number): ScoreResult | null {
  switch (gameId) {
    case 'cs2': {
      const parsed = cs2StatsSchema.safeParse(normalized);
      return parsed.success ? scoreCs2(parsed.data, maps) : null;
    }
    case 'valorant': {
      const parsed = valorantStatsSchema.safeParse(normalized);
      return parsed.success ? scoreValorant(parsed.data, maps) : null;
    }
    case 'lol': {
      const parsed = lolStatsSchema.safeParse(normalized);
      return parsed.success ? scoreLol(parsed.data, maps) : null;
    }
    case 'rl': {
      const parsed = rlStatsSchema.safeParse(normalized);
      return parsed.success ? scoreRl(parsed.data, maps) : null;
    }
    default:
      return null;
  }
}
