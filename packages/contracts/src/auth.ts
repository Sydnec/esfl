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

export const updateProfileInputSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(20)
    .regex(/^[a-zA-Z0-9_-]+$/, 'Lettres, chiffres, tirets et underscores uniquement'),
});
export type UpdateProfileInput = z.infer<typeof updateProfileInputSchema>;

export const changePasswordInputSchema = z.object({
  /** Absent uniquement pour un compte OAuth qui n'a pas encore de mot de passe. */
  currentPassword: z.string().optional(),
  newPassword: z.string().min(8).max(128),
});
export type ChangePasswordInput = z.infer<typeof changePasswordInputSchema>;

export interface PublicUser {
  id: string;
  email: string;
  username: string;
  createdAt: string;
  /** Chemin de l'avatar (servi par l'API) ou null. */
  avatarUrl: string | null;
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
