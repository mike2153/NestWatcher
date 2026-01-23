import { useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import woodtronLogo from '@/assets/woodtron.png';

export type StartupLoadingScreenProps = {
  /** Main status line shown beside the spinner. */
  status?: string;
  /**
   * When provided, the status indicator will switch from the spinner to a green
   * checkmark after this many milliseconds.
   */
  statusCompleteAtMs?: number;
  /** Optional checklist that gets ticked in order. */
  steps?: string[];
  /** Total time used to tick through all steps. */
  durationMs?: number;
};

function computeCompletedSteps(elapsedMs: number, stepsCount: number, durationMs: number): number {
  if (stepsCount <= 0) return 0;
  if (durationMs <= 0) return stepsCount;

  // We start ticking shortly after render so the UI has a moment to "settle".
  const startDelayMs = Math.min(350, Math.max(0, durationMs * 0.15));
  if (elapsedMs <= startDelayMs) return 0;

  const remainingMs = Math.max(0, durationMs - startDelayMs);
  const tickEveryMs = remainingMs / stepsCount;
  const progressed = Math.floor((elapsedMs - startDelayMs) / tickEveryMs) + 1;
  return Math.max(0, Math.min(stepsCount, progressed));
}

export function StartupLoadingScreen({
  status = 'Loading application...',
  statusCompleteAtMs,
  steps,
  durationMs = 3000,
}: StartupLoadingScreenProps) {
  const stepList = useMemo(() => (steps ?? []).filter(Boolean), [steps]);

  // Fixed palette for the loading screen.
  // This keeps the splash consistent even if we later add more app themes.
  //
  // Design note:
  // We intentionally keep this palette independent from the user's selected theme
  // so the app always boots with the same look.
  const fixedThemeStyle = useMemo(
    () =>
      ({
        // Match NC-Catalyst's splash palette: black glass + red accent
        // (plus a subtle blue ambient glow in the background).
        '--background': '#0b0d10',
        '--background-body': '#0b0d10',
        '--foreground': '#e7e9ee',
        '--card': 'rgba(20, 23, 30, 0.75)',
        '--border': 'rgba(255, 255, 255, 0.08)',
        '--muted': 'rgba(231, 233, 238, 0.12)',
        '--muted-foreground': 'rgba(231, 233, 238, 0.72)',
        '--primary': 'rgb(244 63 94)',
        '--primary-foreground': '#0b0d10',

        // The component currently uses these "accent-blue" tokens internally.
        // For the splash, we repurpose them to mean "accent color" (red).
        '--accent-blue': 'rgb(244 63 94)',
        '--accent-blue-subtle': 'rgba(244, 63, 94, 0.12)',
        '--accent-blue-border': 'rgba(244, 63, 94, 0.30)',

        // Background atmosphere (matching NC-Cat's splash)
        '--splash-glow-red': 'rgba(244, 63, 94, 0.12)',
        '--splash-glow-blue': 'rgba(59, 130, 246, 0.08)',

        // Success (for the "Starting application" status indicator)
        '--splash-success': 'rgb(34 197 94)',
        '--splash-success-subtle': 'rgba(34, 197, 94, 0.14)',
        '--splash-success-border': 'rgba(34, 197, 94, 0.55)',
      }) as React.CSSProperties,
    []
  );

  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const shouldTrackTime = stepList.length > 0 || statusCompleteAtMs != null;
    if (!shouldTrackTime) return;

    setElapsedMs(0);

    const start = typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();

    const raf = window.requestAnimationFrame;
    const caf = window.cancelAnimationFrame;

    let handle = 0;
    const loop = () => {
      const now = typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
      setElapsedMs(now - start);
      handle = raf(loop);
    };

    handle = raf(loop);
    return () => caf(handle);
  }, [statusCompleteAtMs, stepList.length]);

  const completedSteps = useMemo(
    () => computeCompletedSteps(elapsedMs, stepList.length, durationMs),
    [durationMs, elapsedMs, stepList.length]
  );

  const activeStep = stepList.length ? Math.min(stepList.length - 1, completedSteps) : null;
  const statusIsComplete = statusCompleteAtMs != null && elapsedMs >= statusCompleteAtMs;

  return (
    <div
      className="relative grid h-[100dvh] w-[100dvw] place-items-center overflow-hidden bg-[var(--background)] text-[var(--foreground)]"
      style={fixedThemeStyle}
    >
      {/* Background atmosphere */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 [background-image:radial-gradient(1200px_circle_at_20%_15%,var(--splash-glow-red),rgba(11,13,16,0)_55%),radial-gradient(1000px_circle_at_80%_75%,var(--splash-glow-blue),rgba(11,13,16,0)_60%)]"
      />

      <div className="relative w-[min(560px,92vw)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)] shadow-2xl backdrop-blur-md">
        <div className="flex items-center gap-4 p-7">
          <div className="grid size-16 place-items-center rounded-2xl border border-[var(--border)] bg-[linear-gradient(180deg,rgba(255,255,255,0.10),rgba(255,255,255,0))] shadow-lg">
            <img
              src={woodtronLogo}
              alt="Woodtron"
              className="size-11 select-none"
              draggable={false}
            />
          </div>

          <div className="min-w-0">
            <div className="text-3xl font-semibold italic tracking-tight">Nestwatch</div>
            <div className="mt-1 text-base text-[var(--muted-foreground)]">by Woodtron</div>
          </div>
        </div>

        <div className="border-t border-[var(--border)] px-7 py-6">
          <div className="flex items-center gap-3 text-base text-[var(--muted-foreground)]">
            {statusIsComplete ? (
              <div
                className="grid size-4 shrink-0 place-items-center rounded-full border border-[var(--splash-success-border)] bg-[var(--splash-success-subtle)] text-[var(--splash-success)]"
                aria-hidden="true"
              >
                <Check className="size-3" />
              </div>
            ) : (
              <div
                className="size-4 shrink-0 rounded-full border-2 border-[rgba(231,233,238,0.28)] border-t-[var(--primary)] motion-reduce:animate-none motion-safe:animate-spin"
                aria-hidden="true"
              />
            )}
            <div className="min-w-0 truncate">{status}</div>
          </div>

          {stepList.length ? (
            <div className="mt-5 grid gap-2">
              {stepList.map((label, idx) => {
                const done = idx < completedSteps;
                const active = activeStep === idx && !done;
                return (
                  <div
                    key={`${idx}:${label}`}
                    className={
                      'flex items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors ' +
                      (done
                        ? 'border-transparent bg-[var(--accent-blue-subtle)] text-[var(--foreground)]'
                        : active
                          ? 'border-[var(--accent-blue-border)] bg-[color-mix(in_srgb,var(--card)_85%,transparent)] text-[var(--foreground)]'
                          : 'border-[var(--border)] bg-transparent text-[var(--muted-foreground)]')
                    }
                  >
                    <div
                      className={
                        'grid size-5 place-items-center rounded-full border ' +
                        (done
                          ? 'border-[var(--accent-blue-border)] bg-[var(--accent-blue-subtle)] text-[var(--accent-blue)]'
                          : active
                            ? 'border-[var(--accent-blue-border)] bg-transparent text-[var(--accent-blue)]'
                            : 'border-[var(--border)] bg-transparent text-[var(--muted-foreground)]')
                      }
                      aria-hidden="true"
                    >
                      {done ? (
                        <Check className="size-3.5" />
                      ) : active ? (
                        <span className="block size-2 rounded-full bg-[var(--accent-blue)] motion-reduce:animate-none motion-safe:animate-pulse" />
                      ) : (
                        <span className="block size-1.5 rounded-full bg-[var(--muted)]" />
                      )}
                    </div>
                    <div className="min-w-0 truncate">{label}</div>
                  </div>
                );
              })}
            </div>
          ) : null}

          <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-[var(--muted)]">
            <div className="h-full w-[45%] bg-[linear-gradient(90deg,transparent,var(--accent-blue),transparent)] motion-reduce:animate-none motion-safe:animate-[wl-loading-indeterminate_1.25s_ease-in-out_infinite]" />
          </div>
        </div>
      </div>
    </div>
  );
}
