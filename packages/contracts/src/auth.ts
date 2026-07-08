import { z } from 'zod';

export const OAUTH_PROVIDERS = ['discord', 'google'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export const registerInputSchema = z.object({
  email: z.email(),
  username: z
    .string()
    .min(3)
    .max(20)
    .regex(/^[a-zA-Z0-9_-]+$/, 'Lettres, chiffres, tirets et underscores uniquement'),
  password: z.string().min(8).max(128),
});
export type RegisterInput = z.infer<typeof registerInputSchema>;

export const loginInputSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginInputSchema>;

export interface PublicUser {
  id: string;
  email: string;
  username: string;
  createdAt: string;
}

export interface AuthResponse {
  accessToken: string;
  user: PublicUser;
}

/** Payload du JWT d'accès émis par auth-service et vérifié par le gateway. */
export interface AccessTokenPayload {
  sub: string;
  email: string;
  username: string;
}
