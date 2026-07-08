import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { AccessTokenPayload } from '@esfl/contracts';
import type { User } from '@prisma/client';
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

  signAccessToken(user: User): Promise<string> {
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

  /** Rotation : révoque le token présenté et en émet un nouveau. Null si invalide/expiré. */
  async rotateRefreshToken(
    rawToken: string,
  ): Promise<{ user: User; refresh: IssuedRefreshToken } | null> {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hash(rawToken) },
      include: { user: true },
    });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      return null;
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
