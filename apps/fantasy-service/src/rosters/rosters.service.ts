import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { parisDate } from '@esfl/contracts';
import type { League, MatchDay } from '../../generated/client';
import { DataClient, DataMatch, DataPlayer } from '../data-client/data.client';
import { PrismaService } from '../prisma.service';
import { isLockedForDay, unlockDate } from './lock';

const PAST_WINDOW_MS = 90 * 24 * 3600 * 1000;
const FUTURE_WINDOW_MS = 30 * 24 * 3600 * 1000;

export interface PickBoardPlayer extends DataPlayer {
  locked: boolean;
  /** Journée où le joueur redevient disponible (si connue). */
  lockedUntil: string | null;
}

@Injectable()
export class RostersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly data: DataClient,
  ) {}

  /**
   * Matérialise les journées de la ligue à partir du planning des compétitions
   * suivies : une journée par date Europe/Paris ayant au moins un match.
   */
  async ensureMatchDays(league: League & { competitions: { competitionId: string }[] }) {
    const competitionIds = league.competitions.map((entry) => entry.competitionId);
    if (competitionIds.length === 0) return;

    const from = new Date(
      Math.max(league.createdAt.getTime() - 24 * 3600 * 1000, Date.now() - PAST_WINDOW_MS),
    );
    const to = new Date(Date.now() + FUTURE_WINDOW_MS);
    const matches = await this.data.listMatches(competitionIds, from, to);

    const firstMatchByDate = new Map<string, Date>();
    for (const match of matches) {
      const start = match.beginAt ?? match.scheduledAt;
      if (!start || match.status === 'canceled') continue;
      const startDate = new Date(start);
      const date = parisDate(startDate);
      const current = firstMatchByDate.get(date);
      if (!current || startDate < current) {
        firstMatchByDate.set(date, startDate);
      }
    }

    for (const [date, firstMatchAt] of firstMatchByDate) {
      await this.prisma.matchDay.upsert({
        where: { leagueId_date: { leagueId: league.id, date } },
        create: { leagueId: league.id, date, firstMatchAt },
        update: { firstMatchAt },
      });
    }
  }

  async listMatchDays(leagueId: string, userId: string) {
    const league = await this.memberLeague(leagueId, userId);
    await this.ensureMatchDays(league);
    const days = await this.prisma.matchDay.findMany({
      where: { leagueId },
      orderBy: { date: 'asc' },
      include: { rosters: { where: { userId }, select: { id: true } } },
    });
    return days.map((day) => ({
      id: day.id,
      date: day.date,
      firstMatchAt: day.firstMatchAt,
      deadlinePassed: day.firstMatchAt <= new Date(),
      myRosterSubmitted: day.rosters.length > 0,
    }));
  }

  /**
   * Joueurs alignables une journée donnée : uniquement ceux dont l'équipe
   * dispute un match ce jour-là (et pas tout le vivier des compétitions
   * suivies), plus les matchs du jour pour l'affichage.
   */
  private async dayContext(
    league: League & { competitions: { competitionId: string }[] },
    day: MatchDay,
  ): Promise<{ players: DataPlayer[]; matches: DataMatch[] }> {
    const competitionIds = league.competitions.map((entry) => entry.competitionId);
    const dayStart = new Date(`${day.date}T00:00:00Z`);
    const [allPlayers, windowMatches] = await Promise.all([
      this.data.listPlayers(competitionIds),
      this.data.listMatches(
        competitionIds,
        new Date(dayStart.getTime() - 12 * 3600 * 1000),
        new Date(dayStart.getTime() + 36 * 3600 * 1000),
      ),
    ]);
    const matches = windowMatches.filter((match) => {
      const start = match.beginAt ?? match.scheduledAt;
      return start && match.status !== 'canceled' && parisDate(new Date(start)) === day.date;
    });
    const playingTeamIds = new Set(
      matches.flatMap((match) => [match.teamAId, match.teamBId]).filter(Boolean),
    );
    const players = allPlayers.filter(
      (player) => player.team && playingTeamIds.has(player.team.id),
    );
    return { players, matches };
  }

  /** Écran de pick : joueurs éligibles avec état de verrouillage + mon roster. */
  async getPickBoard(leagueId: string, matchDayId: string, userId: string) {
    const league = await this.memberLeague(leagueId, userId);
    const day = await this.matchDay(leagueId, matchDayId);

    const [{ players, matches }, leagueDays, myPastPicks, myRoster] = await Promise.all([
      this.dayContext(league, day),
      this.prisma.matchDay.findMany({ where: { leagueId }, select: { date: true } }),
      this.pastPicksByPlayer(league.id, userId),
      this.prisma.roster.findUnique({
        where: { matchDayId_userId: { matchDayId: day.id, userId } },
        include: { picks: true },
      }),
    ]);

    const leagueDayDates = leagueDays.map((d) => d.date);
    const board: PickBoardPlayer[] = players.map((player) => {
      const lastPickDate = myPastPicks.get(player.id);
      const locked = lastPickDate
        ? isLockedForDay({
            leagueDayDates,
            sourceDate: lastPickDate,
            targetDate: day.date,
            lockMatchDays: league.lockMatchDays,
          })
        : false;
      return {
        ...player,
        locked,
        lockedUntil:
          locked && lastPickDate
            ? unlockDate({
                leagueDayDates,
                sourceDate: lastPickDate,
                lockMatchDays: league.lockMatchDays,
              })
            : null,
      };
    });

    return {
      matchDay: {
        id: day.id,
        date: day.date,
        firstMatchAt: day.firstMatchAt,
        deadlinePassed: day.firstMatchAt <= new Date(),
      },
      rosterSize: league.rosterSize,
      lockMatchDays: league.lockMatchDays,
      myPicks: myRoster?.picks.map((pick) => pick.playerId) ?? [],
      players: board,
      matches: matches.map((match) => ({
        id: match.id,
        gameId: match.gameId,
        name: match.name,
        scheduledAt: match.scheduledAt,
        teamAId: match.teamAId,
        teamBId: match.teamBId,
      })),
    };
  }

  async submitRoster(leagueId: string, matchDayId: string, userId: string, playerIds: string[]) {
    const league = await this.memberLeague(leagueId, userId);
    const day = await this.matchDay(leagueId, matchDayId);

    if (day.firstMatchAt <= new Date()) {
      throw new BadRequestException('La deadline de cette journée est passée');
    }
    const unique = [...new Set(playerIds)];
    if (unique.length !== playerIds.length) {
      throw new BadRequestException('Un joueur ne peut apparaître qu’une fois dans le roster');
    }
    if (playerIds.length > league.rosterSize) {
      throw new BadRequestException(`Le roster est limité à ${league.rosterSize} joueurs`);
    }

    const [{ players: eligiblePlayers }, leagueDays, myPastPicks] = await Promise.all([
      this.dayContext(league, day),
      this.prisma.matchDay.findMany({ where: { leagueId }, select: { date: true } }),
      this.pastPicksByPlayer(league.id, userId, day.date),
    ]);
    const eligibleById = new Map(eligiblePlayers.map((player) => [player.id, player]));
    const leagueDayDates = leagueDays.map((d) => d.date);

    for (const playerId of playerIds) {
      const player = eligibleById.get(playerId);
      if (!player) {
        throw new BadRequestException(
          `Joueur inéligible pour cette journée (son équipe ne joue pas) : ${playerId}`,
        );
      }
      const lastPickDate = myPastPicks.get(playerId);
      if (
        lastPickDate &&
        isLockedForDay({
          leagueDayDates,
          sourceDate: lastPickDate,
          targetDate: day.date,
          lockMatchDays: league.lockMatchDays,
        })
      ) {
        throw new BadRequestException(`${player.name} est encore verrouillé pour cette journée`);
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const roster = await tx.roster.upsert({
        where: { matchDayId_userId: { matchDayId: day.id, userId } },
        create: { leagueId, matchDayId: day.id, userId },
        update: {},
      });
      await tx.rosterPick.deleteMany({ where: { rosterId: roster.id } });
      await tx.rosterPick.createMany({
        data: playerIds.map((playerId) => ({
          rosterId: roster.id,
          playerId,
          gameId: eligibleById.get(playerId)?.gameId ?? 'unknown',
        })),
      });
      return tx.roster.findUniqueOrThrow({
        where: { id: roster.id },
        include: { picks: true },
      });
    });
  }

  /** Rosters d'une journée pour le scoring (endpoint interne). */
  async listRostersForDate(date: string) {
    return this.prisma.roster.findMany({
      where: { matchDay: { date, firstMatchAt: { lte: new Date() } } },
      include: {
        picks: true,
        matchDay: { select: { date: true } },
        league: { select: { id: true, competitions: { select: { competitionId: true } } } },
      },
    });
  }

  /** Dernière journée (avant targetDate) où chaque joueur a été aligné par l'utilisateur. */
  private async pastPicksByPlayer(
    leagueId: string,
    userId: string,
    beforeDate?: string,
  ): Promise<Map<string, string>> {
    const picks = await this.prisma.rosterPick.findMany({
      where: {
        roster: {
          leagueId,
          userId,
          ...(beforeDate ? { matchDay: { date: { lt: beforeDate } } } : {}),
        },
      },
      include: { roster: { include: { matchDay: { select: { date: true } } } } },
    });
    const lastPick = new Map<string, string>();
    for (const pick of picks) {
      const date = pick.roster.matchDay.date;
      const current = lastPick.get(pick.playerId);
      if (!current || date > current) {
        lastPick.set(pick.playerId, date);
      }
    }
    return lastPick;
  }

  private async memberLeague(leagueId: string, userId: string) {
    const league = await this.prisma.league.findUnique({
      where: { id: leagueId },
      include: { members: true, competitions: true },
    });
    if (!league) {
      throw new NotFoundException('Ligue introuvable');
    }
    if (!league.members.some((member) => member.userId === userId)) {
      throw new ForbiddenException('Tu n’es pas membre de cette ligue');
    }
    return league;
  }

  private async matchDay(leagueId: string, matchDayId: string): Promise<MatchDay> {
    const day = await this.prisma.matchDay.findUnique({ where: { id: matchDayId } });
    if (!day || day.leagueId !== leagueId) {
      throw new NotFoundException('Journée introuvable dans cette ligue');
    }
    return day;
  }
}
