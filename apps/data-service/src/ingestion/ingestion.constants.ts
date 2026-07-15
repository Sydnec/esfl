import type { Queue } from 'bullmq';

/** Constantes partagées entre service, processor, scheduler et controller
 * (fichier dédié pour éviter les imports circulaires). */
export const INGESTION_QUEUE = 'data-ingestion';

/**
 * Horizon (en jours) du rattrapage `retry-stats-backfill` : au-delà, on renonce
 * à ré-armer l'ingestion d'un match resté sans stats. Couvre les sources
 * publiées tardivement (Grid enregistre parfois un tournoi après la fenêtre de
 * 48h ; uploads RL/ballchasing communautaires souvent en retard) tout en
 * bornant le nombre de matchs re-sondés à chaque cycle. Surcharge : env
 * `STATS_BACKFILL_DAYS`. */
export const STATS_BACKFILL_DAYS = 14;

/** Un seul jobId par match, partagé par tous les producteurs (sync auto +
 * endpoint admin) pour que BullMQ déduplique les chaînes de retries.
 * BullMQ ≥ 5.58.7 interdit `:` dans les jobId personnalisés. */
export function ingestStatsJobId(matchId: string): string {
  return `ingest-stats-${matchId}`;
}

/**
 * Enqueue un job ingest-stats dédupliqué par match. Une chaîne de retries
 * encore vivante (attente, backoff, en cours) n'est pas doublée — les sources
 * externes sont rate-limitées. En revanche un job terminé ou en échec définitif
 * occupe toujours son jobId dans BullMQ et rendrait l'add silencieusement
 * inopérant : on le purge pour que le re-déclenchement reparte réellement.
 *
 * `restart` (relance manuelle admin) : on retire aussi un job en attente ou en
 * backoff (`delayed`/`waiting`) pour repartir tout de suite au lieu d'attendre
 * sa prochaine tentative — jamais un job `active` (en cours d'exécution).
 * Sans lui, une relance pendant un backoff serait un no-op silencieux.
 */
export async function enqueueIngestStats(
  queue: Queue,
  matchId: string,
  force = false,
  restart = false,
): Promise<void> {
  const jobId = ingestStatsJobId(matchId);
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'completed' || state === 'failed' || (restart && state !== 'active')) {
      await existing.remove();
    }
  }
  await queue.add(
    'ingest-stats',
    { matchId, force },
    {
      jobId,
      // Les sources externes publient parfois avec des heures de retard :
      // retries espacés de 15 min → ~31h de couverture.
      attempts: 8,
      backoff: { type: 'exponential', delay: 15 * 60 * 1000 },
      removeOnComplete: true,
      removeOnFail: 1000,
    },
  );
}

export type IngestionJobName =
  | 'sync-series'
  | 'sync-matches'
  | 'sync-rosters'
  | 'sync-live'
  | 'sync-competition'
  | 'ingest-stats'
  | 'check-grid-coverage'
  | 'sync-live-stats'
  | 'retry-stats-backfill'
  | 'backfill-history';
