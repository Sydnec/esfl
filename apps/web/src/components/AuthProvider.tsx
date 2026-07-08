'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { LoginInput, PublicUser, RegisterInput } from '@esfl/contracts';
import { authApi } from '@/lib/api';

interface AuthContextValue {
  user: PublicUser | null;
  accessToken: string | null;
  /** true tant que la session initiale (cookie refresh) n'a pas été vérifiée. */
  loading: boolean;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authApi
      .refresh()
      .then((session) => {
        setUser(session.user);
        setAccessToken(session.accessToken);
      })
      .catch(() => {
        // pas de session active
      })
      .finally(() => setLoading(false));
  }, []);

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

  const value = useMemo(
    () => ({ user, accessToken, loading, login, register, logout }),
    [user, accessToken, loading, login, register, logout],
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
