import { Injectable, Logger } from '@nestjs/common';
import { GAME_IDS, GameId, parisDate } from '@esfl/contracts';
import {
  computePlayerScore,
  computeZTotal,
  Distribution,
  DistributionLookup,
  distributionRole,
  extractMetrics,
  mapsPlayed,
  SCORING_VERSION,
  ZTOTAL_METRIC,
} from '../calculators/calculators';
import { DataClient, DataMatch } from '../clients/data.client';
import { FantasyClient, FantasyRoster } from '../clients/fantasy.client';
import { PrismaService } from '../prisma.service';

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Minimum de matchs notés pour figurer dans les tops (évite le bruit). */
const MIN_SCORES = 3;

/** Joueurs retenus PAR JEU dans les analytics admin (cf. pointStats). */
const TOP_PLAYERS_PER_GAME = 100;

/** Fenêtre de balayage du gel automatique (jours en arrière depuis hier). */
const FREEZE_SCAN_DAYS = 10;
/** Échéance dure : une journée incomplète est gelée quand même à J+3. */
const FREEZE_DEADLINE_DAYS = 3;
/** TTL du cache mémoire des dates gelées. */
const FROZEN_CACHE_TTL_MS = 60_000;

@Injectable()
export class ScoringService {
  private readonly logger = new Logger(ScoringService.name);
  /** Cache court des dates gelées (une requête par minute max, pas par événement). */
  private frozenCache: { dates: Set<string>; at: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly data: DataClient,
    private readonly fantasy: FantasyClient,
  ) {}

  /**
   * Dates Paris gelées : leurs notes et scores sont immuables (garantie du
   * scoreboard des ligues). Gel absolu — aucun recalcul, même admin ; seule
   * porte de sortie, le dégel manuel de la date.
   */
  private async frozenDates(): Promise<Set<string>> {
    if (this.frozenCache && Date.now() - this.frozenCache.at < FROZEN_CACHE_TTL_MS) {
      return this.frozenCache.dates;
    }
    const rows = await this.prisma.frozenMatchDay.findMany({ select: { date: true } });
    const dates = new Set(rows.map((row) => row.date));
    this.frozenCache = { dates, at: Date.now() };
    return dates;
  }

  private invalidateFrozenCache(): void {
    this.frozenCache = null;
  }

  /** Date Paris d'un match (référence beginAt > scheduledAt > endAt), null si inconnue. */
  private matchDate(match: DataMatch): string | null {
    const reference = match.beginAt ?? match.scheduledAt ?? match.endAt;
    return reference ? parisDate(new Date(reference)) : null;
  }

  /**
   * Recalcule (idempotent) les points fantasy d'un match puis les scores
   * des rosters de la journée correspondante.
   */
  async computeForMatch(matchId: string): Promise<{ playersScored: number; rostersUpdated: number }> {
    const match = await this.data.getMatch(matchId);
    // Journée gelée : ses notes sont immuables (stats.ingested tardif ou
    // recompute admin compris). Dégeler la date d'abord pour corriger.
    const date = this.matchDate(match);
    if (date && (await this.frozenDates()).has(date)) {
      this.logger.log(`${match.name} : journée ${date} gelée, recalcul ignoré`);
      return { playersScored: 0, rostersUpdated: 0 };
    }
    const distributions = await this.ensureDistributions();
    const playersScored = await this.scorePlayers(match, distributions);
    const rostersUpdated = await this.updateRosterScores(match);
    this.logger.log(
      `${match.name} : ${playersScored} joueurs notés, ${rostersUpdated} rosters mis à jour`,
    );
    return { playersScored, rostersUpdated };
  }

