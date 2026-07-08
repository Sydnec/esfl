import { BadGatewayException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OAuthProvider } from '@esfl/contracts';
import type { OAuthProfile } from '../auth.service';
import { OAUTH_ENDPOINTS, parseProfile } from './providers';

@Injectable()
export class OAuthService {
  constructor(private readonly config: ConfigService) {}

  buildAuthorizeUrl(provider: OAuthProvider, state: string): string {
    const endpoints = OAUTH_ENDPOINTS[provider];
    const url = new URL(endpoints.authorizeUrl);
    url.searchParams.set('client_id', this.config.getOrThrow(endpoints.clientIdEnv));
    url.searchParams.set('redirect_uri', this.redirectUri(provider));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', endpoints.scope);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async fetchProfile(provider: OAuthProvider, code: string): Promise<OAuthProfile> {
    const endpoints = OAUTH_ENDPOINTS[provider];
    const tokenResponse = await fetch(endpoints.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.getOrThrow<string>(endpoints.clientIdEnv),
        client_secret: this.config.getOrThrow<string>(endpoints.clientSecretEnv),
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri(provider),
      }),
    });
    if (!tokenResponse.ok) {
      throw new BadGatewayException(`Échange de code ${provider} refusé (${tokenResponse.status})`);
    }
    const { access_token: accessToken } = (await tokenResponse.json()) as {
      access_token: string;
    };

    const profileResponse = await fetch(endpoints.userinfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!profileResponse.ok) {
      throw new BadGatewayException(`Profil ${provider} inaccessible (${profileResponse.status})`);
    }
    return parseProfile(provider, (await profileResponse.json()) as Record<string, unknown>);
  }

  private redirectUri(provider: OAuthProvider): string {
    const base = this.config.getOrThrow<string>('OAUTH_CALLBACK_BASE_URL');
    return `${base}/auth/oauth/${provider}/callback`;
  }
}
