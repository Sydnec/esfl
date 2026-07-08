import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QUEUES } from '@esfl/contracts';
import { PandascoreClient } from '../pandascore/pandascore.client';
import { PrismaService } from '../prisma.service';
import { INGESTION_QUEUE, IngestionProcessor } from './ingestion.processor';
import { IngestionScheduler } from './ingestion.scheduler';
import { IngestionService } from './ingestion.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: INGESTION_QUEUE }),
    BullModule.registerQueue({ name: QUEUES.MATCH_FINISHED }),
  ],
  providers: [
    PrismaService,
    PandascoreClient,
    IngestionService,
    IngestionProcessor,
    IngestionScheduler,
  ],
  exports: [IngestionService, BullModule],
})
export class IngestionModule {}