  /**
   * Recalcule tous les points fantasy avec la formule courante (matchs ayant
   * déjà des points ou des stats), puis les rosters des journées touchées.
   * Coût : lectures internes data-service uniquement, aucune API externe.
   */
  async recomputeAll(): Promise<{ matches: number; playersScored: number; datesUpdated: number }> {
    await this.recomputeDistributions();
    const distributions = await this.loadDistributions();

    const fromPoints = await this.prisma.fantasyPoints.findMany({
      distinct: ['matchId'],
      select: { matchId: true },
    });
    const fromStats = await this.data.listStatsMatchIds();
    const matchIds = [...new Set([...fromPoints.map((row) => row.matchId), ...fromStats])];

    const frozen = await this.frozenDates();
    let playersScored = 0;
    const dates = new Set<string>();
    for (const matchId of matchIds) {
      // Match disparu côté data : on laisse les points orphelins tels quels.
      const match = await this.data.getMatch(matchId).catch(() => null);
      if (!match) continue;
      // Journée gelée : notes immuables, on ne re-score pas.
      const date = this.matchDate(match);
      if (date && frozen.has(date)) continue;
      playersScored += await this.scorePlayers(match, distributions);
      if (date) dates.add(date);
    }

    for (const date of dates) {
      await this.updateRosterScoresForDate(date);
    }
    this.logger.log(
      `Recalcul complet (${SCORING_VERSION}) : ${matchIds.length} matchs, ${playersScored} scores, ${dates.size} journées`,
    );
    return { matches: matchIds.length, playersScored, datesUpdated: dates.size };
  }

  /**
   * Bascule : supprime tous les points et scores, puis recalcule tout avec la
   * version courante (distributions incluses). À lancer après la mise à jour
   * des stats ingérées.
   */
  async resetAndRecompute(): Promise<{ matches: number; playersScored: number; datesUpdated: number }> {
    // Les journées gelées sont épargnées, même par la bascule : leurs points
    // et scores restent tels quels (dégeler la date d'abord pour tout refaire).
    const frozen = await this.frozenDates();
    if (frozen.size === 0) {
      await this.prisma.rosterScore.deleteMany({});
      await this.prisma.fantasyPoints.deleteMany({});
    } else {
      await this.prisma.rosterScore.deleteMany({
        where: { matchDayDate: { notIn: [...frozen] } },
      });
      const scored = await this.prisma.fantasyPoints.findMany({
        distinct: ['matchId'],
        select: { matchId: true },
      });
      const keep: string[] = [];
      for (const { matchId } of scored) {
        const match = await this.data.getMatch(matchId).catch(() => null);
        const date = match ? this.matchDate(match) : null;
        if (date && frozen.has(date)) keep.push(matchId);
      }
      await this.prisma.fantasyPoints.deleteMany({ where: { matchId: { notIn: keep } } });
    }
    this.logger.warn(
      `Scores et points supprimés (${frozen.size} journée(s) gelée(s) épargnée(s)) — recalcul complet en cours`,
    );
    return this.recomputeAll();
  }

  /**
   * (Re)calcule les distributions (μ/σ) par jeu et par rôle LoL sur tout
   * l'historique, à partir des stats du data-service. Base des Z-scores.
   */
  async recomputeDistributions(): Promise<number> {
    // Tout l'historique en memoire (une passe reseau, reutilisee deux fois).
    const allStats: Array<{
      gameId: GameId;
      role: string | null;
      normalized: unknown;
      maps: number;
    }> = [];
    for (const gameId of GAME_IDS) {
      const stats = await this.data.getScoringStats(gameId);
      for (const stat of stats) {
        allStats.push({ gameId, role: stat.role, normalized: stat.normalized, maps: stat.maps });
      }
    }

    // Passe 1 : distributions par metrique brute.
    const metricAcc = new Map<string, { n: number; sum: number; sumSq: number }>();
    for (const stat of allStats) {
      const role = distributionRole(stat.gameId, stat.role);
      const values = extractMetrics(stat.gameId, stat.normalized, stat.maps);
      for (const [metric, value] of Object.entries(values)) {
        this.accumulate(metricAcc, `${stat.gameId} ${role} ${metric}`, value);
      }
    }
    await this.upsertDistributions(metricAcc);

    // Passe 2 : distribution de Z_total (variance a ramener a 1 pour etaler les
    // notes), avec les distributions de la passe 1.
    const lookup = await this.loadDistributions();
    const zAcc = new Map<string, { n: number; sum: number; sumSq: number }>();
    for (const stat of allStats) {
      const result = computeZTotal(stat.gameId, stat.normalized, stat.maps, stat.role, lookup);
      if (!result) continue;
      this.accumulate(zAcc, `${stat.gameId} ${result.roleKey} ${ZTOTAL_METRIC}`, result.zTotal);
    }
    await this.upsertDistributions(zAcc);

    const total = metricAcc.size + zAcc.size;
    this.logger.log(`Distributions recalculees : ${total} (jeu x role x metrique, dont Z_total)`);
    return total;
  }

