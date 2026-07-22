import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../prisma.service';
import { TokensService } from './tokens.service';

const JOUR = 24 * 3600 * 1000;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

interface Stocke {
  id: string;
  tokenHash: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  user: { id: string; email: string; username: string; isAdmin: boolean };
}

function setup(stocke: Stocke | null) {
  // Mocks typés : sans paramètres déclarés, `mock.calls` est un tuple vide que
  // TypeScript refuse d'indexer.
  type Args = { where?: Record<string, unknown>; data?: Record<string, unknown> };
  const create = vi.fn(async (args: Args) => args.data ?? {});
  const update = vi.fn(async (_args: Args) => ({}));
  const updateMany = vi.fn(async (_args: Args) => ({ count: 1 }));
  const findUnique = vi.fn(async (_args: Args) => stocke);
  const prisma = {
    refreshToken: { create, update, updateMany, findUnique },
  } as unknown as PrismaService;
  const config = { get: vi.fn(() => undefined), getOrThrow: vi.fn(() => 'secret') } as unknown as ConfigService;
  const jwt = { signAsync: vi.fn(async () => 'jwt') } as unknown as JwtService;
  return { service: new TokensService(jwt, config, prisma), create, update, findUnique, updateMany };
}

const utilisateur = { id: 'u1', email: 'a@b.c', username: 'sydnec', isAdmin: false };

function jeton(over: Partial<Stocke> = {}): Stocke {
  return {
    id: 'rt1',
    tokenHash: sha256('brut'),
    userId: 'u1',
    createdAt: new Date(Date.now() - JOUR / 2),
    expiresAt: new Date(Date.now() + 30 * JOUR),
    revokedAt: null,
    user: utilisateur,
    ...over,
  };
}

describe('issueRefreshToken', () => {
  it('ne stocke JAMAIS le token en clair, seulement son empreinte', () => {
    const { service, create } = setup(null);
    return service.issueRefreshToken('u1').then((emis) => {
      const data = create.mock.calls[0][0].data as unknown as { tokenHash: string };
      expect(data.tokenHash).toBe(sha256(emis.token));
      expect(data.tokenHash).not.toBe(emis.token);
      // Le secret rendu à l'appelant ne doit apparaître nulle part en base.
      expect(JSON.stringify(create.mock.calls[0][0])).not.toContain(emis.token);
    });
  });

  it('émet un secret imprévisible et de longueur suffisante', async () => {
    const { service } = setup(null);
    const a = await service.issueRefreshToken('u1');
    const b = await service.issueRefreshToken('u1');
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(43); // 48 octets en base64url
  });
});

describe('rotateRefreshToken — refus', () => {
  it('refuse un token inconnu', async () => {
    const { service } = setup(null);
    expect(await service.rotateRefreshToken('brut')).toBeNull();
  });

  it('refuse un token révoqué', async () => {
    const { service } = setup(jeton({ revokedAt: new Date() }));
    expect(await service.rotateRefreshToken('brut')).toBeNull();
  });

  it('refuse un token expiré', async () => {
    const { service } = setup(jeton({ expiresAt: new Date(Date.now() - 1000) }));
    expect(await service.rotateRefreshToken('brut')).toBeNull();
  });

  it('cherche par empreinte, jamais par valeur brute', async () => {
    const { service, findUnique } = setup(jeton());
    await service.rotateRefreshToken('brut');
    expect(findUnique.mock.calls[0][0]?.where).toEqual({ tokenHash: sha256('brut') });
  });
});

describe('rotateRefreshToken — rotation paresseuse', () => {
  it('sous 24h, rend le même token sans rien révoquer', async () => {
    // Deux refresh concurrents (double-mount React, retries 401 parallèles)
    // doivent recevoir la même réponse valide, pas s'entre-détruire.
    const { service, update, create } = setup(jeton({ createdAt: new Date(Date.now() - JOUR / 2) }));
    const resultat = await service.rotateRefreshToken('brut');
    expect(resultat?.refresh.token).toBe('brut');
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('au-delà de 24h, révoque l’ancien ET en émet un nouveau', async () => {
    const { service, update, create } = setup(jeton({ createdAt: new Date(Date.now() - 2 * JOUR) }));
    const resultat = await service.rotateRefreshToken('brut');
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0][0]).toMatchObject({ where: { id: 'rt1' } });
    expect(update.mock.calls[0][0]?.data?.revokedAt).toBeInstanceOf(Date);
    expect(create).toHaveBeenCalledOnce();
    expect(resultat?.refresh.token).not.toBe('brut');
  });

  it('rend l’utilisateur porté par le token, dans les deux cas', async () => {
    for (const age of [JOUR / 2, 2 * JOUR]) {
      const { service } = setup(jeton({ createdAt: new Date(Date.now() - age) }));
      const resultat = await service.rotateRefreshToken('brut');
      expect(resultat?.user).toMatchObject({ id: 'u1', username: 'sydnec' });
    }
  });
});

describe('revokeRefreshToken', () => {
  it('ne révoque que les jetons encore actifs, par empreinte', async () => {
    const { service, updateMany } = setup(null);
    await service.revokeRefreshToken('brut');
    expect(updateMany.mock.calls[0][0]?.where).toEqual({
      tokenHash: sha256('brut'),
      revokedAt: null,
    });
  });
});

describe('signAccessToken', () => {
  it('ne met dans le JWT que l’identité, jamais de secret', async () => {
    const signAsync = vi.fn(async (_charge: Record<string, unknown>, _opts?: unknown) => 'jwt');
    const jwt = { signAsync } as unknown as JwtService;
    const config = {
      get: vi.fn(() => undefined),
      getOrThrow: vi.fn(() => 'secret'),
    } as unknown as ConfigService;
    const service = new TokensService(jwt, config, {} as PrismaService);

    await service.signAccessToken({ ...utilisateur, isAdmin: true } as never);
    expect(signAsync.mock.calls[0][0]).toEqual({
      sub: 'u1',
      email: 'a@b.c',
      username: 'sydnec',
      isAdmin: true,
    });
  });
});
