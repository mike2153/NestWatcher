import { useEffect, useMemo, useRef, useState } from 'react';
import { StartupLoadingScreen } from '@/components/StartupLoadingScreen';

export type BootSplashGateProps = {
  /** Minimum time to keep the splash visible, even if the app is ready. */
  minDurationMs?: number;
  /** Checklist items to "tick" during the splash. */
  steps?: string[];
  children: React.ReactNode;
};

const DEFAULT_STEPS: string[] = [
  'Connecting to database',
  'Checking user authentication',
  'Loading machine profiles',
];

const DEFAULT_MIN_DURATION_MS = 6000;

/**
 * Holds the UI behind a "nice" boot splash for a minimum duration.
 *
 * Important: we still mount providers (Theme, Subscription auth, etc.) behind this,
 * so the real app can do its boot work while the splash is visible.
 */
export function BootSplashGate({
  minDurationMs = DEFAULT_MIN_DURATION_MS,
  steps,
  children,
}: BootSplashGateProps) {
  const [ready, setReady] = useState(false);
  const signalledReadyToShowRef = useRef(false);

  useEffect(() => {
    // In React StrictMode in dev, effects are mounted/unmounted twice.
    // We want:
    // - `readyToShow` signalled only once
    // - the timer to always be (re)scheduled, so dev doesn't get stuck on the splash
    if (!signalledReadyToShowRef.current) {
      signalledReadyToShowRef.current = true;

      // Tell Electron main process: React is mounted and the splash is ready to be shown.
      // This lets us keep the BrowserWindow hidden until the React splash is actually on-screen.
      const api = typeof window !== 'undefined' ? window.api : undefined;
      api?.app?.readyToShow?.().catch(() => {});
    }

    // Hold the splash for a minimum duration.
    const t = window.setTimeout(() => setReady(true), minDurationMs);
    return () => window.clearTimeout(t);
  }, [minDurationMs]);

  if (!ready) {
    return (
      <StartupLoadingScreen
        status="Starting application..."
        statusCompleteAtMs={4000}
        steps={steps ?? DEFAULT_STEPS}
        durationMs={Math.max(400, minDurationMs)}
      />
    );
  }

  return <>{children}</>;
}
