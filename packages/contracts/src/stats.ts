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
  /** Rating maison de la source (échelle propre, informatif). */
  rating: z.number().nullable(),
  /** Kill/Assist/Trade/Survive % — implication dans les rounds. */
  kast: z.number().nullable().optional(),
  /** Bombes posées. Optionnel : absent des ingestions antérieures et de bo3. */
  plants: z.number().nullable().optional(),
  /** Bombes défusées. */
  defuses: z.number().nullable().optional(),
  /** Manches ouvertes (first kills). */
  firstKills: z.number().nullable().optional(),
  /** Morts d'entrée — pendant négatif des first kills. */
  firstDeaths: z.number().nullable().optional(),
  /** Manches multi-kills (2K+3K+4K+5K). */
  multiKills: z.number().nullable().optional(),
  /** Clutchs gagnés (1v1+…+1v5). */
  clutches: z.number().nullable().optional(),
  /** Kills à la tête (nombre, pas un pourcentage). */
  headshots: z.number().nullable().optional(),
});
export type Cs2Stats = z.infer<typeof cs2StatsSchema>;

export const valorantStatsSchema = z.object({
  kills: z.number(),
  deaths: z.number(),
  assists: z.number(),
  /** Average combat score. */
  acs: z.number().nullable(),
  firstKills: z.number().nullable(),
  /** Rating VLR 2.0 (métrique composite). Optionnel : absent des ingestions antérieures. */
  rating: z.number().nullable().optional(),
  /** Kill/Assist/Trade/Survive % — implication dans les rounds. */
  kast: z.number().nullable().optional(),
  /** Average damage per round. */
  adr: z.number().nullable().optional(),
  /** Pourcentage de headshots. */
  hsPercent: z.number().nullable().optional(),
  /** First deaths (morts d'entrée) — pendant négatif des first kills. */
  firstDeaths: z.number().nullable().optional(),
  /** Manches multi-kills (2K+3K+4K+5K) — onglet Performance VLR. */
  multiKills: z.number().nullable().optional(),
  /** Clutchs gagnés (1v1+…+1v5) — distingue le clutcher. Onglet Performance VLR. */
  clutches: z.number().nullable().optional(),
  /** Bombes posées (PL) — onglet Performance VLR. */
  plants: z.number().nullable().optional(),
  /** Bombes défusées (DE) — onglet Performance VLR. */
  defuses: z.number().nullable().optional(),
  /** Note d'économie VLR (ECON) — efficacité au combat par crédits. */
  econRating: z.number().nullable().optional(),
});
export type ValorantStats = z.infer<typeof valorantStatsSchema>;

export const lolStatsSchema = z.object({
  kills: z.number(),
  deaths: z.number(),
  assists: z.number(),
  csPerMin: z.number().nullable(),
  win: z.boolean(),
  /** Participation aux kills (K+A)/kills équipe, moyenne sur les games. */
  killParticipation: z.number().nullable().optional(),
  /** Part des dégâts aux champions dans l'équipe, moyenne sur les games. */
  damageShare: z.number().nullable().optional(),
  /** Score de vision total (somme sur les games). */
  visionScore: z.number().nullable().optional(),
  /** Part de l'or de l'équipe (gold joueur / gold équipe), moyenne sur les games. */
  goldShare: z.number().nullable().optional(),
  /** Part du score de vision de l'équipe, moyenne sur les games (scoring v5). */
  visionShare: z.number().nullable().optional(),
  /**
   * Part des objectifs neutres (barons, dragons, hérauts, grubs) pris par
   * l'équipe. Métrique collective : identique pour les cinq joueurs d'un côté.
   */
  objControl: z.number().nullable().optional(),
  /**
   * Variantes par minute : une game longue gonfle mécaniquement les compteurs,
   * le scoring utilise ces taux plutôt que les totaux bruts.
   */
  killsPerMin: z.number().nullable().optional(),
  deathsPerMin: z.number().nullable().optional(),
  assistsPerMin: z.number().nullable().optional(),
  visionPerMin: z.number().nullable().optional(),
  /** Durée totale jouée sur le match (minutes, sommée sur les games). */
  durationMinutes: z.number().nullable().optional(),
});
export type LolStats = z.infer<typeof lolStatsSchema>;

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
  /** Détail avancé par manche (VLR) : la vue « Avancé » d'une map précise. */
  adr: z.number().nullable().optional(),
  rating: z.number().nullable().optional(),
  kast: z.number().nullable().optional(),
  hsPercent: z.number().nullable().optional(),
  /** Kills à la tête (nombre) — bo3 les donne par map. */
  headshots: z.number().nullable().optional(),
  firstDeaths: z.number().nullable().optional(),
  /** Onglet Performance VLR, table de la map. */
  multiKills: z.number().nullable().optional(),
  clutches: z.number().nullable().optional(),
  plants: z.number().nullable().optional(),
  defuses: z.number().nullable().optional(),
  econRating: z.number().nullable().optional(),
  /** Détail avancé par game (Leaguepedia) : ratios d'équipe et vision. */
  killParticipation: z.number().nullable().optional(),
  damageShare: z.number().nullable().optional(),
  goldShare: z.number().nullable().optional(),
  visionScore: z.number().nullable().optional(),
});
export type MapStatsEntry = z.infer<typeof mapStatsEntrySchema>;

export const statsSchemasByGame = {
  cs2: cs2StatsSchema,
  valorant: valorantStatsSchema,
  lol: lolStatsSchema,
} satisfies Record<GameId, z.ZodType>;

export type NormalizedStats = Cs2Stats | ValorantStats | LolStats;
