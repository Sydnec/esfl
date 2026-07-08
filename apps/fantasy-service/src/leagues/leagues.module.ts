import { Module } from '@nestjs/common';
import { DataClient } from '../data-client/data.client';
import { PrismaService } from '../prisma.service';
import { RostersService } from '../rosters/rosters.service';
import { InternalController, LeaguesController } from './leagues.controller';
import { LeaguesService } from './leagues.service';

@Module({
  controllers: [LeaguesController, InternalController],
  providers: [PrismaService, DataClient, LeaguesService, RostersService],
})
export class LeaguesModule {}
