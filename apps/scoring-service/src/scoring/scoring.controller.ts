import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { FantasyClient } from '../clients/fantasy.client';
import { ScoringService } from './scoring.service';

function userIdFrom(req: Request): string {
  const userId = req.headers['x-user-id'];
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new UnauthorizedException('Authentification requise');
  }
  return userId;
}

@Controller('scoring')
export class ScoringController {
  constructor(
    private readonly scoring: ScoringService,
    private readonly fantasy: FantasyClient,
  ) {}

  @Get('leagues/:id/leaderboard')
  async leaderboard(@Param('id') leagueId: string, @Req() req: Request) {
    await this.assertMember(leagueId, userIdFrom(req));
    return this.scoring.leaderboard(leagueId);
  }

  @Get('leagues/:id/days/:date')
  async dayScores(@Param('id') leagueId: string, @Param('date') date: string, @Req() req: Request) {
    await this.assertMember(leagueId, userIdFrom(req));
    return this.scoring.dayScores(leagueId, date);
  }

  @Get('players')
  playerPoints(@Query('playerIds') playerIds?: string) {
    return this.scoring.playerPoints(playerIds ? playerIds.split(',').filter(Boolean) : []);
  }

  /** Recalcul manuel d'un match (admin/dev, aussi utilisé par le seed E2E). */
  @Post('recompute/:matchId')
  recompute(@Param('matchId') matchId: string) {
    return this.scoring.computeForMatch(matchId);
  }

  private async assertMember(leagueId: string, userId: string) {
    if (!(await this.fantasy.isMember(leagueId, userId))) {
      throw new ForbiddenException('Tu n’es pas membre de cette ligue');
    }
  }
}