  private accumulate(
    acc: Map<string, { n: number; sum: number; sumSq: number }>,
    key: string,
    value: number,
  ): void {
    const bucket = acc.get(key) ?? { n: 0, sum: 0, sumSq: 0 };
    bucket.n += 1;
    bucket.sum += value;
    bucket.sumSq += value * value;
    acc.set(key, bucket);
  }

  private async upsertDistributions(
    acc: Map<string, { n: number; sum: number; sumSq: number }>,
  ): Promise<void> {
    const ops = [...acc.entries()].map(([key, bucket]) => {
      const [gameId, role, metric] = key.split(' ');
      const mean = bucket.sum / bucket.n;
      const stddev = Math.sqrt(Math.max(0, bucket.sumSq / bucket.n - mean * mean));
      return this.prisma.statDistribution.upsert({
        where: { gameId_role_metric: { gameId, role, metric } },
        create: { gameId, role, metric, mean, stddev, sampleSize: bucket.n },
        update: { mean, stddev, sampleSize: bucket.n },
      });
    });
    await this.prisma.$transaction(ops);
  }

  /** Charge les distributions en une fonction de recherche. */
  private async loadDistributions(): Promise<DistributionLookup> {
    const rows = await this.prisma.statDistribution.findMany();
    const map = new Map<string, Distribution>(
      rows.map((row) => [
        `${row.gameId} ${row.role} ${row.metric}`,
        { mean: row.mean, stddev: row.stddev, sampleSize: row.sampleSize },
      ]),
    );
    return (gameId, role, metric) => map.get(`${gameId} ${role} ${metric}`);
  }

  /** Distributions à jour : recalcule si vides ou périmées (TTL), puis charge. */
  private async ensureDistributions(): Promise<DistributionLookup> {
    const newest = await this.prisma.statDistribution.aggregate({ _max: { updatedAt: true } });
    const ttlMs = (Number(process.env.SCORING_DISTRIBUTION_TTL_HOURS) || 6) * 3600 * 1000;
    const stale =
      !newest._max.updatedAt || Date.now() - newest._max.updatedAt.getTime() > ttlMs;
    if (stale) await this.recomputeDistributions();
    return this.loadDistributions();
  }

  /** Note (upsert) tous les joueurs d'un match via le pipeline Z-score. */
  private async scorePlayers(match: DataMatch, distributions: DistributionLookup): Promise<number> {
    const stats = await this.data.listStats([match.id]);
    const maps = mapsPlayed(match);

    let playersScored = 0;
    for (const stat of stats) {
      const result = computePlayerScore(
        stat.gameId as GameId,
        stat.normalized,
        maps,
        stat.role,
        distributions,
      );
      if (!result) {
        this.logger.warn(`Stats invalides pour ${stat.playerId} (${match.name})`);
        continue;
      }
      await this.prisma.fantasyPoints.upsert({
        where: { matchId_playerId: { matchId: match.id, playerId: stat.playerId } },
        create: {
          matchId: match.id,
          playerId: stat.playerId,
          gameId: stat.gameId,
          points: result.points,
          breakdown: result.breakdown,
          version: SCORING_VERSION,
        },
        update: { points: result.points, breakdown: result.breakdown, version: SCORING_VERSION },
      });
      playersScored += 1;
    }
    return playersScored;
  }

  /** Met à jour les scores des rosters de la journée du match. */
  private async updateRosterScores(match: DataMatch): Promise<number> {
    const reference = match.beginAt ?? match.scheduledAt ?? match.endAt;
    if (!reference) return 0;
    return this.updateRosterScoresForDate(parisDate(new Date(reference)), match.competitionId);
  }

