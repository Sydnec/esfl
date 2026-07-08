import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { OAuthProvider, PublicUser, RegisterInput } from '@esfl/contracts';
import type { User } from '../../generated/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma.service';

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    createdAt: user.createdAt.toISOString(),
  };
}

export interface OAuthProfile {
  providerAccountId: string;
  email: string | null;
  usernameHint: string;
}

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async register(input: RegisterInput): Promise<User> {
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

  async validateLogin(email: string, password: string): Promise<User> {
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

  getById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  /**
   * Connexion OAuth : retrouve le compte lié, sinon rattache par email,
   * sinon crée un nouvel utilisateur avec un pseudo dérivé du profil.
   */
  async findOrCreateOAuthUser(provider: OAuthProvider, profile: OAuthProfile): Promise<User> {
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
