import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSubscriptionAuth } from '@/contexts/SubscriptionAuthContext';

function isSubscriptionSatisfied(state: ReturnType<typeof useSubscriptionAuth>['state']): boolean {
  if (!state) return false;
  if (!state.authenticated) return false;
  if (state.isAdmin) return true;
  return state.subscriptionStatus === 'active' || state.subscriptionStatus === 'grace_period';
}

export function AuthRequiredPage() {
  const navigate = useNavigate();
  const { state: subscriptionState, loading: subscriptionLoading } = useSubscriptionAuth();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requireSubscription = import.meta.env.VITE_REQUIRE_SUBSCRIPTION_AUTH === 'true';
  const hasAccess = requireSubscription
    ? isSubscriptionSatisfied(subscriptionState)
    : Boolean(subscriptionState?.authenticated);

  useEffect(() => {
    if (!hasAccess) return;
    // If the user completed sign-in in the NC-Cat window, close it and return to the main app.
    void window.api?.ncCatalyst?.close?.();
    navigate('/', { replace: true });
  }, [hasAccess, navigate]);

  useEffect(() => {
    const info = {
      hasWindowApi: typeof window !== 'undefined' && !!window.api,
      hasNcCatalyst: typeof window !== 'undefined' && !!window.api?.ncCatalyst,
      hasOpen: typeof window !== 'undefined' && typeof window.api?.ncCatalyst?.open === 'function',
      hasLog: typeof window !== 'undefined' && typeof window.api?.log?.info === 'function'
    };
    // eslint-disable-next-line no-console
    console.log('[AuthRequiredPage] mounted', info);
    if (window.api?.log?.info) {
      void window.api.log.info('AuthRequiredPage mounted', info);
    }
  }, []);

  const openNcCat = useCallback(async () => {
    // eslint-disable-next-line no-console
    console.log('[AuthRequiredPage] Open NC Cat clicked', {
      hasWindowApi: typeof window !== 'undefined' && !!window.api,
      hasNcCatalyst: typeof window !== 'undefined' && !!window.api?.ncCatalyst,
      hasOpen: typeof window !== 'undefined' && typeof window.api?.ncCatalyst?.open === 'function'
    });
    if (window.api?.log?.info) {
      void window.api.log.info('AuthRequiredPage: Open NC Cat clicked', {
        hasWindowApi: typeof window !== 'undefined' && !!window.api,
        hasNcCatalyst: typeof window !== 'undefined' && !!window.api?.ncCatalyst,
        hasOpen: typeof window !== 'undefined' && typeof window.api?.ncCatalyst?.open === 'function'
      });
    }
    setOpening(true);
    setError(null);
    try {
      if (!window.api?.ncCatalyst?.open) {
        setError('NC Catalyst bridge is not available yet.');
        // eslint-disable-next-line no-console
        console.log('[AuthRequiredPage] window.api.ncCatalyst.open missing');
        if (window.api?.log?.warn) {
          void window.api.log.warn('AuthRequiredPage: window.api.ncCatalyst.open missing');
        }
        return;
      }
      const res = await window.api.ncCatalyst.open();
      // eslint-disable-next-line no-console
      console.log('[AuthRequiredPage] ncCatalyst.open() result', res);
      if (window.api?.log?.info) {
        void window.api.log.info('AuthRequiredPage: ncCatalyst.open() result', { ok: res.ok });
      }
      if (!res.ok) {
        setError(res.error.message || 'Failed to open NC Catalyst');
        // eslint-disable-next-line no-console
        console.log('[AuthRequiredPage] ncCatalyst.open() failed', res.error);
        if (window.api?.log?.error) {
          void window.api.log.error('AuthRequiredPage: ncCatalyst.open() failed', { error: res.error });
        }
      }
    } finally {
      setOpening(false);
    }
  }, []);

  const status = useMemo(() => {
    if (error) {
      return (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      );
    }
    if (subscriptionLoading) {
      return <div className="rounded-xl border border-border bg-secondary px-4 py-3 text-sm">Checking subscription…</div>;
    }
    if (!opening) return null;
    return <div className="rounded-xl border border-border bg-secondary px-4 py-3 text-sm">Opening NC Catalyst…</div>;
  }, [opening, error, subscriptionLoading]);

  const debugInfo = useMemo(() => {
    const info = {
      hasWindowApi: typeof window !== 'undefined' && !!window.api,
      hasNcCatalyst: typeof window !== 'undefined' && !!window.api?.ncCatalyst,
      hasOpen: typeof window !== 'undefined' && typeof window.api?.ncCatalyst?.open === 'function',
      hasLog: typeof window !== 'undefined' && typeof window.api?.log?.info === 'function'
    };
    try {
      return JSON.stringify(info, null, 2);
    } catch {
      return String(info);
    }
  }, []);

  return (
    <div className="grid h-[100dvh] w-[100dvw] place-items-center bg-background text-foreground">
      <div className="w-full max-w-md px-6">
        <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
          <h1 className="text-2xl font-semibold tracking-tight">Sign in required</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            NestWatcher uses NC Catalyst for authentication. Please sign in there to continue.
          </p>
          <div className="mt-4">{status}</div>
          <button
            type="button"
            onClick={openNcCat}
            disabled={opening}
            className="mt-4 w-full rounded-xl bg-primary py-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
          >
            Open NC Catalyst Sign In
          </button>
          <details className="mt-4">
            <summary className="cursor-pointer select-none text-sm text-muted-foreground">Debug</summary>
            <pre className="mt-2 whitespace-pre-wrap rounded-xl border border-border bg-secondary p-3 text-xs text-foreground/80">
              {debugInfo}
            </pre>
          </details>
        </div>
      </div>
    </div>
  );
}
