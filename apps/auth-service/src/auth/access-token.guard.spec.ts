import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import { AccessTokenGuard, type AuthenticatedRequest } from './access-token.guard';

function contexte(headers: Record<string, string>) {
  const request = { headers } as unknown as AuthenticatedRequest;
  return {
    request,
    ctx: {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext,
  };
}

function garde(verify: () => unknown) {
  const jwt = { verify: vi.fn(verify) } as unknown as JwtService;
  const config = { getOrThrow: vi.fn(() => 'secret') } as unknown as ConfigService;
  return { guard: new AccessTokenGuard(jwt, config), jwt };
}

describe('AccessTokenGuard', () => {
  it('accepte un token valide et attache l’identité à la requête', () => {
    const charge = { sub: 'u1', email: 'a@b.c', username: 'sydnec', isAdmin: false };
    const { guard } = garde(() => charge);
    const { ctx, request } = contexte({ authorization: 'Bearer valide' });
    expect(guard.canActivate(ctx)).toBe(true);
    expect(request.user).toEqual(charge);
  });

  it('refuse une requête sans en-tête Authorization', () => {
    const { guard } = garde(() => ({}));
    expect(() => guard.canActivate(contexte({}).ctx)).toThrow(UnauthorizedException);
  });

  it('refuse un schéma qui n’est pas Bearer', () => {
    const { guard } = garde(() => ({}));
    const { ctx } = contexte({ authorization: 'Basic abc' });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('refuse un token que la vérification rejette', () => {
    const { guard } = garde(() => {
      throw new Error('signature invalide');
    });
    const { ctx } = contexte({ authorization: 'Bearer forge' });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('n’attache aucune identité quand la vérification échoue', () => {
    const { guard } = garde(() => {
      throw new Error('expiré');
    });
    const { ctx, request } = contexte({ authorization: 'Bearer expire' });
    expect(() => guard.canActivate(ctx)).toThrow();
    expect(request.user).toBeUndefined();
  });

  it('vérifie toujours avec le secret d’accès configuré', () => {
    const { guard, jwt } = garde(() => ({ sub: 'u1' }));
    guard.canActivate(contexte({ authorization: 'Bearer valide' }).ctx);
    expect(vi.mocked(jwt.verify).mock.calls[0][1]).toEqual({ secret: 'secret' });
  });
});
