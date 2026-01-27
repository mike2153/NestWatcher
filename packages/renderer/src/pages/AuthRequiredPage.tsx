import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSubscriptionAuth } from '@/contexts/SubscriptionAuthContext';
import { Button } from '@/components/ui/button';
import woodtronLogo from '@/assets/woodtron.png';

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

  // Keep the auth-required screen visually consistent with the app boot splash.
  // This is intentionally NOT tied to the user's selected app theme.
  const fixedThemeStyle = useMemo(
    () =>
      ({
        '--background': '#0b0d10',
        '--background-body': '#0b0d10',
        '--foreground': '#e7e9ee',
        '--card': 'rgba(20, 23, 30, 0.75)',
        '--border': 'rgba(255, 255, 255, 0.08)',
        '--muted': 'rgba(231, 233, 238, 0.12)',
        '--muted-foreground': 'rgba(231, 233, 238, 0.72)',

        '--primary': 'rgb(244 63 94)',
        '--primary-foreground': '#0b0d10',
        '--ring': 'rgb(244 63 94)',

        // Background atmosphere (matching NC-Cat's splash)
        '--splash-glow-red': 'rgba(244, 63, 94, 0.12)',
        '--splash-glow-blue': 'rgba(59, 130, 246, 0.08)',

        // Inline status banners
        '--splash-banner-bg': 'rgba(231, 233, 238, 0.06)',
        '--splash-banner-border': 'rgba(255, 255, 255, 0.10)',
        '--splash-danger-bg': 'rgba(244, 63, 94, 0.14)',
        '--splash-danger-border': 'rgba(244, 63, 94, 0.35)',
        '--splash-danger-text': 'rgba(251, 113, 133, 0.95)',
      }) as React.CSSProperties,
    []
  );

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
        <div className="rounded-xl border border-[var(--splash-danger-border)] bg-[var(--splash-danger-bg)] px-4 py-3 text-sm text-[var(--splash-danger-text)]">
          {error}
        </div>
      );
    }
    if (subscriptionLoading) {
      return (
        <div className="rounded-xl border border-[var(--splash-banner-border)] bg-[var(--splash-banner-bg)] px-4 py-3 text-sm text-[var(--muted-foreground)]">
          Checking subscription…
        </div>
      );
    }
    if (!opening) return null;
    return (
      <div className="rounded-xl border border-[var(--splash-banner-border)] bg-[var(--splash-banner-bg)] px-4 py-3 text-sm text-[var(--muted-foreground)]">
        Opening NC Catalyst…
      </div>
    );
  }, [opening, error, subscriptionLoading]);

  return (
    <div
      className="relative grid h-[100dvh] w-[100dvw] place-items-center overflow-hidden bg-[var(--background)] text-[var(--foreground)]"
      style={fixedThemeStyle}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 [background-image:radial-gradient(1200px_circle_at_20%_15%,var(--splash-glow-red),rgba(11,13,16,0)_55%),radial-gradient(1000px_circle_at_80%_75%,var(--splash-glow-blue),rgba(11,13,16,0)_60%)]"
      />

      <div className="relative w-full max-w-md px-6">
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6 shadow-2xl backdrop-blur-md">
          <div className="flex items-center gap-4">
            <div className="grid size-14 place-items-center rounded-2xl border border-[var(--border)] bg-[linear-gradient(180deg,rgba(255,255,255,0.10),rgba(255,255,255,0))] shadow-lg">
              <img
                src={woodtronLogo}
                alt="Woodtron"
                className="size-10 select-none"
                draggable={false}
              />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-medium text-[var(--muted-foreground)]">NestWatcher</div>
              <h1 className="text-2xl font-semibold tracking-tight">Sign in required</h1>
            </div>
          </div>

          <p className="mt-2 text-sm text-[var(--muted-foreground)]">
            NestWatcher uses NC Catalyst for authentication. Please sign in there to continue.
          </p>
          <div className="mt-4">{status}</div>
          <Button
            type="button"
            onClick={openNcCat}
            disabled={opening}
            className="mt-4 w-full bg-[var(--primary)] text-[var(--primary-foreground)] shadow-sm hover:-translate-y-0.5 hover:shadow-md"
          >
            Open NC Catalyst Sign In
          </Button>
        </div>
      </div>
    </div>
  );
}
