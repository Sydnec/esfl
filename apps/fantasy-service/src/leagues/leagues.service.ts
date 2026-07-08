import { randomBytes } from 'node:crypto';
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CreateLeagueInput } from '@esfl/contracts';
import type { League } from '../../generated/client';
import { DataClient } from '../data-client/data.client';
import { PrismaService } from '../prisma.service';

/** Alphabet sans caractères ambigus (0/O, 1/I/L). */
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateInviteCode(): string {
  const bytes = randomBytes(8);
  return [...bytes].map((byte) => INVITE_ALPHABET[byte % INVITE_ALPHABET.length]).join('');
}

@Injectable()
export class LeaguesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly data: DataClient,
  ) {}

  async create(ownerId: string, input: CreateLeagueInput): Promise<League> {
    // Valide que chaque compétition existe dans le référentiel.
    await Promise.all(input.competitionIds.map((id) => this.data.getCompetition(id)));

    const league = await this.prisma.league.create({
      data: {
        name: input.name,
        inviteCode: generateInviteCode(),
        ownerId,
        rosterSize: input.rosterSize,
        lockMatchDays: input.lockMatchDays,
        members: { create: { userId: ownerId, role: 'owner' } },
        competitions: {
          create: input.competitionIds.map((competitionId) => ({ competitionId })),
        },
      },
      include: { competitions: true, members: true },
    });
    // Fire-and-forget : le data-service synchronise matchs + rosters sans
    // attendre le prochain cycle planifié.
    for (const competitionId of input.competitionIds) {
      this.data.triggerCompetitionSync(competitionId);
    }
    return league;
  }

  /** Compétitions suivies par au moins une ligue — consommé par le data-service. */
  async followedCompetitionIds(): Promise<string[]> {
    const rows = await this.prisma.leagueCompetition.findMany({
      select: { competitionId: true },
      distinct: ['competitionId'],
    });
    return rows.map((row) => row.competitionId);
  }

  myLeagues(userId: string) {
    return this.prisma.league.findMany({
      where: { members: { some: { userId } } },
      include: {
        competitions: true,
        _count: { select: { members: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getForMember(leagueId: string, userId: string) {
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

  async join(inviteCode: string, userId: string) {
    const league = await this.prisma.league.findUnique({ where: { inviteCode } });
    if (!league) {
      throw new NotFoundException('Code d’invitation inconnu');
    }
    await this.prisma.leagueMember.upsert({
      where: { leagueId_userId: { leagueId: league.id, userId } },
      create: { leagueId: league.id, userId, role: 'member' },
      update: {},
    });
    return this.getForMember(league.id, userId);
  }

  /** Ajout d'une compétition en cours de ligue — réservé au créateur. */
  async addCompetition(leagueId: string, userId: string, competitionId: string) {
    const league = await this.getForMember(leagueId, userId);
    if (league.ownerId !== userId) {
      throw new ForbiddenException('Seul le créateur peut ajouter une compétition');
    }
    await this.data.getCompetition(competitionId);
    await this.prisma.leagueCompetition.upsert({
      where: { leagueId_competitionId: { leagueId, competitionId } },
      create: { leagueId, competitionId },
      update: {},
    });
    this.data.triggerCompetitionSync(competitionId);
    return this.getForMember(leagueId, userId);
  }
}
