import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { SidebarProvider, SidebarInset, useSidebar } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/AppSidebar';
import type {
  AlarmEntry,
  DiagnosticsLogSummary,
  DiagnosticsLogTailRes,
  DiagnosticsSnapshot,
  MachineHealthEntry,
  NcCatValidationReport
} from '../../../shared/src';
import { cn } from '../utils/cn';
import { selectCurrentAlarms } from './alarmUtils';
import { NcCatValidationResultsModal } from '@/components/NcCatValidationResultsModal';
import { Button } from '@/components/ui/button';
import { PanelLeft } from 'lucide-react';
import { formatAuDate, formatAuDateTime, formatAuTime } from '@/utils/datetime';

// Nav is defined in AppSidebar; no local nav here.
const PAGE_TITLES: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/jobs': 'Jobs',
  '/history': 'History',
  '/machines': 'Machines',
  '/grundner': 'Grundner',
  '/allocated-material': 'Allocated Material',
  '/router': 'Router',
  '/telemetry': 'Telemetry',
  '/messages': 'Messages',
  '/cnc-alarms': 'CNC Alarms',
  '/ordering': 'Ordering'
};

function SidebarToggleButton() {
  const { toggleSidebar, open, isMobile } = useSidebar();

  return (
    <button
      type="button"
      className={cn(
        'flex items-center justify-center rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-sm text-[var(--foreground)] hover:bg-[var(--accent-blue-subtle)] hover:border-[var(--accent-blue-border)] transition-all duration-150'
      )}
      onClick={toggleSidebar}
      title={isMobile ? 'Open menu' : open ? 'Collapse sidebar' : 'Expand sidebar'}
    >
      <PanelLeft className="size-4" />
    </button>
  );
}

