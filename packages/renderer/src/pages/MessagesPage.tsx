import { useEffect, useMemo, useState } from 'react';
import type { AppMessage } from '../../../shared/src';
import { formatAuDateTime } from '@/utils/datetime';

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatAuDateTime(date);
}

const toneClasses: Record<AppMessage['tone'], string> = {
  success:
    'bg-gradient-to-r from-emerald-500/35 to-emerald-500/20 border-emerald-600/50 text-emerald-700 dark:from-emerald-400/25 dark:to-emerald-400/12 dark:border-emerald-400/50 dark:text-emerald-300',
  info:
    'bg-gradient-to-r from-amber-500/35 to-amber-500/20 border-amber-600/50 text-amber-700 dark:from-amber-400/25 dark:to-amber-400/12 dark:border-amber-400/50 dark:text-amber-300',
  warning:
    'bg-gradient-to-r from-amber-500/35 to-amber-500/20 border-amber-600/50 text-amber-700 dark:from-amber-400/25 dark:to-amber-400/12 dark:border-amber-400/50 dark:text-amber-300',
  error:
    'bg-gradient-to-r from-red-500/35 to-red-500/20 border-red-600/50 text-red-700 dark:from-red-400/25 dark:to-red-400/12 dark:border-red-400/50 dark:text-red-300'
};

export function MessagesPage() {
  const [messages, setMessages] = useState<AppMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);
      setError(null);
      const res = await window.api.messages.list();
      if (!mounted) return;
      if (!res.ok) {
        setError(res.error.message);
        setMessages([]);
      } else {
        setMessages(res.value.items ?? []);
        void window.api.messages.markAllRead();
      }
      setLoading(false);
    })();

    const unsubscribe = window.api.messages.subscribe((entry) => {
      setMessages((prev) => {
        if (prev.some((m) => m.id === entry.id)) return prev;
        const next = [entry, ...prev];
        if (next.length > 200) next.length = 200;
        return next;
      });
      void window.api.messages.markAllRead();
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const content = useMemo(() => {
    if (loading) {
      return <div className="text-sm text-muted-foreground">Loading messages…</div>;
    }
    if (error) {
      return <div className="text-sm text-red-600">Failed to load messages: {error}</div>;
    }
    if (!messages.length) {
      return <div className="text-sm text-muted-foreground">No messages yet.</div>;
    }
    return (
      <div className="space-y-3">
        {messages.map((msg) => {
          const toneClass = toneClasses[msg.tone] ?? toneClasses.info;
          return (
            <div key={msg.id} className={`rounded border p-3 shadow-sm ${toneClass}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-base font-semibold leading-tight">{msg.title}</h3>
                <div className="text-xs opacity-80">{formatTime(msg.createdAt)}</div>
              </div>
              <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap">{msg.body}</p>
              {msg.source ? (
                <div className="mt-2 text-xs uppercase tracking-wide opacity-75">
                  Source: {msg.source}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }, [error, loading, messages]);

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Messages</h1>
        <p className="text-sm text-muted-foreground">
          Recent system events and Grundner release notifications.
        </p>
      </header>
      <section className="flex-1 overflow-auto">
        {content}
      </section>
    </div>
  );
}
