import { randomBytes } from 'node:crypto';
import { BadRequestException, Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAUTH_PROVIDERS, OAuthProvider } from '@esfl/contracts';
import type { Request, Response } from 'express';
import { AuthService } from '../auth.service';
import { OAUTH_STATE_COOKIE, REFRESH_COOKIE, refreshCookieOptions } from '../cookies';
import { TokensService } from '../tokens.service';
import { OAuthService } from './oauth.service';

@Controller('auth/oauth')
export class OAuthController {
  constructor(
    private readonly oauth: OAuthService,
    private readonly authService: AuthService,
    private readonly tokens: TokensService,
    private readonly config: ConfigService,
  ) {}

  @Get(':provider')
  start(@Param('provider') provider: string, @Res() res: Response) {
    const validProvider = this.parseProvider(provider);
    const state = randomBytes(16).toString('hex');
    res.cookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000,
      path: '/auth/oauth',
    });
    res.redirect(this.oauth.buildAuthorizeUrl(validProvider, state));
  }

  @Get(':provider/callback')
  async callback(
    @Param('provider') provider: string,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const frontendUrl = this.config.getOrThrow<string>('FRONTEND_URL');
    try {
      const validProvider = this.parseProvider(provider);
      const expectedState = req.cookies?.[OAUTH_STATE_COOKIE] as string | undefined;
      if (!code || !state || !expectedState || state !== expectedState) {
        throw new BadRequestException('State OAuth invalide');
      }
      res.clearCookie(OAUTH_STATE_COOKIE, { path: '/auth/oauth' });

      const profile = await this.oauth.fetchProfile(validProvider, code);
      const user = await this.authService.findOrCreateOAuthUser(validProvider, profile);
      const refresh = await this.tokens.issueRefreshToken(user.id);
      res.cookie(
        REFRESH_COOKIE,
        refresh.token,
        refreshCookieOptions(this.config, this.tokens.refreshTtlMs),
      );
      res.redirect(`${frontendUrl}/dashboard`);
    } catch {
      res.redirect(`${frontendUrl}/login?error=oauth`);
    }
  }

  private parseProvider(provider: string): OAuthProvider {
    if (!(OAUTH_PROVIDERS as readonly string[]).includes(provider)) {
      throw new BadRequestException(`Provider inconnu : ${provider}`);
    }
    return provider as OAuthProvider;
  }
}
