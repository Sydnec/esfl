import type { AuthResponse, LoginInput, RegisterInput } from '@esfl/contracts';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function request<T>(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<T> {
  const { token, ...options } = init;
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    let message = `Erreur ${response.status}`;
    try {
      const body = (await response.json()) as { message?: string | string[] };
      if (body.message) {
        message = Array.isArray(body.message) ? body.message.join(', ') : body.message;
      }
    } catch {
      // corps non JSON : on garde le message générique
    }
    throw new ApiError(response.status, message);
  }
  return response.json() as Promise<T>;
}

export const authApi = {
  register: (input: RegisterInput) =>
    request<AuthResponse>('/auth/register', { method: 'POST', body: JSON.stringify(input) }),
  login: (input: LoginInput) =>
    request<AuthResponse>('/auth/login', { method: 'POST', body: JSON.stringify(input) }),
  refresh: () => request<AuthResponse>('/auth/refresh', { method: 'POST' }),
  logout: () => request<{ ok: true }>('/auth/logout', { method: 'POST' }),
};

/**
 * Fenêtre du catalogue de compétitions proposées au choix : J-1 à J+7. Sans
 * elle, les listes remontent tout l'historique et deviennent inutilisables.
 */
const CATALOGUE_AVANT_MS = 24 * 3600 * 1000;
const CATALOGUE_APRES_MS = 7 * 24 * 3600 * 1000;

/**
 * Chemin du catalogue restreint à la fenêtre. `ids` force l'inclusion de
 * compétitions hors fenêtre, typiquement celles déjà suivies par une ligue,
 * dont il faut encore afficher le nom.
 */
export function cheminCatalogue(ids: string[] = []): string {
  const params = new URLSearchParams({
    from: new Date(Date.now() - CATALOGUE_AVANT_MS).toISOString(),
    to: new Date(Date.now() + CATALOGUE_APRES_MS).toISOString(),
  });
  if (ids.length > 0) params.set('ids', ids.join(','));
  return `/data/competitions?${params.toString()}`;
}
