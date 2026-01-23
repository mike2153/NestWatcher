import { useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import woodtronLogo from '@/assets/woodtron.png';

export type StartupLoadingScreenProps = {
  /** Main status line shown beside the spinner. */
  status?: string;
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
  steps,
  durationMs = 3000,
}: StartupLoadingScreenProps) {
  const stepList = useMemo(() => (steps ?? []).filter(Boolean), [steps]);

  // Fixed palette for the loading screen.
  // This keeps the splash consistent even if we later add more app themes.
  const fixedThemeStyle = useMemo(
    () =>
      ({
        // Keep the splash typography independent from the app.
        // This avoids the splash changing if we ever change the app font stack.
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",

        '--background': 'hsl(200 18% 7%)',
        '--foreground': 'hsl(40 20% 96%)',
        '--card': 'hsl(200 12% 13%)',
        '--border': 'hsl(200 12% 22%)',
        '--muted': 'hsl(200 12% 20%)',
        '--muted-foreground': 'hsl(200 10% 65%)',
        '--primary': 'hsl(172 66% 50%)',
        '--primary-foreground': 'hsl(200 18% 10%)',
        '--accent-blue': 'hsl(172 66% 50%)',
        '--accent-blue-subtle': 'rgba(45, 212, 191, 0.12)',
        '--accent-blue-border': 'rgba(45, 212, 191, 0.30)',
      }) as React.CSSProperties,
    []
  );

  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!stepList.length) return;

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
  }, [stepList.length]);

  const completedSteps = useMemo(
    () => computeCompletedSteps(elapsedMs, stepList.length, durationMs),
    [durationMs, elapsedMs, stepList.length]
  );

  const activeStep = stepList.length ? Math.min(stepList.length - 1, completedSteps) : null;

  return (
    <div
      className="relative grid h-[100dvh] w-[100dvw] place-items-center overflow-hidden bg-background text-foreground"
      style={fixedThemeStyle}
    >
      {/* Background atmosphere */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-90 [background-image:radial-gradient(900px_circle_at_50%_0%,var(--accent-blue-subtle),transparent_60%),radial-gradient(900px_circle_at_15%_120%,var(--accent-blue-subtle),transparent_55%)]"
      />

      <div className="relative w-[min(560px,92vw)] overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-center gap-4 p-7">
          <div className="grid size-16 place-items-center rounded-2xl border border-border bg-[linear-gradient(180deg,rgba(255,255,255,0.10),rgba(255,255,255,0))] shadow-lg">
            <img
              src={woodtronLogo}
              alt="Woodtron"
              className="size-11 select-none"
              draggable={false}
            />
          </div>

          <div className="min-w-0">
            <div className="text-3xl font-semibold italic tracking-tight">Nestwatch</div>
            <div className="mt-1 text-base text-muted-foreground">by Woodtron</div>
          </div>
        </div>

        <div className="border-t border-border px-7 py-6">
          <div className="flex items-center gap-3 text-base text-muted-foreground">
            <div
              className="size-4 shrink-0 rounded-full border-2 border-muted border-t-primary motion-reduce:animate-none motion-safe:animate-spin"
              aria-hidden="true"
            />
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
                        ? 'border-transparent bg-[var(--accent-blue-subtle)] text-foreground'
                        : active
                          ? 'border-[var(--accent-blue-border)] bg-[color-mix(in_srgb,var(--card)_85%,transparent)] text-foreground'
                          : 'border-border bg-transparent text-muted-foreground')
                    }
                  >
                    <div
                      className={
                        'grid size-5 place-items-center rounded-full border ' +
                        (done
                          ? 'border-[var(--accent-blue-border)] bg-[var(--accent-blue-subtle)] text-[var(--accent-blue)]'
                          : active
                            ? 'border-[var(--accent-blue-border)] bg-transparent text-[var(--accent-blue)]'
                            : 'border-border bg-transparent text-muted-foreground')
                      }
                      aria-hidden="true"
                    >
                      {done ? (
                        <Check className="size-3.5" />
                      ) : active ? (
                        <span className="block size-2 rounded-full bg-[var(--accent-blue)] motion-reduce:animate-none motion-safe:animate-pulse" />
                      ) : (
                        <span className="block size-1.5 rounded-full bg-muted" />
                      )}
                    </div>
                    <div className="min-w-0 truncate">{label}</div>
                  </div>
                );
              })}
            </div>
          ) : null}

          <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full w-[45%] bg-[linear-gradient(90deg,transparent,var(--accent-blue),transparent)] motion-reduce:animate-none motion-safe:animate-[wl-loading-indeterminate_1.25s_ease-in-out_infinite]" />
          </div>
        </div>
      </div>
    </div>
  );
}
