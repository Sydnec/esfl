import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { IngestionService } from './ingestion.service';

export const INGESTION_QUEUE = 'data-ingestion';

export type IngestionJobName = 'sync-series' | 'sync-matches' | 'sync-rosters';

@Processor(INGESTION_QUEUE)
export class IngestionProcessor extends WorkerHost {
  private readonly logger = new Logger(IngestionProcessor.name);

  constructor(private readonly ingestion: IngestionService) {
    super();
  }

  async process(job: Job): Promise<void> {
    this.logger.log(`Job ${job.name} démarré`);
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
      default:
        this.logger.warn(`Job inconnu : ${job.name}`);
    }
  }
}
