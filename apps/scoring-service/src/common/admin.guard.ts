import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * Réservé à l'admin : x-admin-token comparé à env ADMIN_TOKEN.
 * Refuse tout si ADMIN_TOKEN n'est pas configuré.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.ADMIN_TOKEN;
    const provided = context.switchToHttp().getRequest<Request>().headers['x-admin-token'];
    if (!expected || provided !== expected) {
      throw new UnauthorizedException('Accès admin requis');
    }
    return true;
  }
}
