import { BadRequestException, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { GAME_IDS, GAME_LABELS } from '@esfl/contracts';
import { Queue } from 'bullmq';
import { AdminGuard } from '../common/admin.guard';
import { INGESTION_QUEUE, IngestionJobName } from '../ingestion/ingestion.processor';
import { CatalogService } from './catalog.service';

function parseIds(value: string | undefined): string[] {
  return value ? value.split(',').filter(Boolean) : [];
}

function parseDate(value: string | undefined, label: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`Paramètre ${label} invalide`);
  }
  return date;
}

@Controller('data')
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    @InjectQueue(INGESTION_QUEUE) private readonly ingestionQueue: Queue,
  ) {}

  @Get('games')
  games() {
    return GAME_IDS.map((id) => ({ id, label: GAME_LABELS[id] }));
  }

  @Get('competitions')
  competitions(@Query('gameId') gameId?: string, @Query('search') search?: string) {
    return this.catalog.listCompetitions(gameId, search);
  }

  @Get('competitions/:id')
  competition(@Param('id') id: string) {
    return this.catalog.getCompetition(id);
  }

  @Get('matches')
  matches(
    @Query('competitionIds') competitionIds?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.catalog.listMatches(
      parseIds(competitionIds),
      parseDate(from, 'from'),
      parseDate(to, 'to'),
    );
  }

  @Get('matches/:id')
  match(@Param('id') id: string) {
    return this.catalog.getMatch(id);
  }

  @Get('players')
  players(@Query('competitionIds') competitionIds?: string) {
    return this.catalog.listPlayers(parseIds(competitionIds));
  }

  @Get('players/by-ids')
  playersByIds(@Query('ids') ids?: string) {
    return this.catalog.listPlayersByIds(parseIds(ids));
  }

  // Déclaré après players/by-ids : Nest matche dans l'ordre, sinon « by-ids »
  // serait capturé comme un :id.
  @Get('players/:id')
  player(@Param('id') id: string) {
    return this.catalog.getPlayer(id);
  }

  @Get('players/:id/matches')
  playerMatches(@Param('id') id: string) {
    return this.catalog.listPlayerMatches(id);
  }

  @Get('stats')
  stats(@Query('matchIds') matchIds?: string) {
    return this.catalog.listStats(parseIds(matchIds));
  }

  /** Ids des matchs ayant des stats (recalcul en masse du scoring, appel interne). */
  @Get('internal/stats/match-ids')
  statsMatchIds() {
    return this.catalog.distinctStatsMatchIds();
  }

  /** Déclenchement manuel d'un job d'ingestion (réservé à un usage admin/dev). */
  @Post('admin/sync/:job')
  @UseGuards(AdminGuard)
  async triggerSync(@Param('job') job: string) {
    const allowed: IngestionJobName[] = [
      'sync-series',
      'sync-matches',
      'sync-rosters',
      'check-grid-coverage',
    ];
    if (!allowed.includes(job as IngestionJobName)) {
      throw new BadRequestException(`Job inconnu : ${job}`);
    }
    await this.ingestionQueue.add(job, {});
    return { enqueued: job };
  }

  /** Sync immédiat d'une compétition (appelé par le fantasy-service à l'ajout). */
  @Post('admin/sync-competition/:id')
  @UseGuards(AdminGuard)
  async triggerCompetitionSync(@Param('id') competitionId: string) {
    await this.ingestionQueue.add('sync-competition', { competitionId });
    return { enqueued: 'sync-competition', competitionId };
  }

  /**
   * Relance la récupération de stats d'un match (avec retries planifiés).
   * `?force=true` refait le fetch même si des stats existent déjà (backfill).
   */
  @Post('admin/ingest-stats/:matchId')
  @UseGuards(AdminGuard)
  async triggerIngestStats(@Param('matchId') matchId: string, @Query('force') force?: string) {
    await this.ingestionQueue.add(
      'ingest-stats',
      { matchId, force: force === 'true' },
      {
        attempts: 8,
        backoff: { type: 'exponential', delay: 15 * 60 * 1000 },
        removeOnComplete: 500,
        removeOnFail: 1000,
      },
    );
    return { enqueued: 'ingest-stats', matchId, force: force === 'true' };
  }
}