export function AppLayout() {
  const { pathname } = useLocation();
  const pageTitle = PAGE_TITLES[pathname] || pathname;
  const isSettingsPage = false;

  const [alarms, setAlarms] = useState<AlarmEntry[]>([]);
  const [dismissedAlarmIds, setDismissedAlarmIds] = useState<Set<string>>(new Set());
  const alarmTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [showAlarmPanel, setShowAlarmPanel] = useState(false);

  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [copyingDiagnostics, setCopyingDiagnostics] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [restartingWatchers, setRestartingWatchers] = useState(false);
  const [logList, setLogList] = useState<DiagnosticsLogSummary[]>([]);
  const [logListLoading, setLogListLoading] = useState(false);
  const [logSelectedFile, setLogSelectedFile] = useState<string | null>(null);
  const [logLimit, setLogLimit] = useState(200);
  const [logTail, setLogTail] = useState<DiagnosticsLogTailRes | null>(null);
  const logTailRef = useRef<DiagnosticsLogTailRes | null>(null);
  const [logLinesLive, setLogLinesLive] = useState<string[] | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [latestValidationReport, setLatestValidationReport] = useState<NcCatValidationReport | null>(null);
  const [validationReportHistory, setValidationReportHistory] = useState<NcCatValidationReport[]>([]);
  const [validationResultsOpen, setValidationResultsOpen] = useState(false);
  const [validationReportsLoading, setValidationReportsLoading] = useState(false);
  const [validationReportsError, setValidationReportsError] = useState<string | null>(null);

  const dismissAlarm = useCallback((id: string) => {
    const t = alarmTimers.current.get(id);
    if (t) {
      clearTimeout(t);
      alarmTimers.current.delete(id);
    }
    setDismissedAlarmIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    setAlarms((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const clearAllToasts = useCallback(() => {
    for (const a of alarms) {
      dismissAlarm(a.id);
    }
  }, [alarms, dismissAlarm]);

  const applyAlarms = useCallback((entries: AlarmEntry[]) => {
    const current = selectCurrentAlarms(entries);
    const visible = current.filter((a) => !dismissedAlarmIds.has(a.id));

    // Schedule auto-hide for new visible alarms
    for (const a of visible) {
      if (!alarmTimers.current.has(a.id)) {
        const ms = a.severity === 'critical' ? 30000 : 10000; // critical: 30s, others: 10s
        const t = setTimeout(() => {
          dismissAlarm(a.id);
          alarmTimers.current.delete(a.id);
        }, ms);
        alarmTimers.current.set(a.id, t);
      }
    }

    // Clear timers for alarms no longer visible
    for (const [id, t] of Array.from(alarmTimers.current.entries())) {
      if (!visible.some((a) => a.id === id)) {
        clearTimeout(t);
        alarmTimers.current.delete(id);
      }
    }

    setAlarms(visible);
  }, [dismissedAlarmIds, dismissAlarm]);

  const fetchLogList = useCallback(async () => {
    setLogListLoading(true);
    setLogError(null);
    try {
      const res = await window.api.diagnostics.listLogs();
      if (!res.ok) {
        setLogError(res.error.message);
        setLogList([]);
        setLogSelectedFile(null);
        setLogTail(null);
        return;
      }
      const items: DiagnosticsLogSummary[] = res.value.items;
      setLogList(items);
      if (!items.length) {
        setLogSelectedFile(null);
        setLogTail(null);
        return;
      }
      setLogSelectedFile((prev) => {
        if (prev && items.some((item: DiagnosticsLogSummary) => item.file === prev)) return prev;
        return items[0].file;
      });
    } catch (err) {
      setLogError(err instanceof Error ? err.message : String(err));
    } finally {
      setLogListLoading(false);
    }
  }, []);

  const fetchLogTail = useCallback(async (file: string, limit: number) => {
    setLogLoading(true);
    setLogError(null);
    try {
      const res = await window.api.diagnostics.logTail({ file, limit });
      if (!res.ok) {
        setLogTail(null);
        setLogError(res.error.message);
        return;
      }
      const data = res.value;
      // Avoid unnecessary rerenders to reduce flicker
      const prev = logTailRef.current;
      const unchanged =
        prev != null &&
        prev.file === data.file &&
        prev.limit === data.limit &&
        prev.available === data.available &&
        prev.size === data.size &&
        prev.updatedAt === data.updatedAt &&
        prev.lines.length === data.lines.length &&
        prev.lines[prev.lines.length - 1] === data.lines[data.lines.length - 1];
      if (!unchanged) {
        setLogTail(data);
      }
      if (data.limit !== logLimit) setLogLimit(data.limit);
      setLogList((items: DiagnosticsLogSummary[]) =>
        items.map((item) => (item.file === data.file ? { ...item, size: data.size, updatedAt: data.updatedAt } : item))
      );
    } catch (err) {
      setLogTail(null);
      setLogError(err instanceof Error ? err.message : String(err));
    } finally {
      setLogLoading(false);
    }
  }, [logLimit]);

  const refreshLogTail = useCallback(() => {
    if (logSelectedFile) {
      fetchLogTail(logSelectedFile, logLimit);
    }
  }, [fetchLogTail, logLimit, logSelectedFile]);

  useEffect(() => {
    let cancelled = false;
    window.api.alarms
      .list()
      .then((res) => {
        if (cancelled) return;
        if (res.ok) applyAlarms(res.value);
      })
      .catch((err) => console.error('Failed to load alarms', err));
    const unsubscribe = window.api.alarms.subscribe((next) => {
      if (!cancelled) applyAlarms(next);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [applyAlarms]);

  const validationKeyOf = useCallback((r: NcCatValidationReport) => `${r.reason}|${r.folderName}|${r.processedAt}`, []);

  const mergeValidationReports = useCallback(
    (primary: NcCatValidationReport[], secondary: NcCatValidationReport[]) => {
      const seen = new Set<string>();
      const next: NcCatValidationReport[] = [];
      for (const list of [primary, secondary]) {
        for (const r of list) {
          const key = validationKeyOf(r);
          if (seen.has(key)) continue;
          seen.add(key);
          next.push(r);
        }
      }
      return next;
    },
    [validationKeyOf]
  );

  const loadValidationReports = useCallback(async () => {
    setValidationReportsLoading(true);
    setValidationReportsError(null);
    try {
      const res = await window.api.validation.listHeadlessReports({ limit: 50 });
      if (!res.ok) {
        setValidationReportsError(res.error.message);
        setValidationReportsLoading(false);
        return;
      }

      setValidationReportHistory((prev) => {
        const merged = mergeValidationReports(res.value.items, prev).slice(0, 50);
        setLatestValidationReport(merged[0] ?? null);
        return merged;
      });
    } catch (err) {
      setValidationReportsError(err instanceof Error ? err.message : String(err));
    } finally {
      setValidationReportsLoading(false);
    }
  }, [mergeValidationReports]);

  const handleValidationReport = useCallback(
    (report: NcCatValidationReport) => {
      setValidationReportHistory((prev) => {
        const merged = mergeValidationReports([report], prev).slice(0, 50);
        setLatestValidationReport(merged[0] ?? report);
        return merged;
      });
      setValidationResultsOpen(true);
    },
    [mergeValidationReports]
  );

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = window.api.validation.subscribeHeadlessResults((report) => {
      if (cancelled) return;
      handleValidationReport(report);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [handleValidationReport]);

  useEffect(() => {
    void loadValidationReports();
  }, [loadValidationReports]);

  useEffect(() => {
    const handler = (event: Event) => {
      const customEvent = event as CustomEvent<NcCatValidationReport>;
      if (!customEvent.detail) return;
      handleValidationReport(customEvent.detail);
    };
    window.addEventListener('nc-cat-validation-results', handler);
    return () => {
      window.removeEventListener('nc-cat-validation-results', handler);
    };
  }, [handleValidationReport]);

  useEffect(() => {
    let cancelled = false;
    window.api.diagnostics
      .get()
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          console.error('Failed to load diagnostics snapshot', res.error);
          return;
        }
        setDiagnostics(res.value);
      })
      .catch((err) => console.error('Failed to load diagnostics snapshot', err));
    const unsubscribe = window.api.diagnostics.subscribe((snapshot) => {
      if (!cancelled) setDiagnostics(snapshot);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!copyFeedback) return;
    const timer = setTimeout(() => setCopyFeedback(null), 5000);
    return () => clearTimeout(timer);
  }, [copyFeedback]);

  useEffect(() => {
    if (!showDiagnostics) return;
    fetchLogList();
  }, [fetchLogList, showDiagnostics]);

  useEffect(() => {
    if (!showDiagnostics) return;
    if (!logSelectedFile) return;
    // Initial fetch
    fetchLogTail(logSelectedFile, logLimit);
    // Subscribe stream if available; otherwise fallback to light polling
    type DiagApi = { subscribeLog?: (file: string, listener: (payload: { file: string; lines: string[] }) => void) => () => void };
    const diagApi = (window as unknown as { api?: { diagnostics?: DiagApi } }).api?.diagnostics;
    const maybeSub = diagApi?.subscribeLog;
    if (typeof maybeSub === 'function') {
      const unsubscribe = maybeSub(logSelectedFile, ({ lines }: { file: string; lines: string[] }) => {
        if (!Array.isArray(lines) || lines.length === 0) return;
        setLogLinesLive((prev) => {
          const next = prev ? [...lines].reverse().concat(prev) : [...lines].reverse();
          return next.slice(0, Math.max(2000, logLimit));
        });
      });
      return () => {
        unsubscribe?.();
      };
    } else {
      const id = setInterval(() => {
        fetchLogTail(logSelectedFile, logLimit);
      }, 1000);
      return () => clearInterval(id);
    }
  }, [fetchLogTail, logLimit, logSelectedFile, showDiagnostics]);

  const activeAlarmCount = alarms.length;
  const hasActiveAlarms = activeAlarmCount > 0;
  const diagnosticsWatchers = diagnostics?.watchers ?? [];
  const diagnosticsErrors = diagnostics?.recentErrors ?? [];
  const machineHealthEntries: MachineHealthEntry[] = diagnostics?.machineHealth ?? [];
  const machineHealthAlerts = machineHealthEntries.filter((issue) => issue.severity !== 'info');
  const watcherIssues = diagnosticsWatchers.filter((watcher) => watcher.status !== 'watching');
  const recentErrorIsFresh = diagnosticsErrors.some((entry) => {
    const parsed = Date.parse(entry.timestamp);
    return !Number.isNaN(parsed) && Date.now() - parsed < 15 * 60 * 1000;
  });
  const diagnosticsAlertCount =
    machineHealthAlerts.length + watcherIssues.length + (recentErrorIsFresh ? 1 : 0);
  const hasDiagnosticsAlert = diagnosticsAlertCount > 0;
  const selectedLogSummary = useMemo(
    () => logList.find((item) => item.file === logSelectedFile) ?? null,
    [logList, logSelectedFile]
  );
  const logLines = useMemo(() => (logLinesLive ?? (logTail?.lines ? [...logTail.lines].reverse() : [])), [logLinesLive, logTail]);
  const logAvailable = logTail?.available ?? null;
  const validationAlertCount = useMemo(() => {
    if (!latestValidationReport) return 0;
    let count = 0;
    for (const file of latestValidationReport.files) {
      if (file.status !== 'pass') count += 1;
    }
    return count;
  }, [latestValidationReport]);

  // Keep a ref of the latest tail for equality checks
  useEffect(() => {
    logTailRef.current = logTail;
  }, [logTail]);

  const toggleAlarmPanel = () => {
    setShowAlarmPanel((prev) => {
      const next = !prev;
      if (next) setShowDiagnostics(false);
      return next;
    });
  };

  const toggleDiagnosticsPanel = () => {
    setShowDiagnostics((prev) => {
      const next = !prev;
      if (next) setShowAlarmPanel(false);
      return next;
    });
  };

  const handleCopyDiagnostics = async () => {
    setCopyingDiagnostics(true);
    setCopyFeedback(null);
    const res = await window.api.diagnostics.copy();
    if (!res.ok) {
      setCopyFeedback({ type: 'error', message: `Copy failed: ${res.error.message}` });
      setCopyingDiagnostics(false);
      return;
    }
    const { logCount } = res.value;
    setCopyFeedback({
      type: 'success',
      message: `Copied diagnostics snapshot (${logCount} log${logCount === 1 ? '' : 's'}) to clipboard.`
    });
    setCopyingDiagnostics(false);
  };

  const handleRestartWatchers = async () => {
    if (!confirm('Restart all watchers? This will temporarily stop monitoring until watchers reinitialize.')) {
      return;
    }
    setRestartingWatchers(true);
    setCopyFeedback(null);
    const res = await window.api.diagnostics.restartWatchers();
    if (!res.ok) {
      setCopyFeedback({ type: 'error', message: `Restart failed: ${res.error.message}` });
      setRestartingWatchers(false);
      return;
    }
    setCopyFeedback({
      type: 'success',
      message: 'Watchers restarted successfully. Monitoring will resume shortly.'
    });
    setRestartingWatchers(false);
  };

  const alarmBadgeClass = cn(
    'inline-flex min-w-[1.5rem] items-center justify-center rounded-full px-1.5 text-xs font-medium',
    'bg-white/20 text-white'
  );

  const diagnosticsBadgeClass = cn(
    'inline-flex min-w-[1.5rem] items-center justify-center rounded-full px-1.5 text-xs font-medium',
    'bg-white/20 text-white'
  );

  return (
    <SidebarProvider style={{ '--sidebar-width': '12rem', '--header-height': '3rem' } as React.CSSProperties}>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] px-3 bg-[var(--card)] shadow-sm">
          <div className="flex items-center gap-2">
            <SidebarToggleButton />
            <div className="page-title-gradient">{pageTitle}</div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => {
                setValidationResultsOpen(true);
                void loadValidationReports();
              }}
              title={
                validationReportsLoading
                  ? 'Loading validation history...'
                  : validationReportsError
                    ? `Failed to load validations: ${validationReportsError}`
                    : 'View NC-Cat validation results'
              }
            >
              Validations
              {validationAlertCount > 0 && <span className={diagnosticsBadgeClass}>{validationAlertCount}</span>}
            </Button>
            <Button size="sm" variant="destructive" onClick={toggleAlarmPanel}>
              Alarms
              <span className={alarmBadgeClass}>{activeAlarmCount}</span>
            </Button>
            <Button size="sm" onClick={toggleDiagnosticsPanel}>
              Diagnostics
              {diagnosticsAlertCount > 0 && <span className={diagnosticsBadgeClass}>{diagnosticsAlertCount}</span>}
            </Button>
          </div>
        </header>

        <main className={cn(isSettingsPage ? 'flex-1 min-h-0 overflow-auto' : 'flex-1 min-h-0 overflow-y-auto overflow-x-auto', 'p-4 min-w-0')}>
          <Outlet />
        </main>

        <NcCatValidationResultsModal
          open={validationResultsOpen}
          onOpenChange={setValidationResultsOpen}
          latestReport={latestValidationReport}
          historyReports={validationReportHistory}
          loading={validationReportsLoading}
          loadError={validationReportsError}
          onRefresh={() => void loadValidationReports()}
        />

        {alarms.length > 0 && (
          <div className="fixed right-8 top-16 z-50 space-y-2">
            <div className="flex justify-end">
              <button className="rounded border border-[var(--border)] bg-[var(--status-error-bg)] px-3 py-1.5 text-xs text-[var(--status-error-text)] hover:bg-[var(--accent)] transition-colors" title="Clear all toasts" onClick={clearAllToasts}>
                Clear All
              </button>
            </div>
            {alarms.map((alarm) => (
              <div
                key={alarm.id}
                className="relative w-72 rounded border border-[var(--status-error-border)] bg-[var(--status-error-bg)] p-3 shadow-lg"
              >
                <button
                  className="absolute right-1 top-1 rounded px-1 text-xs text-[var(--status-error-text)] hover:bg-[var(--accent)]"
                  title="Dismiss"
                  onClick={() => dismissAlarm(alarm.id)}
                >
                  X
                </button>
                <div className="space-y-1">
                  <div className="text-sm font-semibold text-[var(--status-error-text)]">{alarm.alarm}</div>
                  <div className="text-xs text-[var(--muted-foreground)]">{alarm.key}</div>
                  {alarm.status && <div className="text-xs text-[var(--muted-foreground)]">Status: {alarm.status}</div>}
                </div>
              </div>
            ))}
          </div>
        )}

      {showAlarmPanel && (
        <div className="fixed right-4 top-16 z-40 w-80 rounded border border-[var(--border)] bg-[var(--card)] shadow-lg">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
            <div className="text-sm font-semibold text-[var(--foreground)]">Active Alarms</div>
            <button className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]" onClick={() => setShowAlarmPanel(false)}>
              Close
            </button>
          </div>
          <div className="max-h-80 space-y-2 overflow-y-auto p-3 text-sm">
            {alarms.length === 0 ? (
              <div className="text-[var(--muted-foreground)]">No active alarms.</div>
            ) : (
              alarms.map((alarm) => (
                <div key={alarm.id} className="rounded border border-[var(--border)] p-2 bg-[var(--background)]">
                  <div className="font-medium text-[var(--foreground)]">{alarm.key}</div>
                  <div className="text-sm text-[var(--foreground)]">{alarm.alarm}</div>
                  {alarm.mode && <div className="text-xs text-[var(--muted-foreground)]">Mode: {alarm.mode}</div>}
                  {alarm.status && <div className="text-xs text-[var(--muted-foreground)]">Status: {alarm.status}</div>}
                  {alarm.lastSeenAt && (
                    <div className="text-xs text-[var(--muted-foreground)]">
                      Last seen {formatAuTime(alarm.lastSeenAt)}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
      {showDiagnostics && (
        <div className="fixed right-4 top-16 bottom-4 z-40 w-[1040px] rounded border border-[var(--border)] bg-[var(--card)] shadow-lg flex flex-col min-h-0">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
            <div className="text-sm font-semibold text-[var(--foreground)]">Diagnostics</div>
            <div className="flex items-center gap-2">
              <button
                className="text-xs rounded border border-[var(--status-warning-border)] px-2 py-1 bg-[var(--status-warning-bg)] text-[var(--status-warning-text)] hover:opacity-80 transition-opacity"
                onClick={handleRestartWatchers}
                disabled={restartingWatchers}
              >
                {restartingWatchers ? 'Restarting...' : 'Restart Watchers'}
              </button>
              <button
                className="text-xs rounded border border-[var(--border)] px-2 py-1 text-[var(--foreground)] hover:bg-[var(--accent-blue-subtle)] hover:border-[var(--accent-blue-border)] transition-all duration-150"
                onClick={handleCopyDiagnostics}
                disabled={copyingDiagnostics}
              >
                {copyingDiagnostics ? 'Copying...' : 'Copy Diagnostics'}
              </button>
              <button className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]" onClick={() => setShowDiagnostics(false)}>
                Close
              </button>
            </div>
          </div>
          <div className="flex-1 min-h-0 p-3 text-sm overflow-hidden text-[var(--foreground)]">
            {copyFeedback && (
              <div
                className={cn(
                  'rounded border px-2 py-1 text-xs',
                  copyFeedback.type === 'success'
                    ? 'border-[var(--status-success-border)] bg-[var(--status-success-bg)] text-[var(--status-success-text)]'
                    : 'border-[var(--status-error-border)] bg-[var(--status-error-bg)] text-[var(--status-error-text)]'
                )}
              >
                {copyFeedback.message}
              </div>
            )}
            <div className="flex flex-col gap-4 h-full min-h-0">
            <section className="shrink-0">
              <div className="text-xs uppercase text-muted-foreground">System Status</div>
              <div className="mt-2 flex flex-wrap items-center gap-4">
                <span
                  className={cn(
                    'h-2.5 w-2.5 rounded-full',
                    diagnostics?.dbStatus?.online ? 'bg-emerald-500' : 'bg-red-500'
                  )}
                  aria-hidden
                />
                <div className="flex flex-col">
                  <span>{diagnostics?.dbStatus?.online ? 'Database online' : 'Database offline'}</span>
                  {typeof diagnostics?.dbStatus?.latencyMs === 'number' && (
                    <span className="text-xs text-muted-foreground">{diagnostics.dbStatus.latencyMs} ms</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'h-2.5 w-2.5 rounded-full',
                      watcherIssues.length === 0 ? 'bg-emerald-500' : 'bg-amber-500'
                    )}
                    aria-hidden
                  />
                  <span>
                    {watcherIssues.length === 0
                      ? 'All watchers healthy'
                      : `${watcherIssues.length} watcher${watcherIssues.length === 1 ? '' : 's'} need attention`}
                  </span>
                </div>
              </div>
              {diagnostics?.dbStatus?.error && (
                <div className="mt-1 text-xs text-[var(--status-error-text)]">{diagnostics.dbStatus.error}</div>
              )}
              {watcherIssues.length > 0 && (
                <ul className="mt-3 space-y-1">
                  {watcherIssues.map((watcher) => {
                    const statusClass =
                      watcher.status === 'error'
                        ? 'border-[var(--status-error-border)] bg-[var(--status-error-bg)] text-[var(--status-error-text)]'
                        : 'border-[var(--status-warning-border)] bg-[var(--status-warning-bg)] text-[var(--status-warning-text)]';
                    return (
                      <li
                        key={watcher.name}
                        className={cn(
                          'flex items-center justify-between rounded border px-2 py-1 text-xs',
                          statusClass
                        )}
                      >
                        <span className="font-medium truncate pr-2" title={watcher.label}>{watcher.label}</span>
                        <span className="uppercase font-semibold">{watcher.status}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {machineHealthEntries.length > 0 && (
                <div className="mt-3 space-y-2">
                  <div className="text-xs uppercase text-[var(--muted-foreground)]">Machine Health</div>
                  {machineHealthEntries.map((issue) => (
                    <div key={issue.id} className="rounded border border-[var(--border)] p-2 bg-[var(--background)]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-[var(--foreground)]">
                          {issue.machineId != null ? `Machine ${issue.machineId}` : 'General'}
                        </span>
                        <span
                          className={cn(
                            'text-xs font-semibold uppercase tracking-wide',
                            issue.severity === 'critical'
                              ? 'text-[var(--status-error-text)]'
                              : issue.severity === 'warning'
                              ? 'text-[var(--status-warning-text)]'
                              : 'text-[var(--muted-foreground)]'
                          )}
                        >
                          {issue.code.replace(/_/g, ' ')}
                        </span>
                      </div>
                      <div className="mt-1 text-sm text-[var(--foreground)]">{issue.message}</div>
                      <div className="text-xs text-[var(--muted-foreground)]">
                        {formatAuTime(issue.lastUpdatedAt)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
            <section className="shrink-0">
              <div className="text-xs uppercase text-[var(--muted-foreground)]">Recent Errors</div>
              <div className="mt-2 space-y-2 max-h-72 overflow-y-auto rounded border border-[var(--border)] bg-[var(--background)] p-2">
                {diagnosticsErrors.length === 0 ? (
                  <div className="text-xs text-[var(--muted-foreground)]">No errors recorded.</div>
                ) : (
                  diagnosticsErrors.slice(0, 8).map((entry) => (
                    <div key={entry.id} className="rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1">
                      <div className="text-xs text-[var(--muted-foreground)]">
                        {formatAuDateTime(entry.timestamp)}
                      </div>
                      <div className="text-sm font-medium text-[var(--foreground)]">{entry.source}</div>
                      <div className="text-[var(--foreground)]">{entry.message}</div>
                    </div>
                  ))
                )}
              </div>
            </section>
            <section className="flex-1 min-h-0">
              <div className="text-sm  text-[var(--muted-foreground)]">Logs</div>
              <div className="mt-2 space-y-2 flex flex-col min-h-0">
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className="border border-[var(--border)] rounded px-2 py-1 text-xs bg-[var(--input-bg)] text-[var(--foreground)]"
                    value={logSelectedFile ?? ""}
                    onChange={(e) => setLogSelectedFile(e.target.value ? e.target.value : null)}
                    disabled={logListLoading || logList.length === 0}
                  >
                    {logList.map((item) => (
                      <option key={item.file} value={item.file}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  <select
                    className="border border-[var(--border)] rounded px-2 py-1 text-xs bg-[var(--input-bg)] text-[var(--foreground)]"
                    value={logLimit}
                    onChange={(e) => setLogLimit(Number(e.target.value))}
                    disabled={logLoading || !logSelectedFile}
                  >
                    {[200, 500, 1000, 2000].map((value) => (
                      <option key={value} value={value}>
                        {value} lines
                      </option>
                    ))}
                  </select>
                  <button
                    className="border border-[var(--border)] rounded px-2 py-1 text-xs text-[var(--foreground)] hover:bg-[var(--accent-blue-subtle)] hover:border-[var(--accent-blue-border)] transition-all duration-150"
                    onClick={fetchLogList}
                    disabled={logListLoading}
                  >
                    Refresh List
                  </button>
                  <button
                    className="border border-[var(--border)] rounded px-2 py-1 text-xs text-[var(--foreground)] hover:bg-[var(--accent-blue-subtle)] hover:border-[var(--accent-blue-border)] transition-all duration-150"
                    onClick={refreshLogTail}
                    disabled={logLoading || !logSelectedFile}
                  >
                    Reload Log
                  </button>
                </div>
                {logListLoading && logList.length === 0 ? (
                  <div className="text-xs text-[var(--muted-foreground)]">Loading logs...</div>
                ) : logList.length === 0 ? (
                  <div className={cn('text-xs', logError ? 'text-[var(--status-error-text)]' : 'text-[var(--muted-foreground)]')}>
                    {logError ? `Load failed: ${logError}` : 'No log files available.'}
                  </div>
                ) : (
                  <>
                    {logTail && (
                      <div className="text-xs text-[var(--muted-foreground)]">
                        Showing {logLines.length} {logLines.length === 1 ? "line" : "lines"}
                        {logAvailable != null ? ` of ${logAvailable}` : ""} (limit {logLimit})
                      </div>
                    )}
                    {logError && <div className="text-xs text-[var(--status-error-text)]">{logError}</div>}
                    <div className="flex-1 min-h-380 min-h-[380px] overflow-y-scroll rounded border border-[var(--border)] bg-[var(--background)]">
                      <pre
                        key={logSelectedFile ?? 'none'}
                        className="w-max min-w-full px-2 py-2 font-sans text-xs leading-snug whitespace-pre text-[var(--foreground)] font-semibold"
                      >
                        {logLoading
                          ? 'Loading log...'
                          : logLines.length
                            ? logLines.join('\n')
                            : 'No log lines to display.'}
                      </pre>
                    </div>
                  </>
                )}
              </div>
            </section>
          </div>
          </div>
        </div>
      )}
      </SidebarInset>
    </SidebarProvider>
  );
}
