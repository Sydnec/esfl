import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Réservé à l'admin : soit un compte admin passé par le gateway
 * (x-user-admin, dérivé du JWT — les en-têtes entrants y sont écrasés),
 * soit le token d'ops x-admin-token comparé à env ADMIN_TOKEN.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const headers = context.switchToHttp().getRequest<Request>().headers;
    if (headers['x-user-admin'] === '1') return true;
    const expected = process.env.ADMIN_TOKEN;
    if (expected && headers['x-admin-token'] === expected) return true;
    throw new UnauthorizedException('Accès admin requis');
  }
}
