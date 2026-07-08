import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { QUEUES, statsIngestedEventSchema } from '@esfl/contracts';
import { Job } from 'bullmq';
import { ScoringService } from './scoring.service';

/** Consomme stats.ingested (publié par data-service) et note le match. */
@Processor(QUEUES.STATS_INGESTED)
export class StatsIngestedProcessor extends WorkerHost {
  private readonly logger = new Logger(StatsIngestedProcessor.name);

  constructor(private readonly scoring: ScoringService) {
    super();
  }

  async process(job: Job): Promise<void> {
    const parsed = statsIngestedEventSchema.safeParse(job.data);
    if (!parsed.success) {
      this.logger.warn(`Événement stats.ingested invalide : ${JSON.stringify(job.data)}`);
      return;
    }
    await this.scoring.computeForMatch(parsed.data.matchId);
  }
}
