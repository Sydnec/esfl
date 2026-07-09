import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { AccessTokenPayload } from '@esfl/contracts';
import type { SafeUser } from './auth.service';
import { PrismaService } from '../prisma.service';

export interface IssuedRefreshToken {
  token: string;
  expiresAt: Date;
}

@Injectable()
export class TokensService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  get refreshTtlMs(): number {
    return Number(this.config.get('JWT_REFRESH_TTL_SECONDS') ?? 2_592_000) * 1000;
  }

  signAccessToken(user: SafeUser): Promise<string> {
    const payload: AccessTokenPayload = {
      sub: user.id,
      email: user.email,
      username: user.username,
    };
    return this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: Number(this.config.get('JWT_ACCESS_TTL_SECONDS') ?? 900),
    });
  }

  async issueRefreshToken(userId: string): Promise<IssuedRefreshToken> {
    const token = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + this.refreshTtlMs);
    await this.prisma.refreshToken.create({
      data: { tokenHash: this.hash(token), userId, expiresAt },
    });
    return { token, expiresAt };
  }

  /**
   * Rotation paresseuse : le token n'est révoqué/réémis que s'il a plus de
   * 24h. Deux refresh simultanés avec le même cookie (double-mount React,
   * retries 401 parallèles) reçoivent ainsi la même réponse valide au lieu
   * que le second détruise la session fraîchement rotationnée.
   * Null si invalide/expiré.
   */
  async rotateRefreshToken(
    rawToken: string,
  ): Promise<{ user: SafeUser; refresh: IssuedRefreshToken } | null> {
    const ROTATION_AGE_MS = 24 * 3600 * 1000;
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hash(rawToken) },
      include: { user: true },
    });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      return null;
    }
    if (Date.now() - stored.createdAt.getTime() < ROTATION_AGE_MS) {
      return { user: stored.user, refresh: { token: rawToken, expiresAt: stored.expiresAt } };
    }
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
    const refresh = await this.issueRefreshToken(stored.userId);
    return { user: stored.user, refresh };
  }

  async revokeRefreshToken(rawToken: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.hash(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
