import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { GameId, QUEUES, StatsIngestedEvent } from '@esfl/contracts';
import { Queue } from 'bullmq';
import { Prisma } from '../../generated/client';
import type { Match } from '../../generated/client';
import { mergeGamesSummary } from '../common/games-summary';
import { PrismaService } from '../prisma.service';
import { buildPlayerIndex, matchPlayer, normalizeName } from './matching';
import { BallchasingStatsProvider } from './ballchasing.provider';
import { GridStatsProvider } from './grid.provider';
import { LeaguepediaStatsProvider } from './leaguepedia.provider';
import type { GameStatsProvider, MatchContext, ProviderResult } from './provider';
import { VlrStatsProvider } from './vlr.provider';

@Injectable()
export class StatsIngestionService {
  private readonly logger = new Logger(StatsIngestionService.name);
  private readonly providers: GameStatsProvider[];

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUES.STATS_INGESTED) private readonly statsIngestedQueue: Queue,
    private readonly grid: GridStatsProvider,
    vlr: VlrStatsProvider,
    leaguepedia: LeaguepediaStatsProvider,
    ballchasing: BallchasingStatsProvider,
  ) {
    this.providers = [grid, vlr, leaguepedia, ballchasing];
  }

  /**
   * Récupère les stats détaillées d'un match terminé et publie stats.ingested.
   * Lève si les stats ne sont pas encore publiées par la source externe :
   * le job BullMQ `ingest-stats` retentera avec backoff exponentiel.
   * `force` refait le fetch même si des stats existent (backfill du détail
   * par map, correction de données).
   */
  async ingestForMatchId(matchId: string, force = false): Promise<void> {
    const match = await this.prisma.match.findUnique({ where: { id: matchId } });
    if (!match) {
      this.logger.warn(`ingest-stats : match inconnu ${matchId}`);
      return;
    }

    if (!force) {
      const newest = await this.prisma.playerMatchStats.aggregate({
        _max: { updatedAt: true },
        where: { matchId },
      });
      const newestAt = newest._max.updatedAt;
      // Un instantané pris pendant le match (sync live) est antérieur au
      // coup de sifflet : on refait le fetch pour figer les stats finales.
      const liveSnapshot = newestAt && match.endAt && newestAt < match.endAt;
      if (newestAt && !liveSnapshot) {
        await this.publish(match, 'existing');
        return;
      }
    }

    const provider = this.providers.find((candidate) => candidate.gameId === match.gameId);
    if (!provider) {
      this.logger.warn(`Aucun provider de stats pour ${match.gameId} (match ${matchId})`);
      return;
    }

    const context = await this.loadContext(match);
    const result = await provider.fetchStats(match, context);
    if (!result || result.lines.length === 0) {
      throw new Error(
        `Stats indisponibles pour le match ${matchId} via ${provider.source}, nouvelle tentative planifiée`,
      );
    }

    const persisted = await this.persistResult(match, context, provider.source, result);
    this.logger.log(`${persisted} lignes de stats ${provider.source} pour le match ${matchId}`);
    await this.publish(match, provider.source);
  }

  /**
   * Suivi des matchs en cours pour les jeux dont le provider expose
   * fetchLiveStats (page VLR vivante, series state Grid) : resynchronisés
   * à chaque cycle pour offrir le même affichage qu'un match terminé.
   * Sans retry : le cycle suivant repassera.
   */
  async syncLiveStats(): Promise<number> {
    let synced = 0;
    for (const provider of this.providers) {
      if (!provider.fetchLiveStats) continue;
      const running = await this.prisma.match.findMany({
        where: {
          gameId: provider.gameId,
          status: 'running',
          teamAId: { not: null },
          teamBId: { not: null },
        },
      });
      for (const match of running) {
        const context = await this.loadContext(match);
        const result = await provider.fetchLiveStats(match, context).catch(() => null);
        if (!result || result.lines.length === 0) continue;
        await this.persistResult(match, context, provider.source, result);
        await this.publish(match, provider.source);
        synced += 1;
      }
    }
    if (synced > 0) {
      this.logger.log(`Stats live synchronisées pour ${synced} match(s)`);
    }
    return synced;
  }

  /**
   * Persiste un résultat provider : résolution d'identité (exact → leet →
   * inclusion, sinon création de la fiche quand le côté du joueur est connu
   * — le référentiel Pandascore est lacunaire sur les équipes tier-B, le
   * sync des rosters adoptera la fiche s'il rattrape), upsert des stats,
   * fusion des manches et mémorisation de la page source.
   */
  private async persistResult(
    match: Match,
    context: MatchContext,
    source: string,
    result: ProviderResult,
  ): Promise<number> {
    const index = buildPlayerIndex(context.players);
    let persisted = 0;
    for (const line of result.lines) {
      let local = matchPlayer(index, line.externalName);
      if (!local) {
        const team = line.side === 'A' ? context.teamA : line.side === 'B' ? context.teamB : null;
        if (!team) {
          this.logger.warn(
            `Joueur ${line.externalName} sans équipe résolue (match ${match.id}) : stats ignorées`,
          );
          continue;
        }
        local = await this.prisma.player.create({
          data: {
            gameId: match.gameId,
            name: line.externalName,
            teamId: team.id,
            source,
          },
        });
        index.set(normalizeName(local.name), local);
        this.logger.log(`Fiche joueur créée depuis ${source} : ${line.externalName} (${team.name})`);
      }
      await this.prisma.playerMatchStats.upsert({
        where: { matchId_playerId: { matchId: match.id, playerId: local.id } },
        create: {
          matchId: match.id,
          playerId: local.id,
          gameId: match.gameId,
          source,
          raw: line.raw,
          normalized: line.normalized,
          perMap: line.perMap ?? Prisma.JsonNull,
        },
        update: {
          raw: line.raw,
          normalized: line.normalized,
          source,
          perMap: line.perMap ?? Prisma.JsonNull,
        },
      });
      persisted += 1;
    }
    if (result.games?.length) {
      await this.mergeProviderGames(match, result.games);
    }
    if (result.pageUrl && result.pageUrl !== match.statsPageUrl) {
      await this.prisma.match.update({
        where: { id: match.id },
        data: { statsPageUrl: result.pageUrl },
      });
    }
    return persisted;
  }

  /**
   * Marque la couverture Grid des matchs CS2 (gridCovered) : les matchs que
   * Grid ne référence pas n'auront jamais de stats et sont exclus du
   * catalogue. Vérifiés : matchs sans verdict, équipes connues, entre J-2 et
   * J+3. Un match à venir introuvable reste null (la série peut apparaître
   * tard) ; il devient false une fois commencé.
   */
  async checkGridCoverage(): Promise<number> {
    const now = Date.now();
    const matches = await this.prisma.match.findMany({
      where: {
        gameId: 'cs2',
        gridCovered: null,
        teamAId: { not: null },
        teamBId: { not: null },
        scheduledAt: {
          gte: new Date(now - 48 * 3600 * 1000),
          lte: new Date(now + 72 * 3600 * 1000),
        },
      },
      orderBy: { scheduledAt: 'asc' },
      take: 30,
    });

    let checked = 0;
    for (const match of matches) {
      const reference = match.beginAt ?? match.scheduledAt;
      if (!reference) continue;
      const context = await this.loadContext(match);
      if (!context.teamA || !context.teamB) continue;
      const seriesId = await this.grid.findSeries(reference, context.teamA.name, context.teamB.name);
      const started = match.status !== 'not_started' || reference.getTime() < now;
      if (seriesId) {
        await this.prisma.match.update({ where: { id: match.id }, data: { gridCovered: true } });
        checked += 1;
      } else if (started) {
        await this.prisma.match.update({ where: { id: match.id }, data: { gridCovered: false } });
        checked += 1;
      }
    }
    if (checked > 0) {
      this.logger.log(`Couverture Grid vérifiée pour ${checked} match(s) CS2`);
    }
    return checked;
  }

  /** Fusionne le détail des manches du provider (map, scores) avec celui de Pandascore (winner, durée). */
  private async mergeProviderGames(
    match: Match,
    providerGames: Array<{ position: number; map?: string | null; scoreA?: number | null; scoreB?: number | null }>,
  ): Promise<void> {
    const merged = mergeGamesSummary(match.gamesSummary, providerGames);
    await this.prisma.match.update({
      where: { id: match.id },
      data: { gamesSummary: merged as unknown as Prisma.InputJsonValue },
    });
  }

  private async loadContext(match: Match): Promise<MatchContext> {
    const teamIds = [match.teamAId, match.teamBId].filter((id): id is string => Boolean(id));
    const [teams, players] = await Promise.all([
      this.prisma.team.findMany({ where: { id: { in: teamIds } } }),
      this.prisma.player.findMany({ where: { teamId: { in: teamIds } } }),
    ]);
    return {
      teamA: teams.find((team) => team.id === match.teamAId) ?? null,
      teamB: teams.find((team) => team.id === match.teamBId) ?? null,
      players,
    };
  }

  private async publish(match: Match, source: string): Promise<void> {
    const event: StatsIngestedEvent = {
      matchId: match.id,
      gameId: match.gameId as GameId,
      source,
      ingestedAt: new Date().toISOString(),
    };
    await this.statsIngestedQueue.add('stats-ingested', event, {
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
    this.logger.log(`stats.ingested publié pour ${match.id} (source: ${source})`);
  }
}
