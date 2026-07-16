import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QUEUES } from '@esfl/contracts';
import { DataClient } from '../clients/data.client';
import { FantasyClient } from '../clients/fantasy.client';
import { PrismaService } from '../prisma.service';
import {
  SCORING_MAINTENANCE_QUEUE,
  ScoringMaintenanceProcessor,
  ScoringMaintenanceScheduler,
} from './maintenance';
import { ScoringController } from './scoring.controller';
import { StatsIngestedProcessor } from './scoring.processor';
import { ScoringService } from './scoring.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUES.STATS_INGESTED }),
    BullModule.registerQueue({ name: SCORING_MAINTENANCE_QUEUE }),
  ],
  controllers: [ScoringController],
  providers: [
    PrismaService,
    DataClient,
    FantasyClient,
    ScoringService,
    StatsIngestedProcessor,
    ScoringMaintenanceScheduler,
    ScoringMaintenanceProcessor,
  ],
})
export class ScoringModule {}
