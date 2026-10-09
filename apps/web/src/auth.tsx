import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setAccessToken, tryRefresh, type Me } from './api';

interface AuthState {
  me: Me | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string, referralCode?: string, setupCode?: string) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      setMe(await api<Me>('/auth/me'));
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => {
    tryRefresh().then((ok) => (ok ? reload() : undefined)).finally(() => setLoading(false));
  }, [reload]);

  const login = async (email: string, password: string) => {
    const r = await api<{ accessToken: string }>('/auth/login', { method: 'POST', json: { email, password } });
    setAccessToken(r.accessToken);
    await reload();
  };
  const register = async (email: string, password: string, name: string, referralCode?: string, setupCode?: string) => {
    const r = await api<{ accessToken: string }>('/auth/register', { method: 'POST', json: { email, password, name, ...(referralCode ? { referralCode } : {}), ...(setupCode ? { setupCode } : {}) } });
    setAccessToken(r.accessToken);
    await reload();
  };
  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setAccessToken(null);
    setMe(null);
  };

  return <Ctx.Provider value={{ me, loading, login, register, logout, reload }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
