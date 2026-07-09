import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OAuthProvider, PublicUser, RegisterInput } from '@esfl/contracts';
import type { User } from '../../generated/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma.service';

/** Le client Prisma omet `avatar` par défaut : on manipule le modèle sans les octets. */
export type SafeUser = Omit<User, 'avatar'>;

export function toPublicUser(user: SafeUser): PublicUser {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    createdAt: user.createdAt.toISOString(),
    avatarUrl: user.avatarMime ? `/auth/users/${user.id}/avatar` : null,
  };
}

export interface OAuthProfile {
  providerAccountId: string;
  email: string | null;
  usernameHint: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async register(input: RegisterInput): Promise<SafeUser> {
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ email: input.email }, { username: input.username }] },
    });
    if (existing) {
      throw new ConflictException(
        existing.email === input.email ? 'Email déjà utilisé' : 'Pseudo déjà utilisé',
      );
    }
    const passwordHash = await argon2.hash(input.password);
    return this.prisma.user.create({
      data: {
        email: input.email,
        username: input.username,
        credential: { create: { passwordHash } },
      },
    });
  }

  async validateLogin(email: string, password: string): Promise<SafeUser> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { credential: true },
    });
    if (!user?.credential) {
      throw new UnauthorizedException('Identifiants invalides');
    }
    const valid = await argon2.verify(user.credential.passwordHash, password);
    if (!valid) {
      throw new UnauthorizedException('Identifiants invalides');
    }
    return user;
  }

  getById(id: string): Promise<SafeUser | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  /** Pseudos et avatars publics par id (classements, listes de membres). */
  async listPublicUsers(
    ids: string[],
  ): Promise<Array<{ id: string; username: string; avatarUrl: string | null }>> {
    if (ids.length === 0) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids.slice(0, 200) } },
      select: { id: true, username: true, avatarMime: true },
    });
    return users.map((user) => ({
      id: user.id,
      username: user.username,
      avatarUrl: user.avatarMime ? `/auth/users/${user.id}/avatar` : null,
    }));
  }

  /** Changement de pseudo (unicité vérifiée). */
  async updateUsername(userId: string, username: string): Promise<SafeUser> {
    const taken = await this.prisma.user.findUnique({ where: { username } });
    if (taken && taken.id !== userId) {
      throw new ConflictException('Pseudo déjà utilisé');
    }
    return this.prisma.user.update({ where: { id: userId }, data: { username } });
  }

  /** Change (ou crée, pour un compte OAuth) le mot de passe. */
  async changePassword(
    userId: string,
    currentPassword: string | undefined,
    newPassword: string,
  ): Promise<void> {
    const credential = await this.prisma.credential.findUnique({ where: { userId } });
    if (credential) {
      if (!currentPassword || !(await argon2.verify(credential.passwordHash, currentPassword))) {
        throw new UnauthorizedException('Mot de passe actuel incorrect');
      }
    }
    const passwordHash = await argon2.hash(newPassword);
    await this.prisma.credential.upsert({
      where: { userId },
      create: { userId, passwordHash },
      update: { passwordHash },
    });
  }

  async setAvatar(userId: string, buffer: Buffer, mime: string): Promise<void> {
    if (!mime.startsWith('image/')) {
      throw new BadRequestException('Le fichier doit être une image');
    }
    await this.prisma.user.update({
      where: { id: userId },
      // Copie dans un Uint8Array « pur » : le type Buffer de Node 24 ne
      // satisfait plus le type Bytes de Prisma.
      data: { avatar: new Uint8Array(buffer), avatarMime: mime },
    });
  }

  async getAvatar(userId: string): Promise<{ avatar: Buffer; mime: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { avatar: true, avatarMime: true },
    });
    if (!user?.avatar || !user.avatarMime) {
      throw new NotFoundException('Pas d’avatar');
    }
    return { avatar: Buffer.from(user.avatar), mime: user.avatarMime };
  }

  /**
   * Suppression de compte : nettoie d'abord fantasy (transfert des ligues au
   * plus ancien membre) et scoring, puis supprime l'utilisateur (cascades
   * credentials/oauth/refresh tokens). Les nettoyages distants sont best-effort.
   */
  async deleteAccount(userId: string): Promise<void> {
    const fantasyUrl = this.config.get<string>('FANTASY_SERVICE_URL') ?? 'http://localhost:4003';
    const scoringUrl = this.config.get<string>('SCORING_SERVICE_URL') ?? 'http://localhost:4004';
    for (const url of [
      `${fantasyUrl}/fantasy/internal/users/${userId}`,
      `${scoringUrl}/scoring/internal/users/${userId}`,
    ]) {
      try {
        const response = await fetch(url, { method: 'DELETE' });
        if (!response.ok) {
          this.logger.warn(`Nettoyage ${url} → ${response.status}`);
        }
      } catch (error) {
        this.logger.warn(`Nettoyage ${url} injoignable : ${String(error)}`);
      }
    }
    await this.prisma.user.delete({ where: { id: userId } });
  }

  /**
   * Connexion OAuth : retrouve le compte lié, sinon rattache par email,
   * sinon crée un nouvel utilisateur avec un pseudo dérivé du profil.
   */
  async findOrCreateOAuthUser(provider: OAuthProvider, profile: OAuthProfile): Promise<SafeUser> {
    const account = await this.prisma.oAuthAccount.findUnique({
      where: {
        provider_providerAccountId: { provider, providerAccountId: profile.providerAccountId },
      },
      include: { user: true },
    });
    if (account) {
      return account.user;
    }

    if (profile.email) {
      const byEmail = await this.prisma.user.findUnique({ where: { email: profile.email } });
      if (byEmail) {
        await this.prisma.oAuthAccount.create({
          data: {
            provider,
            providerAccountId: profile.providerAccountId,
            userId: byEmail.id,
          },
        });
        return byEmail;
      }
    }

    const username = await this.availableUsername(profile.usernameHint);
    return this.prisma.user.create({
      data: {
        email: profile.email ?? `${provider}-${profile.providerAccountId}@no-email.esfl`,
        username,
        oauthAccounts: {
          create: { provider, providerAccountId: profile.providerAccountId },
        },
      },
    });
  }

  private async availableUsername(hint: string): Promise<string> {
    const base =
      hint
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '')
        .slice(0, 16) || 'joueur';
    let candidate = base;
    for (let i = 0; ; i += 1) {
      const taken = await this.prisma.user.findUnique({ where: { username: candidate } });
      if (!taken) return candidate;
      candidate = `${base}${Math.floor(Math.random() * 10_000)}`;
      if (i > 20) {
        return `${base}${Date.now()}`;
      }
    }
  }
}
