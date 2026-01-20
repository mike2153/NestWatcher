import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { SubscriptionAuthState, SubscriptionLoginReq, SubscriptionLoginRes } from '../../../shared/src';

type SubscriptionAuthContextValue = {
  state: SubscriptionAuthState | null;
  loading: boolean;
  refresh: () => Promise<void>;
  login: (req: SubscriptionLoginReq) => Promise<SubscriptionLoginRes>;
  logout: () => Promise<void>;
};

const SubscriptionAuthContext = createContext<SubscriptionAuthContextValue | undefined>(undefined);

export function SubscriptionAuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SubscriptionAuthState | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const res = await window.api.ncCatalyst.subscriptionAuth.getState();
    if (res.ok) {
      setState(res.value);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    refresh()
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    const unsub = window.api.ncCatalyst.subscriptionAuth.onStateChange((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [refresh]);

  const login = useCallback(async (req: SubscriptionLoginReq): Promise<SubscriptionLoginRes> => {
    const res = await window.api.ncCatalyst.subscriptionAuth.login(req);
    if (!res.ok) {
      return { success: false, error: res.error.message };
    }
    if (res.value.success && res.value.state) {
      setState(res.value.state);
    }
    return res.value;
  }, []);

  const logout = useCallback(async () => {
    await window.api.ncCatalyst.subscriptionAuth.logout().catch(() => {});
    setState(null);
  }, []);

  const value = useMemo<SubscriptionAuthContextValue>(
    () => ({ state, loading, refresh, login, logout }),
    [state, loading, refresh, login, logout]
  );

  return <SubscriptionAuthContext.Provider value={value}>{children}</SubscriptionAuthContext.Provider>;
}

export function useSubscriptionAuth(): SubscriptionAuthContextValue {
  const ctx = useContext(SubscriptionAuthContext);
  if (!ctx) throw new Error('useSubscriptionAuth must be used within SubscriptionAuthProvider');
  return ctx;
}

