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

/**
 * Détail d'un joueur sur une manche (player_match_stats.perMap, hors
 * scoring). Valorant : agent + stats de la map ; position alignée sur
 * match.gamesSummary.
 */
export const mapStatsEntrySchema = z.object({
  position: z.number(),
  map: z.string().nullable(),
  agent: z.string().nullable(),
  /** URL absolue de l'icône d'agent (source provider). */
  agentImage: z.string().nullable(),
  kills: z.number(),
  deaths: z.number(),
  assists: z.number(),
  acs: z.number().nullable(),
  firstKills: z.number().nullable(),
});
export type MapStatsEntry = z.infer<typeof mapStatsEntrySchema>;

export const statsSchemasByGame = {
  cs2: cs2StatsSchema,
  valorant: valorantStatsSchema,
  lol: lolStatsSchema,
  rl: rlStatsSchema,
} satisfies Record<GameId, z.ZodType>;

export type NormalizedStats = Cs2Stats | ValorantStats | LolStats | RlStats;
