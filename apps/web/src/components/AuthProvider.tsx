'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { LoginInput, PublicUser, RegisterInput } from '@esfl/contracts';
import { ApiError, authApi, request } from '@/lib/api';

interface AuthContextValue {
  user: PublicUser | null;
  accessToken: string | null;
  /** true tant que la session initiale (cookie refresh) n'a pas été vérifiée. */
  loading: boolean;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  /** Requête authentifiée : rafraîchit la session et réessaie une fois sur 401. */
  authedFetch: <T>(path: string, init?: RequestInit) => Promise<T>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Single-flight : tous les appelants (mount initial, retries 401 parallèles)
  // partagent la même promesse de refresh — jamais deux refresh concurrents.
  const refreshPromiseRef = useRef<Promise<Awaited<ReturnType<typeof authApi.refresh>>> | null>(
    null,
  );
  const sharedRefresh = useCallback(() => {
    if (!refreshPromiseRef.current) {
      refreshPromiseRef.current = authApi.refresh().finally(() => {
        refreshPromiseRef.current = null;
      });
    }
    return refreshPromiseRef.current;
  }, []);

  useEffect(() => {
    sharedRefresh()
      .then((session) => {
        setUser(session.user);
        setAccessToken(session.accessToken);
      })
      .catch(() => {
        // pas de session active
      })
      .finally(() => setLoading(false));
  }, [sharedRefresh]);

  const login = useCallback(async (input: LoginInput) => {
    const session = await authApi.login(input);
    setUser(session.user);
    setAccessToken(session.accessToken);
  }, []);

  const register = useCallback(async (input: RegisterInput) => {
    const session = await authApi.register(input);
    setUser(session.user);
    setAccessToken(session.accessToken);
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout().catch(() => undefined);
    setUser(null);
    setAccessToken(null);
  }, []);

  // Ref pour que authedFetch voie toujours le token courant sans se recréer.
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = accessToken;

  const authedFetch = useCallback(
    async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
      try {
        return await request<T>(path, { ...init, token: tokenRef.current ?? undefined });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          const session = await sharedRefresh();
          setUser(session.user);
          setAccessToken(session.accessToken);
          tokenRef.current = session.accessToken;
          return request<T>(path, { ...init, token: session.accessToken });
        }
        throw error;
      }
    },
    [sharedRefresh],
  );

  const value = useMemo(
    () => ({ user, accessToken, loading, login, register, logout, authedFetch }),
    [user, accessToken, loading, login, register, logout, authedFetch],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth doit être utilisé sous <AuthProvider>');
  }
  return context;
}
