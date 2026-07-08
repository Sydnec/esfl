import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * L'identité vient de l'en-tête x-user-id, posé par le gateway après
 * vérification du JWT. Le service n'est jamais exposé directement.
 */
@Injectable()
export class UserGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const userId = request.headers['x-user-id'];
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new UnauthorizedException('Authentification requise');
    }
    return true;
  }
}

export const UserId = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const request = context.switchToHttp().getRequest<Request>();
  return request.headers['x-user-id'] as string;
});
