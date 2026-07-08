import { z } from 'zod';
import type { GameId } from './games';

/**
 * Stats normalisées par jeu, stockées dans player_match_stats.normalized
 * et consommées par les calculateurs de points du scoring-service.
 */
export const cs2StatsSchema = z.object({
  kills: z.number(),
  deaths: z.number(),
  assists: z.number(),
  /** Average damage per round. */
  adr: z.number().nullable(),
  /** Rating HLTV-like si disponible. */
  rating: z.number().nullable(),
});
export type Cs2Stats = z.infer<typeof cs2StatsSchema>;

export const valorantStatsSchema = z.object({
  kills: z.number(),
  deaths: z.number(),
  assists: z.number(),
  /** Average combat score. */
  acs: z.number().nullable(),
  firstKills: z.number().nullable(),
});
export type ValorantStats = z.infer<typeof valorantStatsSchema>;

export const lolStatsSchema = z.object({
  kills: z.number(),
  deaths: z.number(),
  assists: z.number(),
  csPerMin: z.number().nullable(),
  win: z.boolean(),
});
export type LolStats = z.infer<typeof lolStatsSchema>;

export const rlStatsSchema = z.object({
  goals: z.number(),
  assists: z.number(),
  saves: z.number(),
  shots: z.number(),
  /** Score in-game Rocket League. */
  score: z.number().nullable(),
});
export type RlStats = z.infer<typeof rlStatsSchema>;

export const statsSchemasByGame = {
  cs2: cs2StatsSchema,
  valorant: valorantStatsSchema,
  lol: lolStatsSchema,
  rl: rlStatsSchema,
} satisfies Record<GameId, z.ZodType>;

export type NormalizedStats = Cs2Stats | ValorantStats | LolStats | RlStats;
