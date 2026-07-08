import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QUEUES } from '@esfl/contracts';
import { PandascoreClient } from '../pandascore/pandascore.client';
import { PrismaService } from '../prisma.service';
import {
  GridStatsProvider,
  LeaguepediaStatsProvider,
  OctaneStatsProvider,
  StatsIngestionService,
  VlrStatsProvider,
} from '../stats/stats-ingestion';
import { INGESTION_QUEUE, IngestionProcessor } from './ingestion.processor';
import { IngestionScheduler } from './ingestion.scheduler';
import { IngestionService } from './ingestion.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: INGESTION_QUEUE }),
    BullModule.registerQueue({ name: QUEUES.MATCH_FINISHED }),
    BullModule.registerQueue({ name: QUEUES.STATS_INGESTED }),
  ],
  providers: [
    PrismaService,
    PandascoreClient,
    IngestionService,
    IngestionProcessor,
    IngestionScheduler,
    StatsIngestionService,
    GridStatsProvider,
    VlrStatsProvider,
    LeaguepediaStatsProvider,
    OctaneStatsProvider,
  ],
  exports: [IngestionService, BullModule],
})
export class IngestionModule {}
