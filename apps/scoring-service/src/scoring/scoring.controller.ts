import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { FantasyClient } from '../clients/fantasy.client';
import { AdminGuard } from '../common/admin.guard';
import { ScoringService } from './scoring.service';

/** Paramètre « a,b,c » → liste d'ids, vides écartés. */
function listeIds(value?: string): string[] {
  return value ? value.split(',').filter(Boolean) : [];
}

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
    await this.memberLeague(leagueId, userIdFrom(req));
    return this.scoring.leaderboard(leagueId);
  }

  @Get('leagues/:id/days/:date')
  async dayScores(@Param('id') leagueId: string, @Param('date') date: string, @Req() req: Request) {
    await this.memberLeague(leagueId, userIdFrom(req));
    return this.scoring.dayScores(leagueId, date);
  }

  /** Meilleures perfs des joueurs pros d'une journée (compétitions de la ligue). */
  @Get('leagues/:id/days/:date/top-players')
  async topPlayers(
    @Param('id') leagueId: string,
    @Param('date') date: string,
    @Req() req: Request,
  ) {
    const league = await this.memberLeague(leagueId, userIdFrom(req));
    return this.scoring.topPlayers(
      league.competitions.map((entry) => entry.competitionId),
      date,
    );
  }

  /** `matchIds` (optionnel) restreint aux notes de ces matchs. */
  @Get('players')
  playerPoints(@Query('playerIds') playerIds?: string, @Query('matchIds') matchIds?: string) {
    return this.scoring.playerPoints(listeIds(playerIds), listeIds(matchIds));
  }

  /** Analytics de santé des points fantasy (page admin). */
  @Get('admin/point-stats')
  @UseGuards(AdminGuard)
  pointStats() {
    return this.scoring.pointStats();
  }

  /** Recalcul manuel d'un match (admin). */
  @Post('recompute/:matchId')
  @UseGuards(AdminGuard)
  recompute(@Param('matchId') matchId: string) {
    return this.scoring.computeForMatch(matchId);
  }

  /** Recalcul complet avec la formule courante (admin, après un changement de version). */
  @Post('admin/recompute-all')
  @UseGuards(AdminGuard)
  recomputeAll() {
    return this.scoring.recomputeAll();
  }

  /**
   * Rattrapage immédiat des matchs terminés ayant des stats mais aucune note
   * (sinon joué toutes les heures) — admin.
   */
  @Post('admin/backfill-scores')
  @UseGuards(AdminGuard)
  backfillScores() {
    return this.scoring.backfillMissingScores();
  }

  /** Bascule : purge tous les scores puis recalcul complet — admin. */
  @Post('admin/reset-scores')
  @UseGuards(AdminGuard)
  resetScores() {
    return this.scoring.resetAndRecompute();
  }

  /** Journées gelées (scoreboard immuable) — admin. */
  @Get('admin/frozen-days')
  @UseGuards(AdminGuard)
  frozenDays() {
    return this.scoring.listFrozenDays();
  }

  /** Gel manuel d'une journée (dernier re-score puis pose du gel) — admin. */
  @Post('admin/freeze/:date')
  @UseGuards(AdminGuard)
  async freezeDay(@Param('date') date: string) {
    await this.scoring.freezeDay(date, 'manual');
    return { frozen: date };
  }

  /** Dégel manuel : l'unique porte de sortie du gel absolu — admin. */
  @Delete('admin/freeze/:date')
  @UseGuards(AdminGuard)
  async unfreezeDay(@Param('date') date: string) {
    await this.scoring.unfreezeDay(date);
    return { unfrozen: date };
  }

  /**
   * Fusion de fiches joueur côté data-service : les notes suivent la fiche
   * gardée. Sans clé étrangère inter-schémas, rien ne le ferait tout seul.
   */
  @Post('internal/players/merged')
  async playersMerged(@Body() body: { keepId?: string; absorbedIds?: string[] }) {
    if (!body?.keepId || !Array.isArray(body.absorbedIds)) {
      throw new BadRequestException('keepId et absorbedIds attendus');
    }
    return { transferees: await this.scoring.reassignPoints(body.keepId, body.absorbedIds) };
  }

  /** Nettoyage à la suppression d'un compte (appel interne). */
  @Delete('internal/users/:userId')
  async removeUser(@Param('userId') userId: string) {
    await this.scoring.removeUserScores(userId);
    return { ok: true };
  }

  /** Nettoyage à la suppression d'une ligue (appel interne). */
  @Delete('internal/leagues/:leagueId')
  async removeLeague(@Param('leagueId') leagueId: string) {
    await this.scoring.removeLeagueScores(leagueId);
    return { ok: true };
  }

  /** Nettoyage au départ d'un membre d'une ligue (appel interne). */
  @Delete('internal/leagues/:leagueId/users/:userId')
  async removeLeagueMember(@Param('leagueId') leagueId: string, @Param('userId') userId: string) {
    await this.scoring.removeLeagueScores(leagueId, userId);
    return { ok: true };
  }

  private async memberLeague(leagueId: string, userId: string) {
    const league = await this.fantasy.leagueForUser(leagueId, userId);
    if (!league) {
      throw new ForbiddenException('Tu n’es pas membre de cette ligue');
    }
    return league;
  }
}
