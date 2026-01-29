import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, HelpCircle, Info, X, XCircle } from 'lucide-react';
import type { AppDialogRequest, AppDialogSeverity } from '../../../shared/src';
import { UI_DIALOG_ENQUEUE_CHANNEL } from '../../../shared/src';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

function severityMeta(severity: AppDialogSeverity) {
  switch (severity) {
    case 'error':
      return {
        Icon: XCircle,
        ring: 'border-red-500/40 bg-red-500/10 text-red-700',
        glow: 'from-red-500/10 via-red-500/0'
      };
    case 'warning':
      return {
        Icon: AlertTriangle,
        ring: 'border-amber-500/40 bg-amber-500/10 text-amber-800',
        glow: 'from-amber-500/10 via-amber-500/0'
      };
    case 'question':
      return {
        Icon: HelpCircle,
        ring: 'border-sky-500/40 bg-sky-500/10 text-sky-800',
        glow: 'from-sky-500/10 via-sky-500/0'
      };
    case 'info':
    default:
      return {
        Icon: Info,
        ring: 'border-indigo-500/40 bg-indigo-500/10 text-indigo-800',
        glow: 'from-indigo-500/10 via-indigo-500/0'
      };
  }
}

export function AppDialogHost() {
  const [queue, setQueue] = useState<AppDialogRequest[]>([]);
  const [active, setActive] = useState<AppDialogRequest | null>(null);

  const dequeueIfNeeded = useCallback(() => {
    setQueue((prev) => {
      if (active) return prev;
      const next = prev[0];
      if (!next) return prev;
      setActive(next);
      return prev.slice(1);
    });
  }, [active]);

  useEffect(() => {
    dequeueIfNeeded();
  }, [dequeueIfNeeded, queue.length]);

  useEffect(() => {
    const unsub = window.api.uiDialogs.subscribe((payload: AppDialogRequest) => {
      if (!payload) return;
      setQueue((prev) => prev.concat(payload));
    });
    return () => {
      unsub?.();
    };
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const custom = event as CustomEvent<AppDialogRequest>;
      if (!custom.detail) return;
      setQueue((prev) => prev.concat(custom.detail));
    };
    window.addEventListener(UI_DIALOG_ENQUEUE_CHANNEL, handler);
    return () => {
      window.removeEventListener(UI_DIALOG_ENQUEUE_CHANNEL, handler);
    };
  }, []);

  const meta = useMemo(() => (active ? severityMeta(active.severity) : null), [active]);
  const buttons = active?.buttons && active.buttons.length > 0 ? active.buttons : ['OK'];
  const detail = (active?.detail ?? '').trim();

  const copyAvailable = !!active && (!!detail || (active.message ?? '').length > 0);
  const handleCopy = async () => {
    if (!active) return;
    const parts: string[] = [];
    parts.push(active.title);
    parts.push('');
    parts.push(active.message ?? '');
    if (detail) {
      parts.push('');
      parts.push('Details:');
      parts.push(detail);
    }
    try {
      await navigator.clipboard.writeText(parts.join('\n'));
    } catch {
      // Clipboard may be unavailable in some environments. Ignore.
    }
  };

  return (
    <Dialog
      open={!!active}
      onOpenChange={(open) => {
        if (!open) {
          setActive(null);
        }
      }}
    >
      <DialogContent className="sm:max-w-[540px]">
        {active && meta ? (
          <div className="relative">
            <div
              className={cn(
                'absolute inset-x-0 top-0 h-24 bg-gradient-to-b pointer-events-none',
                meta.glow
              )}
            />
            <div className="relative p-5">
              <div className="flex items-start gap-3">
                <div
                  className={cn(
                    'mt-0.5 flex h-9 w-9 items-center justify-center rounded-full border',
                    meta.ring
                  )}
                >
                  <meta.Icon className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <DialogHeader>
                    <div className="flex items-start justify-between gap-2">
                      <DialogTitle className="pr-2">{active.title}</DialogTitle>
                      <DialogClose asChild>
                        <button
                          className="rounded p-1 text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:bg-black/5"
                          aria-label="Close"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </DialogClose>
                    </div>
                    <DialogDescription className="whitespace-pre-wrap text-sm leading-relaxed">
                      {active.message}
                    </DialogDescription>
                  </DialogHeader>

                  {detail ? (
                    <details className="mt-3 rounded-md border border-[var(--border)] bg-[var(--background)]/40 p-3">
                      <summary className="cursor-pointer select-none text-sm font-medium text-[var(--foreground)]">
                        Details
                      </summary>
                      <div className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-[var(--foreground-muted)] max-h-56 overflow-auto">
                        {detail}
                      </div>
                    </details>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="border-t border-[var(--border)] bg-[var(--card)] px-5 py-3">
              <DialogFooter>
                {copyAvailable ? (
                  <Button type="button" variant="outline" onClick={handleCopy}>
                    Copy
                  </Button>
                ) : null}
                {buttons.map((label, idx) => {
                  const isDefault = (active.defaultId ?? buttons.length - 1) === idx;
                  return (
                    <DialogClose asChild key={`${active.id}:${idx}`}>
                      <Button type="button" variant={isDefault ? 'default' : 'outline'}>
                        {label}
                      </Button>
                    </DialogClose>
                  );
                })}
              </DialogFooter>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
