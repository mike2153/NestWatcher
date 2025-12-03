import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { AuthSession } from '../../../shared/src';
import { LoginModal } from '@/components/LoginModal';

type AuthContextValue = {
  session: AuthSession | null;
  loading: boolean;
  requireLogin: () => void;
  logout: () => Promise<void>;
  setSession: (session: AuthSession | null) => void;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    window.api.auth
      .me()
      .then((res) => {
        if (cancelled) return;
        if (res.ok && res.value.session) {
          setSession(res.value.session);
          setModalOpen(false);
        } else {
          setSession(null);
          setModalOpen(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSession(null);
          setModalOpen(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unsubscribe = window.api.auth.onRevoked?.(() => {
      setSession(null);
      setModalOpen(true);
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  const requireLogin = useCallback(() => {
    setModalOpen(true);
  }, []);

  const logout = useCallback(async () => {
    try {
      await window.api.auth.logout();
    } catch {
      // ignore logout failures; we'll still clear local session
    }
    setSession(null);
    setModalOpen(true);
  }, []);

  const handleAuthenticated = useCallback((next: AuthSession) => {
    setSession(next);
    setModalOpen(false);
  }, []);

  const ctxValue = useMemo<AuthContextValue>(
    () => ({
      session,
      loading,
      requireLogin,
      logout,
      setSession
    }),
    [session, loading, requireLogin, logout]
  );

  const handleRequestClose = useCallback(() => {
    if (session) {
      setModalOpen(false);
    }
  }, [session]);

  return (
    <AuthContext.Provider value={ctxValue}>
      {session ? children : null}
      <LoginModal
        isOpen={modalOpen}
        onAuthenticated={handleAuthenticated}
        onClose={handleRequestClose}
        disableClose={!session}
      />
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
