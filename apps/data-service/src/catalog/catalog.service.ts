import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  /** Ids distincts des matchs ayant au moins une ligne de stats. */
  async distinctStatsMatchIds(): Promise<string[]> {
    const rows = await this.prisma.playerMatchStats.findMany({
      distinct: ['matchId'],
      select: { matchId: true },
    });
    return rows.map((row) => row.matchId);
  }

  listCompetitions(gameId?: string, search?: string) {
    return this.prisma.competition.findMany({
      where: {
        ...(gameId ? { gameId } : {}),
        ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}),
      },
      orderBy: [{ beginAt: 'desc' }],
      take: 100,
    });
  }

  async getCompetition(id: string) {
    const competition = await this.prisma.competition.findUnique({
      where: { id },
      include: { teams: { include: { team: true } } },
    });
    if (!competition) {
      throw new NotFoundException('Compétition introuvable');
    }
    return competition;
  }

  async listMatches(competitionIds: string[], from?: Date, to?: Date) {
    const matches = await this.prisma.match.findMany({
      where: {
        ...(competitionIds.length ? { competitionId: { in: competitionIds } } : {}),
        ...(from || to
          ? { scheduledAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
          : {}),
      },
      orderBy: { scheduledAt: 'asc' },
      take: 500,
      include: { competition: { select: { id: true, name: true, gameId: true } } },
    });

    // teamA/teamB sont des ids sans relation Prisma : on résout en une requête.
    const teamIds = [
      ...new Set(matches.flatMap((m) => [m.teamAId, m.teamBId]).filter((id): id is string => !!id)),
    ];
    const teams = await this.prisma.team.findMany({ where: { id: { in: teamIds } } });
    const byId = new Map(teams.map((team) => [team.id, team]));
    return matches.map((match) => ({
      ...match,
      teamA: match.teamAId ? (byId.get(match.teamAId) ?? null) : null,
      teamB: match.teamBId ? (byId.get(match.teamBId) ?? null) : null,
    }));
  }

  /** Joueurs alignables : ceux des équipes engagées dans les compétitions données. */
  async listPlayers(competitionIds: string[]) {
    if (competitionIds.length === 0) return [];
    const entries = await this.prisma.competitionTeam.findMany({
      where: { competitionId: { in: competitionIds } },
      select: { teamId: true },
    });
    const teamIds = [...new Set(entries.map((entry) => entry.teamId))];
    return this.prisma.player.findMany({
      where: { teamId: { in: teamIds } },
      include: { team: { select: { id: true, name: true, acronym: true, imageUrl: true } } },
      orderBy: [{ gameId: 'asc' }, { name: 'asc' }],
    });
  }

  /** Fiche d'un joueur pro avec son équipe complète (page détail joueur). */
  async getPlayer(id: string) {
    const player = await this.prisma.player.findUnique({
      where: { id },
      include: { team: true },
    });
    if (!player) {
      throw new NotFoundException('Joueur introuvable');
    }
    return player;
  }

  /** Historique d'un joueur : ses stats jointes aux matchs (équipes résolues). */
  async listPlayerMatches(playerId: string) {
    const lines = await this.prisma.playerMatchStats.findMany({
      where: { playerId },
      include: {
        match: { include: { competition: { select: { id: true, name: true, gameId: true } } } },
      },
      orderBy: { match: { scheduledAt: 'desc' } },
      take: 100,
    });

    // teamA/teamB sont des ids sans relation Prisma : on résout en une requête.
    const teamIds = [
      ...new Set(
        lines
          .flatMap((line) => [line.match.teamAId, line.match.teamBId])
          .filter((id): id is string => !!id),
      ),
    ];
    const teams = await this.prisma.team.findMany({ where: { id: { in: teamIds } } });
    const byId = new Map(teams.map((team) => [team.id, team]));
    return lines.map(({ raw: _raw, match, ...line }) => ({
      ...line,
      match: {
        ...match,
        teamA: match.teamAId ? (byId.get(match.teamAId) ?? null) : null,
        teamB: match.teamBId ? (byId.get(match.teamBId) ?? null) : null,
      },
    }));
  }

  /** Résolution de joueurs par ids (noms, équipes, images) — pour les tops de journée. */
  listPlayersByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return this.prisma.player.findMany({
      where: { id: { in: ids.slice(0, 100) } },
      include: { team: { select: { id: true, name: true, acronym: true, imageUrl: true } } },
    });
  }

  listStats(matchIds: string[]) {
    if (matchIds.length === 0) return [];
    return this.prisma.playerMatchStats.findMany({ where: { matchId: { in: matchIds } } });
  }

  /** Détail d'un match avec équipes résolues (page match). */
  async getMatch(id: string) {
    const match = await this.prisma.match.findUnique({
      where: { id },
      include: { competition: true },
    });
    if (!match) return null;
    const teamIds = [match.teamAId, match.teamBId].filter((value): value is string => !!value);
    const teams = await this.prisma.team.findMany({ where: { id: { in: teamIds } } });
    return {
      ...match,
      teamA: teams.find((team) => team.id === match.teamAId) ?? null,
      teamB: teams.find((team) => team.id === match.teamBId) ?? null,
    };
  }
}
