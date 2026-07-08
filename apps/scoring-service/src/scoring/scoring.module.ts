import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QUEUES } from '@esfl/contracts';
import { DataClient } from '../clients/data.client';
import { FantasyClient } from '../clients/fantasy.client';
import { PrismaService } from '../prisma.service';
import { ScoringController } from './scoring.controller';
import { StatsIngestedProcessor } from './scoring.processor';
import { ScoringService } from './scoring.service';

@Module({
  imports: [BullModule.registerQueue({ name: QUEUES.STATS_INGESTED })],
  controllers: [ScoringController],
  providers: [PrismaService, DataClient, FantasyClient, ScoringService, StatsIngestedProcessor],
})
export class ScoringModule {}