  /**
   * Met à jour les rosters d'une journée, optionnellement limités aux ligues
   * suivant une compétition donnée.
   */
  private async updateRosterScoresForDate(date: string, competitionId?: string): Promise<number> {
    // Journée gelée : le scoreboard est garanti, aucun rafraîchissement.
    if ((await this.frozenDates()).has(date)) return 0;
    const rosters = await this.fantasy.rostersForDate(date);
    const impacted = competitionId
      ? rosters.filter((roster) =>
          roster.league.competitions.some((entry) => entry.competitionId === competitionId),
        )
      : rosters;

    let updated = 0;
    // Matchs de la journée par ligue (mémoïsé par ligue).
    const dayMatchesByLeague = new Map<string, string[]>();
    for (const roster of impacted) {
      const leagueId = roster.league.id;
      if (!dayMatchesByLeague.has(leagueId)) {
        const competitionIds = roster.league.competitions.map((entry) => entry.competitionId);
        dayMatchesByLeague.set(leagueId, await this.matchIdsForDate(competitionIds, date));
      }
      updated += await this.scoreRoster(roster, date, dayMatchesByLeague.get(leagueId) ?? []);
    }
    return updated;
  }

  /** Ids des matchs d'une date Europe/Paris pour un ensemble de compétitions. */
  private async matchIdsForDate(competitionIds: string[], date: string): Promise<string[]> {
    if (competitionIds.length === 0) return [];
    const from = new Date(`${date}T00:00:00Z`);
    from.setUTCHours(from.getUTCHours() - 12);
    const to = new Date(`${date}T23:59:59Z`);
    to.setUTCHours(to.getUTCHours() + 12);
    const matches = await this.data.listMatches(competitionIds, from, to);
    return matches
      .filter((m) => {
        const start = m.beginAt ?? m.scheduledAt;
        return start && parisDate(new Date(start)) === date;
      })
      .map((m) => m.id);
  }

  /** Meilleures performances des joueurs pros sur une journée d'une ligue. */
  async topPlayers(competitionIds: string[], date: string, take = 10) {
    const matchIds = await this.matchIdsForDate(competitionIds, date);
    if (matchIds.length === 0) return [];
    const rows = await this.prisma.fantasyPoints.groupBy({
      by: ['playerId'],
      where: { matchId: { in: matchIds } },
      // Moyenne (pas somme) : un joueur avec 2 matchs le même jour (ex. LoL EWC)
      // doit refléter sa contribution réelle au roster (moyennée), pas un cumul.
      _avg: { points: true },
    });
    return rows
      .map((row) => ({
        playerId: row.playerId,
        points: Math.round((row._avg.points ?? 0) * 100) / 100,
      }))
      .sort((a, b) => b.points - a.points)
      .slice(0, take);
  }

  private async scoreRoster(
    roster: FantasyRoster,
    date: string,
    dayMatchIds: string[],
  ): Promise<number> {
    const playerIds = roster.picks.map((pick) => pick.playerId);
    if (playerIds.length === 0 || dayMatchIds.length === 0) return 0;

    // Score jour d'un joueur = moyenne de ses notes (0-100) sur les matchs du
    // jour ; un pick qui n'a pas joué compte 0. Score roster = moyenne sur les
    // N picks (indépendant de N, comparable entre rosters).
    const rows = await this.prisma.fantasyPoints.groupBy({
      by: ['playerId'],
      where: { matchId: { in: dayMatchIds }, playerId: { in: playerIds } },
      _avg: { points: true },
    });
    const byPlayer = new Map(rows.map((row) => [row.playerId, row._avg.points ?? 0]));
    const total = playerIds.reduce((sum, id) => sum + (byPlayer.get(id) ?? 0), 0);
    const points = Math.round((total / playerIds.length) * 100) / 100;

    await this.prisma.rosterScore.upsert({
      where: { rosterId: roster.id },
      create: {
        rosterId: roster.id,
        leagueId: roster.league.id,
        userId: roster.userId,
        matchDayDate: date,
        points,
      },
      update: { points },
    });
    return 1;
  }

