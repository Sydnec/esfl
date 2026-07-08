import type { OAuthProvider } from '@esfl/contracts';
import type { OAuthProfile } from '../auth.service';

interface ProviderEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scope: string;
  clientIdEnv: string;
  clientSecretEnv: string;
}

export const OAUTH_ENDPOINTS: Record<OAuthProvider, ProviderEndpoints> = {
  discord: {
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    userinfoUrl: 'https://discord.com/api/users/@me',
    scope: 'identify email',
    clientIdEnv: 'DISCORD_CLIENT_ID',
    clientSecretEnv: 'DISCORD_CLIENT_SECRET',
  },
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    clientIdEnv: 'GOOGLE_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
  },
};

export function parseProfile(provider: OAuthProvider, raw: Record<string, unknown>): OAuthProfile {
  if (provider === 'discord') {
    return {
      providerAccountId: String(raw.id),
      email: typeof raw.email === 'string' ? raw.email : null,
      usernameHint: typeof raw.username === 'string' ? raw.username : 'joueur',
    };
  }
  // google (userinfo OpenID Connect)
  const email = typeof raw.email === 'string' ? raw.email : null;
  return {
    providerAccountId: String(raw.sub),
    email,
    usernameHint:
      typeof raw.given_name === 'string' ? raw.given_name : (email?.split('@')[0] ?? 'joueur'),
  };
}
