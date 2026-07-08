import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  AddCompetitionInput,
  addCompetitionInputSchema,
  CreateLeagueInput,
  createLeagueInputSchema,
  JoinLeagueInput,
  joinLeagueInputSchema,
  SubmitRosterInput,
  submitRosterInputSchema,
} from '@esfl/contracts';
import { UserGuard, UserId } from '../common/user';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RostersService } from '../rosters/rosters.service';
import { LeaguesService } from './leagues.service';

@Controller('fantasy/leagues')
@UseGuards(UserGuard)
export class LeaguesController {
  constructor(
    private readonly leagues: LeaguesService,
    private readonly rosters: RostersService,
  ) {}

  @Post()
  create(
    @UserId() userId: string,
    @Body(new ZodValidationPipe(createLeagueInputSchema)) body: CreateLeagueInput,
  ) {
    return this.leagues.create(userId, body);
  }

  @Get()
  mine(@UserId() userId: string) {
    return this.leagues.myLeagues(userId);
  }

  @Post('join')
  join(
    @UserId() userId: string,
    @Body(new ZodValidationPipe(joinLeagueInputSchema)) body: JoinLeagueInput,
  ) {
    return this.leagues.join(body.inviteCode, userId);
  }

  @Get(':id')
  detail(@UserId() userId: string, @Param('id') id: string) {
    return this.leagues.getForMember(id, userId);
  }

  @Post(':id/competitions')
  addCompetition(
    @UserId() userId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(addCompetitionInputSchema)) body: AddCompetitionInput,
  ) {
    return this.leagues.addCompetition(id, userId, body.competitionId);
  }

  @Get(':id/matchdays')
  matchDays(@UserId() userId: string, @Param('id') id: string) {
    return this.rosters.listMatchDays(id, userId);
  }

  @Get(':id/matchdays/:dayId/board')
  board(@UserId() userId: string, @Param('id') id: string, @Param('dayId') dayId: string) {
    return this.rosters.getPickBoard(id, dayId, userId);
  }

  @Put(':id/matchdays/:dayId/roster')
  submitRoster(
    @UserId() userId: string,
    @Param('id') id: string,
    @Param('dayId') dayId: string,
    @Body(new ZodValidationPipe(submitRosterInputSchema)) body: SubmitRosterInput,
  ) {
    return this.rosters.submitRoster(id, dayId, userId, body.playerIds);
  }
}

/** Endpoints internes (réseau privé) consommés par les autres services. */
@Controller('fantasy/internal')
export class InternalController {
  constructor(
    private readonly rosters: RostersService,
    private readonly leagues: LeaguesService,
  ) {}

  @Get('rosters')
  rostersForDate(@Query('date') date: string) {
    return this.rosters.listRostersForDate(date);
  }

  /** Compétitions suivies par au moins une ligue (ciblage de l'ingestion). */
  @Get('followed-competitions')
  followedCompetitions() {
    return this.leagues.followedCompetitionIds();
  }
}
