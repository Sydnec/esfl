import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { GAME_IDS, GAME_LABELS } from '@esfl/contracts';
import { Queue } from 'bullmq';
import { AdminGuard } from '../common/admin.guard';
import { FantasyClient } from '../fantasy-client/fantasy.client';
import {
  enqueueEnrichTeam,
  enqueueIngestStats,
  INGESTION_QUEUE,
  IngestionJobName,
} from '../ingestion/ingestion.constants';
import { TeamEnrichmentService } from '../ingestion/team-enrichment.service';
import { StatsIngestionService } from '../stats/stats-ingestion';
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
    private readonly fantasyClient: FantasyClient,
    private readonly statsIngestion: StatsIngestionService,
    private readonly enrichment: TeamEnrichmentService,
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

  /** Ids des joueurs ayant des stats dans la compétition (ceux qui ont réellement joué). */
  @Get('competitions/:id/stat-players')
  statPlayers(@Param('id') id: string) {
    return this.catalog.statPlayerIds(id);
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

  /** Métadonnées de tous les joueurs (analytics de points, appel interne scoring). */
  @Get('internal/players/meta')
  playersMeta() {
    return this.catalog.playersMeta();
  }

  /** Toutes les stats d'un jeu pour le calcul des distributions (appel interne scoring). */
  @Get('internal/stats/all')
  statsForScoring(@Query('gameId') gameId?: string) {
    return this.catalog.statsForScoring(gameId ?? '');
  }

  /** Complétude des stats d'une journée Paris (gel des scores, appel interne scoring). */
  @Get('internal/days/:date/completeness')
  dayCompleteness(@Param('date') date: string) {
    return this.catalog.dayCompleteness(date);
  }

  /** Déclenchement manuel d'un job d'ingestion (réservé à un usage admin/dev). */
  @Post('admin/sync/:job')
  @UseGuards(AdminGuard)
  async triggerSync(@Param('job') job: string) {
    const allowed: IngestionJobName[] = [
      'sync-series',
      'sync-matches',
      'sync-rosters',
      'sync-live',
      'check-grid-coverage',
      'sync-live-stats',
      'retry-stats-backfill',
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

  /** Relance manuelle de l'enrichissement provider d'une équipe. */
  @Post('admin/enrich-team/:teamId')
  @UseGuards(AdminGuard)
  async triggerEnrichTeam(@Param('teamId') teamId: string) {
    await enqueueEnrichTeam(this.ingestionQueue, teamId);
    return { enqueued: 'enrich-team', teamId };
  }

  /**
   * Relance la récupération de stats d'un match (avec retries planifiés).
   * `?force=true` refait le fetch même si des stats existent déjà (backfill).
   */
  @Post('admin/ingest-stats/:matchId')
  @UseGuards(AdminGuard)
  async triggerIngestStats(@Param('matchId') matchId: string, @Query('force') force?: string) {
    await enqueueIngestStats(this.ingestionQueue, matchId, force === 'true', true);
    return { enqueued: 'ingest-stats', matchId, force: force === 'true' };
  }

  /**
   * Bulk « Relancer » : réenqueue l'ingestion de tous les matchs finis récents,
   * suivis, sans stats mais récupérables (hors CS2 non couvert par Grid).
   * Répare en masse les matchs recréés par un re-sync sans job d'ingestion
   * (> 48h, jamais ré-ingérés seuls). Fenêtre en jours via `?days=` (défaut 7,
   * borné à 30).
   */
  @Post('admin/reingest-missing')
  @UseGuards(AdminGuard)
  async reingestMissing(@Query('days') daysRaw?: string) {
    const days = Math.min(Math.max(Number.parseInt(daysRaw ?? '7', 10) || 7, 1), 30);
    const followed = await this.fantasyClient.followedCompetitionIds();
    const matchIds = await this.catalog.reingestableMatchIds(followed, days);
    await Promise.all(matchIds.map((id) => enqueueIngestStats(this.ingestionQueue, id)));
    return { enqueued: matchIds.length, days };
  }

  /** Purge les échecs de jobs visant un match supprimé (reliquats de purge/re-sync). */
  @Post('admin/queue/prune-failures')
  @UseGuards(AdminGuard)
  pruneFailures() {
    return this.catalog.pruneObsoleteFailures(this.ingestionQueue);
  }

  /** Contenu détaillé de la file BullMQ (compteurs + jobs par état) — page admin. */
  @Get('admin/queue')
  @UseGuards(AdminGuard)
  queue() {
    return this.catalog.queueSnapshot(this.ingestionQueue);
  }

  /**
   * Vide la file selon l'état (`completed`, `failed`, `pending`, `all`) en
   * préservant les syncs planifiés et les jobs en cours.
   */
  @Post('admin/queue/clean')
  @UseGuards(AdminGuard)
  cleanQueue(@Query('state') state?: string) {
    const allowed = ['completed', 'failed', 'pending', 'all'] as const;
    if (!allowed.includes(state as (typeof allowed)[number])) {
      throw new BadRequestException(`État inconnu : ${state}`);
    }
    return this.catalog.cleanQueue(this.ingestionQueue, state as (typeof allowed)[number]);
  }

  /** Équipes de matchs finis récents sans stats (candidates à un alias). */
  @Get('admin/unmatched-teams')
  @UseGuards(AdminGuard)
  unmatchedTeams() {
    return this.catalog.unmatchedTeams();
  }

  /** Noms provider candidats autour d'un match (pré-remplissage du matching manuel). */
  @Get('admin/matches/:matchId/suggestions')
  @UseGuards(AdminGuard)
  matchSuggestions(@Param('matchId') matchId: string) {
    return this.statsIngestion.suggestTeamNames(matchId);
  }

  /**
   * Fixe manuellement la page VLR d'un match Valorant et relance l'ingestion :
   * le provider parse cette page au lieu de chercher par nom d'équipe.
   */
  @Post('admin/matches/:matchId/stats-page')
  @UseGuards(AdminGuard)
  async setStatsPage(@Param('matchId') matchId: string, @Query('url') url?: string) {
    const { statsPageUrl } = await this.catalog.setValorantStatsPage(matchId, url ?? '');
    await enqueueIngestStats(this.ingestionQueue, matchId, true, true);
    return { statsPageUrl, reingested: true };
  }

  /** Recherche de matchs par nom (poser une page VLR / relancer, hors fenêtre 48h). */
  @Get('admin/matches')
  @UseGuards(AdminGuard)
  searchMatches(@Query('search') search?: string) {
    return this.catalog.searchMatches(search ?? '');
  }

  /** Recherche d'équipes pour le matching manuel (page admin). */
  @Get('admin/teams')
  @UseGuards(AdminGuard)
  searchTeams(@Query('search') search?: string, @Query('gameId') gameId?: string) {
    return this.catalog.searchTeams(search ?? '', gameId);
  }

  /**
   * Ajoute un alias provider à une équipe (matching manuel) et relance
   * l'ingestion de ses matchs récents pour que le rapprochement s'applique.
   */
  @Post('admin/teams/:teamId/aliases')
  @UseGuards(AdminGuard)
  async addTeamAlias(@Param('teamId') teamId: string, @Query('alias') alias?: string) {
    // Lien lol.fandom.com → nom canonique + variantes fiables (redirections,
    // renommages) via Leaguepedia ; sinon la saisie est utilisée telle quelle.
    const resolved = await this.statsIngestion.resolveLeaguepediaNames(alias ?? '');
    const names = resolved.length > 0 ? resolved : [alias ?? ''];
    const { aliases, matchIds, added, redundant } = await this.catalog.addTeamAliases(teamId, names);
    await Promise.all(
      matchIds.map((id) => enqueueIngestStats(this.ingestionQueue, id, true, true)),
    );
    return { aliases, reingested: matchIds.length, added, redundant };
  }

  /**
   * Fusionne les fiches joueur en double (historique de stats fragmenté).
   * `scope=same-team` (défaut) ne regroupe qu'à équipe identique : sans
   * ambiguïté. `cross-team` ratisse tout le jeu et n'est exposé qu'en dry-run,
   * le temps de relire ce qu'il propose.
   */
  @Post('admin/players/merge-duplicates')
  @UseGuards(AdminGuard)
  mergeDuplicatePlayers(@Query('scope') scope?: string, @Query('dryRun') dryRun?: string) {
    const target = scope ?? 'same-team';
    if (target !== 'same-team' && target !== 'cross-team') {
      throw new BadRequestException(`Scope inconnu : ${scope}`);
    }
    const simulation = dryRun === '1' || dryRun === 'true' || target === 'cross-team';
    return this.catalog.mergeDuplicatePlayers(target, simulation);
  }

  /** Équipes LoL/Valorant sans identité provider (saisie manuelle possible). */
  @Get('admin/teams/missing-provider-id')
  @UseGuards(AdminGuard)
  teamsWithoutProviderId() {
    return this.catalog.teamsWithoutProviderId();
  }

  /**
   * Fixe manuellement l'identité provider d'une équipe (Leaguepedia : lien
   * lol.fandom.com ou nom ; VLR : lien vlr.gg/team/<id> ou id). La saisie est
   * validée contre la fiche source avant d'être écrite, puis on relance
   * l'enrichissement (fiche + roster) et l'ingestion des matchs restés sans
   * stats — l'id débloque le rapprochement sur tout l'historique.
   */
  @Post('admin/teams/:teamId/provider-id')
  @UseGuards(AdminGuard)
  async setTeamProviderId(@Param('teamId') teamId: string, @Query('value') value?: string) {
    const team = await this.catalog.getTeam(teamId);
    const { source, providerTeamId, profile } = await this.statsIngestion.resolveTeamProviderId(
      team,
      value ?? '',
    );
    const { providerIds, matchIds } = await this.catalog.setTeamProviderId(
      teamId,
      source,
      providerTeamId,
    );
    // Enrichissement AVANT la ré-ingestion, et non en parallèle : il peuple le
    // roster depuis la fiche provider. Sans ça, une équipe à zéro joueur voit
    // ses matchs ré-ingérés en concurrence créer chacun les mêmes fiches (rien
    // ne les dédoublonne en base) et le roster sort en N exemplaires.
    await this.enrichment.enrichTeam(teamId);
    await Promise.all(
      matchIds.map((id) => enqueueIngestStats(this.ingestionQueue, id, true, true)),
    );
    return {
      source,
      providerTeamId,
      providerIds,
      // Ce que la source dit de cette identité : permet de vérifier d'un coup
      // d'œil qu'on n'a pas rattaché la mauvaise équipe.
      profile: { name: profile.name, acronym: profile.acronym, roster: profile.roster?.length ?? 0 },
      reingested: matchIds.length,
    };
  }

  /** Retire un alias d'une équipe. */
  @Delete('admin/teams/:teamId/aliases')
  @UseGuards(AdminGuard)
  removeTeamAlias(@Param('teamId') teamId: string, @Query('alias') alias?: string) {
    return this.catalog.removeTeamAlias(teamId, alias ?? '');
  }

  /** Santé de l'ingestion : activité par jeu, catalogue, queue — page admin du front. */
  @Get('admin/health')
  @UseGuards(AdminGuard)
  health() {
    return this.catalog.ingestionHealth(this.ingestionQueue);
  }
}
