/** Constantes partagées entre service, processor, scheduler et controller
 * (fichier dédié pour éviter les imports circulaires). */
export const INGESTION_QUEUE = 'data-ingestion';

export type IngestionJobName =
  | 'sync-series'
  | 'sync-matches'
  | 'sync-rosters'
  | 'sync-live'
  | 'sync-competition'
  | 'ingest-stats';
