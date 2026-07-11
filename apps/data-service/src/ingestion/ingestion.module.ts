import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QUEUES } from '@esfl/contracts';
import { FantasyClient } from '../fantasy-client/fantasy.client';
import { PandascoreClient } from '../pandascore/pandascore.client';
import { PrismaService } from '../prisma.service';
import { BallchasingStatsProvider } from '../stats/ballchasing.provider';
import { GridStatsProvider } from '../stats/grid.provider';
import { LeaguepediaStatsProvider } from '../stats/leaguepedia.provider';
import { StatsIngestionService } from '../stats/stats-ingestion';
import { VlrStatsProvider } from '../stats/vlr.provider';
import { INGESTION_QUEUE } from './ingestion.constants';
import { IngestionProcessor } from './ingestion.processor';
import { IngestionScheduler } from './ingestion.scheduler';
import { IngestionService } from './ingestion.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: INGESTION_QUEUE }),
    BullModule.registerQueue({ name: QUEUES.STATS_INGESTED }),
  ],
  providers: [
    PrismaService,
    PandascoreClient,
    FantasyClient,
    IngestionService,
    IngestionProcessor,
    IngestionScheduler,
    StatsIngestionService,
    GridStatsProvider,
    VlrStatsProvider,
    LeaguepediaStatsProvider,
    BallchasingStatsProvider,
  ],
  exports: [IngestionService, BullModule],
})
export class IngestionModule {}
