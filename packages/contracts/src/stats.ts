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
  /** Average damage per round — indisponible via Grid open access, null. */
  adr: z.number().nullable(),
  /** Rating HLTV-like si disponible — indisponible via Grid open access, null. */
  rating: z.number().nullable(),
  /** Bombes posées (objectives Grid). Optionnel : absent des ingestions antérieures. */
  plants: z.number().nullable().optional(),
  /** Bombes défusées (objectives Grid). */
  defuses: z.number().nullable().optional(),
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
 * scoring). Valorant : agent + stats de la map ; LoL : champion + stats de
 * la game (map null). Position alignée sur match.gamesSummary.
 */
export const mapStatsEntrySchema = z.object({
  position: z.number(),
  map: z.string().nullable(),
  agent: z.string().nullable(),
  /** URL absolue de l'icône d'agent/champion (source provider). */
  agentImage: z.string().nullable(),
  /** Null tant que la source ne publie pas la manche (map en cours). */
  kills: z.number().nullable(),
  deaths: z.number().nullable(),
  assists: z.number().nullable(),
  acs: z.number().nullable().optional(),
  firstKills: z.number().nullable().optional(),
  csPerMin: z.number().nullable().optional(),
  win: z.boolean().nullable().optional(),
});
export type MapStatsEntry = z.infer<typeof mapStatsEntrySchema>;

export const statsSchemasByGame = {
  cs2: cs2StatsSchema,
  valorant: valorantStatsSchema,
  lol: lolStatsSchema,
  rl: rlStatsSchema,
} satisfies Record<GameId, z.ZodType>;

export type NormalizedStats = Cs2Stats | ValorantStats | LolStats | RlStats;