  /** Classement cumulé d'une ligue. */
  async leaderboard(leagueId: string) {
    const rows = await this.prisma.rosterScore.groupBy({
      by: ['userId'],
      where: { leagueId },
      _sum: { points: true },
      _count: { rosterId: true },
    });
    return rows
      .map((row) => ({
        userId: row.userId,
        points: Math.round((row._sum.points ?? 0) * 100) / 100,
        matchDaysPlayed: row._count.rosterId,
      }))
      .sort((a, b) => b.points - a.points)
      .map((entry, index) => ({ rank: index + 1, ...entry }));
  }

  /**
   * Analytics « santé » des points fantasy (page admin) : moyenne de points par
   * jeu, par rôle LoL, et top joueurs par moyenne. Basé sur toutes les lignes
   * `fantasy_points` (une par joueur×match noté).
   */
  /**
   * Distribution des notes fantasy par jeu (histogrammes) + joueurs les mieux
   * notés. Sert de controle de coherence : avec la standardisation Z-score les
   * notes doivent s'etaler autour de 50, avec de vrais extremes.
   */
  async pointStats() {
    const [rows, meta] = await Promise.all([
      this.prisma.fantasyPoints.findMany({ select: { gameId: true, points: true, playerId: true } }),
      this.data.getPlayerMeta(),
    ]);
    const metaById = new Map(meta.map((entry) => [entry.id, entry]));

    const bucketSize = 5;
    const bucketCount = Math.ceil(100 / bucketSize);
    const histByGame = new Map<
      string,
      { buckets: number[]; count: number; sum: number; min: number; max: number }
    >();
    const perPlayer = new Map<string, { gameId: string; sum: number; n: number }>();
    for (const row of rows) {
      const hist =
        histByGame.get(row.gameId) ??
        { buckets: new Array(bucketCount).fill(0), count: 0, sum: 0, min: 100, max: 0 };
      const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor(row.points / bucketSize)));
      hist.buckets[idx] += 1;
      hist.count += 1;
      hist.sum += row.points;
      hist.min = Math.min(hist.min, row.points);
      hist.max = Math.max(hist.max, row.points);
      histByGame.set(row.gameId, hist);

