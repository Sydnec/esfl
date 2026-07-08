import { z } from 'zod';
import { GAME_IDS } from './games';

/** Noms des queues BullMQ partagées entre services. */
export const QUEUES = {
  /** data-service → scoring-service : un match suivi est terminé. */
  MATCH_FINISHED: 'match.finished',
  /** data-service → scoring-service : les stats détaillées d'un match sont disponibles. */
  STATS_INGESTED: 'stats.ingested',
} as const;

export const matchFinishedEventSchema = z.object({
  matchId: z.string(),
  gameId: z.enum(GAME_IDS),
  competitionId: z.string(),
  finishedAt: z.iso.datetime(),
});
export type MatchFinishedEvent = z.infer<typeof matchFinishedEventSchema>;

export const statsIngestedEventSchema = z.object({
  matchId: z.string(),
  gameId: z.enum(GAME_IDS),
  /** Provider ayant fourni les stats (grid, vlr, leaguepedia, octane, pandascore). */
  source: z.string(),
  ingestedAt: z.iso.datetime(),
});
export type StatsIngestedEvent = z.infer<typeof statsIngestedEventSchema>;
