import { Injectable, Logger } from '@nestjs/common';
import { GameId, parisDate, FREEZE_DEADLINE_DAYS } from '@esfl/contracts';
import {
  MatchScoringContext,
  PlayerStatLine,
  roundsPlayed,
  scoreMatch,
  SCORING_VERSION,
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
/**
 * Horizon du rattrapage des matchs restés sans note : celui du gel. Au-delà,
 * toutes les journées sont gelées et l'absence de note est voulue — les
 * re-sonder à chaque heure ne ferait que du bruit.
 */
const SCORE_BACKFILL_DAYS = FREEZE_SCAN_DAYS;
/** Matchs rattrapés par passage : un arriéré s'écoule sur plusieurs tirs. */
const SCORE_BACKFILL_BATCH = 50;
/** TTL du cache mémoire des dates gelées. */
const FROZEN_CACHE_TTL_MS = 60_000;

/**
 * Picks qui entrent dans la moyenne du jour.
 *
 * Un pick sans note dont le match n'a PAS été récupéré en sort, numérateur et
 * dénominateur : le trou est de notre côté, le manager n'a pas à le payer.
 * Celui dont le match est bien récupéré garde son 0, il n'a réellement pas
 * joué. Un joueur qui a une note ailleurs le même jour reste compté.
 */
export function picksComptes(
  playerIds: string[],
  notes: Map<string, number>,
  nonCouverts: Set<string>,
): string[] {
  return playerIds.filter((id) => notes.has(id) || !nonCouverts.has(id));
}

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
   * porte de sortie, le dégel manuel de la date. C'est l'échéance du gel
   * (`FREEZE_DEADLINE_DAYS`), et elle seule, qui décide combien de temps une
   * stat tardive peut encore produire une note.
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
  async computeForMatch(
    matchId: string,
  ): Promise<{ playersScored: number; rostersUpdated: number }> {
    const match = await this.data.getMatch(matchId);
    // Journée gelée : ses notes sont immuables (stats.ingested tardif ou
    // recompute admin compris). Dégeler la date d'abord pour corriger.
    const date = this.matchDate(match);
    if (date && (await this.frozenDates()).has(date)) {
      this.logger.log(`${match.name} : journée ${date} gelée, recalcul ignoré`);
      return { playersScored: 0, rostersUpdated: 0 };
    }
    const playersScored = await this.scorePlayers(match);
    const rostersUpdated = await this.updateRosterScores(match);
    this.logger.log(
      `${match.name} : ${playersScored} joueurs notés, ${rostersUpdated} rosters mis à jour`,
    );
    return { playersScored, rostersUpdated };
  }

  /**
   * Rattrapage des matchs restés SANS note alors que leurs stats sont en base.
   *
   * `stats.ingested` est le seul déclencheur du scoring : un scoring-service
   * indisponible au moment de la publication (déploiement, redémarrage) ou une
   * lecture data en échec, et le match n'est plus jamais noté — ses stats
   * s'affichent pourtant sur la fiche du joueur, colonne « Pts fantasy » vide.
   * Ce balayage horaire compare les matchs terminés ayant des stats aux matchs
   * notés et comble l'écart, tant que la journée n'est pas gelée : passé
   * l'échéance, l'absence de note est une décision, pas un trou.
   *
   * Borné en fenêtre et en volume : un arriéré s'écoule sur plusieurs passages
   * plutôt que de saturer le data-service d'un coup.
   */
  async backfillMissingScores(): Promise<{ missing: number; scored: number }> {
    const since = new Date(Date.now() - SCORE_BACKFILL_DAYS * 24 * 3600 * 1000);
    const avecStats = await this.data.listStatsMatchIds(since);
    if (avecStats.length === 0) return { missing: 0, scored: 0 };
    const notes = await this.prisma.fantasyPoints.findMany({
      where: { matchId: { in: avecStats } },
      distinct: ['matchId'],
      select: { matchId: true },
    });
    const dejaNotes = new Set(notes.map((row) => row.matchId));
    const manquants = avecStats.filter((matchId) => !dejaNotes.has(matchId));
    if (manquants.length === 0) return { missing: 0, scored: 0 };

    let scored = 0;
    for (const matchId of manquants.slice(0, SCORE_BACKFILL_BATCH)) {
      // Un match introuvable côté data (fiche supprimée) ou un échec ponctuel
      // ne doit pas emporter le reste du lot : le prochain tir le reverra.
      // `computeForMatch` refuse de lui-même les journées gelées.
      const result = await this.computeForMatch(matchId).catch((error) => {
        this.logger.warn(`Rattrapage de note impossible pour ${matchId} : ${String(error)}`);
        return null;
      });
      if (result && result.playersScored > 0) scored += 1;
    }
    this.logger.log(
      `Rattrapage des notes : ${manquants.length} match(s) sans note, ${scored} noté(s) sur ce passage`,
    );
    return { missing: manquants.length, scored };
  }

  /**
   * Recalcule tous les points fantasy avec la formule courante (matchs ayant
   * déjà des points ou des stats), puis les rosters des journées touchées.
   * Coût : lectures internes data-service uniquement, aucune API externe.
   */
  async recomputeAll(): Promise<{ matches: number; playersScored: number; datesUpdated: number }> {
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
      playersScored += await this.scorePlayers(match);
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
  async resetAndRecompute(): Promise<{
    matches: number;
    playersScored: number;
    datesUpdated: number;
  }> {
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
   * Note (upsert) tous les joueurs d'un match via le systeme absolu v4 : rating
   * de base par joueur, puis bonus contextuels (le roster complet est charge
   * d'un coup, requis pour les bonus relatifs). Rounds tires des scores de map.
   */
  /**
   * Rattache à la fiche gardée les notes des fiches absorbées par une fusion.
   *
   * On TRANSFÈRE plutôt que de re-noter : une journée gelée refuse tout
   * recalcul, si bien que ses notes resteraient à vie accrochées à une fiche
   * supprimée. Le transfert préserve en outre la note telle qu'elle a été
   * calculée à l'époque, ce que le gel garantit justement.
   *
   * Même contrainte que côté stats : l'index unique (match, joueur) interdit
   * deux notes du même joueur sur un match. Quand la fiche gardée en a déjà
   * une, celle de l'absorbée est écartée — la gardée fait foi.
   */
  async reassignPoints(keepId: string, absorbedIds: string[]): Promise<number> {
    if (absorbedIds.length === 0) return 0;
    // Transaction, comme `reassignPlayerStats` : entre la purge des conflits et
    // le transfert, une interruption détruirait des notes sans les remplacer,
    // et la fiche absorbée est supprimée juste après côté data — irrécupérable.
    const count = await this.prisma.$transaction(async (tx) => {
      const gardees = await tx.fantasyPoints.findMany({
        where: { playerId: keepId },
        select: { matchId: true },
      });
      const dejaNotes = new Set(gardees.map((row) => row.matchId));
      const entrantes = await tx.fantasyPoints.findMany({
        where: { playerId: { in: absorbedIds } },
        select: { id: true, matchId: true },
      });
      const conflits = entrantes.filter((row) => dejaNotes.has(row.matchId)).map((row) => row.id);
      if (conflits.length > 0) {
        await tx.fantasyPoints.deleteMany({ where: { id: { in: conflits } } });
      }
      const { count: transferees } = await tx.fantasyPoints.updateMany({
        where: { playerId: { in: absorbedIds } },
        data: { playerId: keepId },
      });
      return transferees;
    });
    if (count > 0) {
      this.logger.log(`Fusion : ${count} note(s) transférée(s) vers ${keepId}`);
    }
    return count;
  }

  private async scorePlayers(match: DataMatch): Promise<number> {
    const stats = await this.data.listStats([match.id]);
    if (stats.length === 0) return 0;

    const byId = new Map(stats.map((stat) => [stat.playerId, stat]));
    const players: PlayerStatLine[] = stats.map((stat) => ({
      playerId: stat.playerId,
      gameId: stat.gameId as GameId,
      normalized: stat.normalized,
      role: stat.role,
      teamSide: stat.teamSide,
    }));
    const ctx: MatchScoringContext = {
      rounds: roundsPlayed(match),
      teamObjectives: match.teamObjectives ?? null,
    };

    const scores = scoreMatch(players, ctx);
    // Notes devenues sans objet : le joueur n'apparaît plus dans les stats du
    // match, typiquement parce que sa fiche a été absorbée par une fusion. Sans
    // ce ménage elles survivent à la fiche supprimée, faussent les analytics et
    // privent la fiche gardée de son historique.
    const { count: obsoletes } = await this.prisma.fantasyPoints.deleteMany({
      where: { matchId: match.id, playerId: { notIn: scores.map((s) => s.playerId) } },
    });
    if (obsoletes > 0) {
      this.logger.log(`${match.name} : ${obsoletes} note(s) obsolète(s) retirée(s)`);
    }
    let playersScored = 0;
    for (const score of scores) {
      const gameId = byId.get(score.playerId)?.gameId ?? match.gameId;
      await this.prisma.fantasyPoints.upsert({
        where: { matchId_playerId: { matchId: match.id, playerId: score.playerId } },
        create: {
          matchId: match.id,
          playerId: score.playerId,
          gameId,
          points: score.points,
          breakdown: score.breakdown,
          version: SCORING_VERSION,
        },
        update: { points: score.points, breakdown: score.breakdown, version: SCORING_VERSION },
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
    // Joueurs pénalisés par un trou de récupération, une fois pour la journée.
    // Indisponible (data-service muet) : ensemble vide, donc comportement
    // inchangé plutôt qu'une exclusion hasardeuse.
    const nonCouverts = new Set(
      (await this.data.dayCompleteness(date, true).catch(() => null))?.uncoveredPlayerIds ?? [],
    );
    // Matchs de la journée par ligue (mémoïsé par ligue).
    const dayMatchesByLeague = new Map<string, string[]>();
    for (const roster of impacted) {
      const leagueId = roster.league.id;
      if (!dayMatchesByLeague.has(leagueId)) {
        const competitionIds = roster.league.competitions.map((entry) => entry.competitionId);
        dayMatchesByLeague.set(leagueId, await this.matchIdsForDate(competitionIds, date));
      }
      updated += await this.scoreRoster(
        roster,
        date,
        dayMatchesByLeague.get(leagueId) ?? [],
        nonCouverts,
      );
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
    nonCouverts: Set<string> = new Set(),
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
    const comptes = picksComptes(playerIds, byPlayer, nonCouverts);
    if (comptes.length === 0) return 0;
    const total = comptes.reduce((sum, id) => sum + (byPlayer.get(id) ?? 0), 0);
    const points = Math.round((total / comptes.length) * 100) / 100;

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
      this.prisma.fantasyPoints.findMany({
        select: { gameId: true, points: true, playerId: true },
      }),
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
      const hist = histByGame.get(row.gameId) ?? {
        buckets: new Array(bucketCount).fill(0),
        count: 0,
        sum: 0,
        min: 100,
        max: 0,
      };
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

    return {
      generatedAt: new Date().toISOString(),
      minScores: MIN_SCORES,
      bucketSize,
      distributions,
      topPlayers,
    };
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
   * (`FREEZE_DEADLINE_DAYS`), gèle quand même : les stats encore manquantes
   * n'arriveront plus. Le gel fige l'état après un dernier re-score complet de
   * la journée.
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
      for (const matchId of completeness.scoredMatchIds) {
        const match = await this.data.getMatch(matchId).catch(() => null);
        if (match) await this.scorePlayers(match);
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

  /**
   * Points fantasy d'une liste de joueurs (détail par match).
   *
   * `matchIds` cible les notes d'un match précis : sans lui, la page match
   * demandait toutes les notes de ses dix joueurs et le plafond de 500 lignes
   * (les plus récemment calculées) pouvait laisser dehors celles d'un match
   * ancien — qui s'affichait alors comme non noté.
   */
  playerPoints(playerIds: string[], matchIds: string[] = []) {
    if (playerIds.length === 0) return [];
    return this.prisma.fantasyPoints.findMany({
      where: {
        playerId: { in: playerIds },
        ...(matchIds.length > 0 ? { matchId: { in: matchIds } } : {}),
      },
      orderBy: { computedAt: 'desc' },
      take: 500,
    });
  }
}
