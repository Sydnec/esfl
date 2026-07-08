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
 * Formules v1, calibrées pour qu'une bonne performance vaille ~20-35 points
 * quel que soit le jeu. Versionnées : tout changement doit passer par une v2
 * pour permettre un recalcul cohérent.
 */
export const SCORING_VERSION = 'v1';

export interface ScoreResult {
  points: number;
  breakdown: Record<string, number>;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function scoreCs2(stats: Cs2Stats): ScoreResult {
  const breakdown = {
    kills: stats.kills * 2,
    assists: stats.assists * 1,
    deaths: -stats.deaths,
    adr: (stats.adr ?? 0) * 0.05,
  };
  return finalize(breakdown);
}

export function scoreValorant(stats: ValorantStats): ScoreResult {
  const breakdown = {
    kills: stats.kills * 1.5,
    assists: stats.assists * 0.8,
    deaths: -stats.deaths,
    acs: (stats.acs ?? 0) * 0.05,
    firstKills: (stats.firstKills ?? 0) * 1.5,
  };
  return finalize(breakdown);
}

export function scoreLol(stats: LolStats): ScoreResult {
  const breakdown = {
    kills: stats.kills * 3,
    assists: stats.assists * 1.5,
    deaths: -stats.deaths * 2,
    csPerMin: (stats.csPerMin ?? 0) * 1,
    win: stats.win ? 5 : 0,
  };
  return finalize(breakdown);
}

export function scoreRl(stats: RlStats): ScoreResult {
  const breakdown = {
    goals: stats.goals * 8,
    assists: stats.assists * 5,
    saves: stats.saves * 4,
    shots: stats.shots * 1,
    score: (stats.score ?? 0) * 0.01,
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
export function computeScore(gameId: GameId, normalized: unknown): ScoreResult | null {
  switch (gameId) {
    case 'cs2': {
      const parsed = cs2StatsSchema.safeParse(normalized);
      return parsed.success ? scoreCs2(parsed.data) : null;
    }
    case 'valorant': {
      const parsed = valorantStatsSchema.safeParse(normalized);
      return parsed.success ? scoreValorant(parsed.data) : null;
    }
    case 'lol': {
      const parsed = lolStatsSchema.safeParse(normalized);
      return parsed.success ? scoreLol(parsed.data) : null;
    }
    case 'rl': {
      const parsed = rlStatsSchema.safeParse(normalized);
      return parsed.success ? scoreRl(parsed.data) : null;
    }
    default:
      return null;
  }
}
