import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QUEUES } from '@esfl/contracts';
import { FantasyClient } from '../fantasy-client/fantasy.client';
import { LiveModule } from '../live/live.module';
import { PandascoreClient } from '../pandascore/pandascore.client';
import { PrismaService } from '../prisma.service';
import { Bo3StatsProvider } from '../stats/bo3.provider';
import { LeaguepediaStatsProvider } from '../stats/leaguepedia.provider';
import { StatsIngestionService } from '../stats/stats-ingestion';
import { VlrStatsProvider } from '../stats/vlr.provider';
import { INGESTION_QUEUE } from './ingestion.constants';
import { IngestionProcessor } from './ingestion.processor';
import { IngestionScheduler } from './ingestion.scheduler';
import { IngestionService } from './ingestion.service';
import { PlayerAdoptionService } from './player-adoption.service';
import { TeamEnrichmentService } from './team-enrichment.service';

@Module({
  imports: [
    LiveModule,
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
    TeamEnrichmentService,
    PlayerAdoptionService,
    StatsIngestionService,
    Bo3StatsProvider,
    VlrStatsProvider,
    LeaguepediaStatsProvider,
  ],
  exports: [
    IngestionService,
    StatsIngestionService,
    TeamEnrichmentService,
    PlayerAdoptionService,
    PandascoreClient,
    FantasyClient,
    BullModule,
  ],
})
export class IngestionModule {}