      const player = perPlayer.get(row.playerId) ?? { gameId: row.gameId, sum: 0, n: 0 };
      player.sum += row.points;
      player.n += 1;
      perPlayer.set(row.playerId, player);
    }

    const distributions = [...histByGame.entries()]
      .map(([gameId, hist]) => ({
        gameId,
        count: hist.count,
        mean: round2(hist.sum / hist.count),
        min: round2(hist.min),
        max: round2(hist.max),
        buckets: hist.buckets.map((count, index) => ({
          from: index * bucketSize,
          to: (index + 1) * bucketSize,
          count,
        })),
      }))
      .sort((a, b) => b.count - a.count);

    const ranked = [...perPlayer.entries()]
      .filter(([, player]) => player.n >= MIN_SCORES)
      .map(([playerId, player]) => {
        const info = metaById.get(playerId);
        return {
          playerId,
          name: info?.name ?? 'Inconnu',
          gameId: player.gameId,
          role: info?.role ?? null,
          team: info?.team?.acronym || info?.team?.name || null,
          avgPoints: round2(player.sum / player.n),
          scores: player.n,
        };
      })
      .sort((a, b) => b.avgPoints - a.avgPoints);

    // Troncature PAR JEU et non sur le classement global : un top cross-game
    // tronqué peut ne contenir aucun joueur d'un jeu (les échelles ne sont
    // comparables qu'en théorie), et le filtre par jeu du front se retrouvait
    // alors vide. Chaque jeu garde ses meilleurs, la vue « Tous » les fusionne.
    const perGameCount = new Map<string, number>();
    const topPlayers = ranked.filter((player) => {
      const seen = perGameCount.get(player.gameId) ?? 0;
      if (seen >= TOP_PLAYERS_PER_GAME) return false;
      perGameCount.set(player.gameId, seen + 1);
      return true;
    });

    return { generatedAt: new Date().toISOString(), minScores: MIN_SCORES, bucketSize, distributions, topPlayers };
  }

  /** Scores d'une journée donnée dans une ligue. */
  dayScores(leagueId: string, date: string) {
    return this.prisma.rosterScore.findMany({
      where: { leagueId, matchDayDate: date },
      orderBy: { points: 'desc' },
    });
  }

  /**
   * Gel automatique : balaie les journées passées (J-1 à J-10) non gelées et
   * gèle celles dont les données sont complètes — ou, passé l'échéance dure
   * (J+3), gèle quand même (les stats manquantes n'arriveront plus). Le gel
   * fige l'état après un dernier re-score complet de la journée.
   */
  async freezeEligibleDays(): Promise<string[]> {
    const alreadyFrozen = await this.frozenDates();
    const frozen: string[] = [];
    for (let offset = 1; offset <= FREEZE_SCAN_DAYS; offset += 1) {
      const date = parisDate(new Date(Date.now() - offset * 24 * 3600 * 1000));
      if (alreadyFrozen.has(date)) continue;
      const completeness = await this.data.dayCompleteness(date).catch(() => null);
      if (!completeness) continue;
      const hasScores =
        (await this.prisma.rosterScore.count({ where: { matchDayDate: date } })) > 0;
      // Journée sans activité (ni match ni score) : rien à garantir.
      if (completeness.totalMatches === 0 && !hasScores) continue;
      if (completeness.complete) {
        await this.freezeDay(date, 'complete');
        frozen.push(date);
      } else if (offset >= FREEZE_DEADLINE_DAYS) {
        this.logger.warn(
          `Journée ${date} gelée à l'échéance malgré ${completeness.missingCount} match(s) sans stats et ${completeness.pendingCount} non terminé(s)`,
        );
        await this.freezeDay(date, 'deadline');
        frozen.push(date);
      }
    }
    if (frozen.length > 0) {
      this.logger.log(`Journées gelées : ${frozen.join(', ')}`);
    }
    return frozen;
  }

  /**
   * Gèle une journée : dernier re-score complet (notes des matchs du jour puis
   * scores de rosters, avec les distributions courantes) puis pose du gel —
   * l'état figé est le meilleur calcul disponible.
   */
  async freezeDay(date: string, reason: 'complete' | 'deadline' | 'manual'): Promise<void> {
    if ((await this.frozenDates()).has(date)) return;
    const completeness = await this.data.dayCompleteness(date).catch(() => null);
    if (completeness && completeness.scoredMatchIds.length > 0) {
      const distributions = await this.ensureDistributions();
      for (const matchId of completeness.scoredMatchIds) {
        const match = await this.data.getMatch(matchId).catch(() => null);
        if (match) await this.scorePlayers(match, distributions);
      }
      await this.updateRosterScoresForDate(date);
    }
    await this.prisma.frozenMatchDay.upsert({
      where: { date },
      create: { date, reason },
      update: { reason },
    });
    this.invalidateFrozenCache();
    this.logger.log(`Journée ${date} gelée (${reason}) : notes et scores immuables`);
  }

  /** Dégel manuel d'une journée : la seule porte de sortie du gel absolu. */
  async unfreezeDay(date: string): Promise<void> {
    await this.prisma.frozenMatchDay.deleteMany({ where: { date } });
    this.invalidateFrozenCache();
    this.logger.warn(`Journée ${date} dégelée : ses notes redeviennent recalculables`);
  }

  /** Journées gelées (admin). */
  listFrozenDays() {
    return this.prisma.frozenMatchDay.findMany({ orderBy: { date: 'desc' } });
  }

  /** Purge des scores d'un utilisateur supprimé. */
  async removeUserScores(userId: string): Promise<void> {
    await this.prisma.rosterScore.deleteMany({ where: { userId } });
  }

  /** Purge des scores d'une ligue supprimée, ou d'un membre qui la quitte. */
  async removeLeagueScores(leagueId: string, userId?: string): Promise<void> {
    await this.prisma.rosterScore.deleteMany({
      where: { leagueId, ...(userId ? { userId } : {}) },
    });
  }

  /** Points fantasy d'une liste de joueurs (détail par match). */
  playerPoints(playerIds: string[]) {
    if (playerIds.length === 0) return [];
    return this.prisma.fantasyPoints.findMany({
      where: { playerId: { in: playerIds } },
      orderBy: { computedAt: 'desc' },
      take: 500,
    });
  }
}
