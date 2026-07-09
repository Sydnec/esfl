import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CreateLeagueInput, UpdateLeagueInput } from '@esfl/contracts';
import type { League } from '../../generated/client';
import { DataClient } from '../data-client/data.client';
import { PrismaService } from '../prisma.service';
import { ScoringClient } from '../scoring-client/scoring.client';
import { decideMemberRemoval } from './membership';

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
    private readonly scoring: ScoringClient,
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

  /**
   * Suppression d'un utilisateur (appel interne depuis auth-service) :
   * ses ligues sont transférées au plus ancien autre membre (supprimées s'il
   * était seul), ses rosters et participations sont effacés.
   */
  async removeUser(userId: string): Promise<void> {
    const ownedLeagues = await this.prisma.league.findMany({
      where: { ownerId: userId },
      include: { members: { orderBy: { joinedAt: 'asc' } } },
    });
    for (const league of ownedLeagues) {
      const heir = league.members.find((member) => member.userId !== userId);
      if (!heir) {
        await this.prisma.league.delete({ where: { id: league.id } });
        continue;
      }
      await this.prisma.league.update({
        where: { id: league.id },
        data: { ownerId: heir.userId },
      });
      await this.prisma.leagueMember.update({
        where: { leagueId_userId: { leagueId: league.id, userId: heir.userId } },
        data: { role: 'owner' },
      });
    }
    await this.prisma.roster.deleteMany({ where: { userId } });
    await this.prisma.leagueMember.deleteMany({ where: { userId } });
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

  /** Ligue dont l'utilisateur est le créateur, sinon 403. */
  private async ownerLeague(leagueId: string, userId: string) {
    const league = await this.getForMember(leagueId, userId);
    if (league.ownerId !== userId) {
      throw new ForbiddenException('Réservé au créateur de la ligue');
    }
    return league;
  }

  /** Ajout d'une compétition en cours de ligue — réservé au créateur. */
  async addCompetition(leagueId: string, userId: string, competitionId: string) {
    await this.ownerLeague(leagueId, userId);
    await this.data.getCompetition(competitionId);
    await this.prisma.leagueCompetition.upsert({
      where: { leagueId_competitionId: { leagueId, competitionId } },
      create: { leagueId, competitionId },
      update: {},
    });
    this.data.triggerCompetitionSync(competitionId);
    return this.getForMember(leagueId, userId);
  }

  /**
   * Réglages de la ligue — réservé au créateur. lockMatchDays étant évalué
   * en live sur les picks passés, le changer re-verrouille/libère
   * rétroactivement ; rosterSize réduit ne rétrécit pas les rosters déjà
   * soumis (borne appliquée au prochain submit). Assumé.
   */
  async updateSettings(leagueId: string, userId: string, input: UpdateLeagueInput) {
    await this.ownerLeague(leagueId, userId);
    await this.prisma.league.update({ where: { id: leagueId }, data: input });
    return this.getForMember(leagueId, userId);
  }

  /** Retrait d'une compétition suivie — réservé au créateur, minimum une. */
  async removeCompetition(leagueId: string, userId: string, competitionId: string) {
    const league = await this.ownerLeague(leagueId, userId);
    if (!league.competitions.some((entry) => entry.competitionId === competitionId)) {
      throw new NotFoundException('Cette compétition n’est pas suivie par la ligue');
    }
    if (league.competitions.length <= 1) {
      throw new BadRequestException('Une ligue doit suivre au moins une compétition');
    }
    // Les points déjà calculés sur ses matchs restent (resynchronisables via
    // le recompute-all du scoring).
    await this.prisma.leagueCompetition.delete({
      where: { leagueId_competitionId: { leagueId, competitionId } },
    });
    return this.getForMember(leagueId, userId);
  }

  /** Exclusion par le owner (target ≠ soi) ou départ volontaire (target = soi). */
  async removeMember(leagueId: string, actorId: string, targetId: string) {
    const league = await this.getForMember(leagueId, actorId);
    const decision = decideMemberRemoval(actorId, targetId, league.ownerId, league.members);

    switch (decision.kind) {
      case 'forbidden':
        throw new ForbiddenException(decision.reason);
      case 'quit-delete':
        await this.prisma.league.delete({ where: { id: leagueId } });
        this.scoring.removeLeagueScores(leagueId);
        return { ok: true, leagueDeleted: true };
      case 'quit-transfer':
        await this.prisma.league.update({
          where: { id: leagueId },
          data: { ownerId: decision.heirUserId },
        });
        await this.prisma.leagueMember.update({
          where: { leagueId_userId: { leagueId, userId: decision.heirUserId } },
          data: { role: 'owner' },
        });
        break;
      case 'kick':
      case 'quit':
        break;
    }

    await this.prisma.roster.deleteMany({ where: { leagueId, userId: targetId } });
    await this.prisma.leagueMember.delete({
      where: { leagueId_userId: { leagueId, userId: targetId } },
    });
    this.scoring.removeLeagueScores(leagueId, targetId);
    return { ok: true, leagueDeleted: false };
  }

  /** Suppression de la ligue — réservé au créateur. Cascade Prisma complète. */
  async deleteLeague(leagueId: string, userId: string) {
    await this.ownerLeague(leagueId, userId);
    await this.prisma.league.delete({ where: { id: leagueId } });
    this.scoring.removeLeagueScores(leagueId);
    return { ok: true };
  }
}
