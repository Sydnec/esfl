import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { StatsIngestionService } from '../stats/stats-ingestion';
import { INGESTION_QUEUE, IngestionJobName } from './ingestion.constants';
import { IngestionService } from './ingestion.service';

export { INGESTION_QUEUE };
export type { IngestionJobName };

@Processor(INGESTION_QUEUE)
export class IngestionProcessor extends WorkerHost {
  private readonly logger = new Logger(IngestionProcessor.name);

  constructor(
    private readonly ingestion: IngestionService,
    private readonly statsIngestion: StatsIngestionService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    this.logger.log(`Job ${job.name} démarré${job.attemptsMade ? ` (tentative ${job.attemptsMade + 1})` : ''}`);
    switch (job.name as IngestionJobName) {
      case 'sync-series':
        await this.ingestion.syncSeries();
        break;
      case 'sync-matches':
        await this.ingestion.syncAllActiveMatches();
        break;
      case 'sync-rosters':
        await this.ingestion.syncAllActiveRosters();
        break;
      case 'sync-live':
        await this.ingestion.syncLiveWindow();
        break;
      case 'sync-competition':
        await this.ingestion.syncCompetition((job.data as { competitionId: string }).competitionId);
        break;
      case 'check-grid-coverage':
        await this.statsIngestion.checkGridCoverage();
        break;
      case 'ingest-stats': {
        // Throw si les stats ne sont pas encore publiées → retry BullMQ (backoff).
        const data = job.data as { matchId: string; force?: boolean };
        await this.statsIngestion.ingestForMatchId(data.matchId, data.force ?? false);
        break;
      }
      default:
        this.logger.warn(`Job inconnu : ${job.name}`);
    }
  }
}
