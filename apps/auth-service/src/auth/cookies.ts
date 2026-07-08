import { ConfigService } from '@nestjs/config';
import type { CookieOptions } from 'express';

export const REFRESH_COOKIE = 'esfl_rt';
export const OAUTH_STATE_COOKIE = 'esfl_oauth_state';

/**
 * Cookie httpOnly porteur du refresh token, limité aux routes /auth.
 * En prod cross-domaine (ex: *.vercel.app → api VPS), passer COOKIE_SAMESITE=none.
 */
export function refreshCookieOptions(config: ConfigService, maxAgeMs: number): CookieOptions {
  const sameSite = (config.get<string>('COOKIE_SAMESITE') ?? 'lax') as 'lax' | 'strict' | 'none';
  return {
    httpOnly: true,
    secure: config.get('NODE_ENV') === 'production' || sameSite === 'none',
    sameSite,
    domain: config.get<string>('COOKIE_DOMAIN') || undefined,
    path: '/auth',
    maxAge: maxAgeMs,
  };
}
