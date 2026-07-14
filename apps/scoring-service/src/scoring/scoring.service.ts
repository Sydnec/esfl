import { Injectable, Logger } from '@nestjs/common';
import { GameId, parisDate } from '@esfl/contracts';
import { computeScore, mapsPlayed, SCORING_VERSION } from '../calculators/calculators';
import { DataClient, DataMatch } from '../clients/data.client';
import { FantasyClient, FantasyRoster } from '../clients/fantasy.client';
import { PrismaService } from '../prisma.service';

@Injectable()
export class ScoringService {
  private readonly logger = new Logger(ScoringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly data: DataClient,
    private readonly fantasy: FantasyClient,
  ) {}

  /**
   * Recalcule (idempotent) les points fantasy d'un match puis les scores
   * des rosters de la journée correspondante.
   */
  async computeForMatch(matchId: string): Promise<{ playersScored: number; rostersUpdated: number }> {
    const match = await this.data.getMatch(matchId);
    const playersScored = await this.scorePlayers(match);
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
    const fromPoints = await this.prisma.fantasyPoints.findMany({
      distinct: ['matchId'],
      select: { matchId: true },
    });
    const fromStats = await this.data.listStatsMatchIds();
    const matchIds = [...new Set([...fromPoints.map((row) => row.matchId), ...fromStats])];

    let playersScored = 0;
    const dates = new Set<string>();
    for (const matchId of matchIds) {
      // Match disparu côté data : on laisse les points orphelins tels quels.
      const match = await this.data.getMatch(matchId).catch(() => null);
      if (!match) continue;
      playersScored += await this.scorePlayers(match);
      const reference = match.beginAt ?? match.scheduledAt ?? match.endAt;
      if (reference) dates.add(parisDate(new Date(reference)));
    }

    for (const date of dates) {
      await this.updateRosterScoresForDate(date);
    }
    this.logger.log(
      `Recalcul complet (${SCORING_VERSION}) : ${matchIds.length} matchs, ${playersScored} scores, ${dates.size} journées`,
    );
    return { matches: matchIds.length, playersScored, datesUpdated: dates.size };
  }

  /** Note (upsert) tous les joueurs d'un match à partir de ses stats. */
  private async scorePlayers(match: DataMatch): Promise<number> {
    const stats = await this.data.listStats([match.id]);
    const maps = mapsPlayed(match);

    let playersScored = 0;
    for (const stat of stats) {
      const result = computeScore(stat.gameId as GameId, stat.normalized, maps);
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
      _sum: { points: true },
    });
    return rows
      .map((row) => ({
        playerId: row.playerId,
        points: Math.round((row._sum.points ?? 0) * 100) / 100,
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

    const points = await this.prisma.fantasyPoints.aggregate({
      _sum: { points: true },
      where: { matchId: { in: dayMatchIds }, playerId: { in: playerIds } },
    });
    await this.prisma.rosterScore.upsert({
      where: { rosterId: roster.id },
      create: {
        rosterId: roster.id,
        leagueId: roster.league.id,
        userId: roster.userId,
        matchDayDate: date,
        points: points._sum.points ?? 0,
      },
      update: { points: points._sum.points ?? 0 },
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

  /** Scores d'une journée donnée dans une ligue. */
  dayScores(leagueId: string, date: string) {
    return this.prisma.rosterScore.findMany({
      where: { leagueId, matchDayDate: date },
      orderBy: { points: 'desc' },
    });
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
