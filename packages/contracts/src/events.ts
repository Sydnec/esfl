import { z } from 'zod';
import { GAME_IDS } from './games';

/** Noms des queues BullMQ partagées entre services. */
export const QUEUES = {
  /** data-service → scoring-service : les stats détaillées d'un match sont disponibles. */
  STATS_INGESTED: 'stats.ingested',
} as const;

export const statsIngestedEventSchema = z.object({
  matchId: z.string(),
  gameId: z.enum(GAME_IDS),
  /** Provider ayant fourni les stats (bo3, vlr, leaguepedia, pandascore). */
  source: z.string(),
  ingestedAt: z.iso.datetime(),
});
export type StatsIngestedEvent = z.infer<typeof statsIngestedEventSchema>;
