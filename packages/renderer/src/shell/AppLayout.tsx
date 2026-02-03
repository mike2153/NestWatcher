import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { SidebarProvider, SidebarInset, useSidebar } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/AppSidebar';
import type {
  AlarmEntry,
  DiagnosticsLogSummary,
  DiagnosticsLogTailRes,
  DiagnosticsSnapshot,
  DbStatus,
  MachineHealthEntry,
  NcCatValidationReport
} from '../../../shared/src';
import { cn } from '../utils/cn';
import { selectCurrentAlarms } from './alarmUtils';
import { NcCatValidationResultsModal } from '@/components/NcCatValidationResultsModal';
import { AppDialogHost } from '@/components/AppDialogHost';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PanelLeft } from 'lucide-react';
import { formatAuDateTime, formatAuTime } from '@/utils/datetime';

// Nav is defined in AppSidebar; no local nav here.
const PAGE_TITLES: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/jobs': 'Jobs',
  '/history': 'History',
  '/machines': 'Machines',
  '/grundner': 'Grundner',
  '/router': 'Router',
  '/telemetry': 'Telemetry',
  '/messages': 'Messages',
  '/cnc-alarms': 'CNC Alarms',
  '/ordering': 'Ordering'
};

function isAdminToolsPopoutWindow(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('window') === 'admin-tools';
  } catch {
    return false;
  }
}

function AdminToolsPopoutLayout() {
  // The popout window should ONLY show the Admin Tools page content.
  // No sidebar, no top header, and no diagnostics/alarm overlays.
  return (
    <div className="min-h-screen bg-[var(--background)]">
      <Outlet />
    </div>
  );
}

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

function FullAppLayout() {
  const { pathname } = useLocation();
  const pageTitle = PAGE_TITLES[pathname] || pathname;
  const isSettingsPage = false;

  const [dbStatus, setDbStatus] = useState<DbStatus | null>(null);

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

  useEffect(() => {
    let cancelled = false;

    window.api.db
      .getStatus()
      .then((res) => {
        if (cancelled) return;
        if (res.ok) setDbStatus(res.value);
      })
      .catch(() => {
        // ignore; we'll rely on subscribe updates
      });

    const unsubscribe = window.api.db.subscribeStatus((status) => {
      if (!cancelled) setDbStatus(status);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

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
    // Reset live override so we show the file tail again.
    setLogLinesLive(null);
    if (logSelectedFile) {
      fetchLogTail(logSelectedFile, logLimit);
    }
  }, [fetchLogTail, logLimit, logSelectedFile]);

  const handleClearDiagnosticsViews = useCallback(async () => {
    // Intentionally do NOT clear log output.
    // The log view is always "tail of file" and limited by the line count selector.
    try {
      const res = await window.api.diagnostics.clearErrors();
      if (!res.ok) {
        setCopyFeedback({ type: 'error', message: `Clear failed: ${res.error.message}` });
        return;
      }
      setCopyFeedback({ type: 'success', message: 'Cleared recent errors.' });
    } catch (err) {
      setCopyFeedback({ type: 'error', message: `Clear failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }, []);

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

  const coalesceValidationHistory = useCallback((reports: NcCatValidationReport[]) => {
    const COALESCE_WINDOW_MS = 30_000;
    const norm = (s: string) => (s ?? '').trim().replace(/\s+/g, ' ');
    const ts = (iso: string) => new Date(iso).getTime();

    const severity = (s: NcCatValidationReport['overallStatus']) => (s === 'errors' ? 2 : s === 'warnings' ? 1 : 0);
    const mergeTwo = (a: NcCatValidationReport, b: NcCatValidationReport): NcCatValidationReport => {
      const byName = new Map<string, NcCatValidationReport['files'][number]>();
      const addFile = (f: NcCatValidationReport['files'][number]) => {
        const existing = byName.get(f.filename);
        if (!existing) {
          byName.set(f.filename, {
            filename: f.filename,
            status: f.status,
            warnings: [...(f.warnings ?? [])],
            errors: [...(f.errors ?? [])]
          });
          return;
        }
        const nextStatus = severity(existing.status) >= severity(f.status) ? existing.status : f.status;
        existing.status = nextStatus;
        existing.warnings = Array.from(new Set([...(existing.warnings ?? []), ...(f.warnings ?? [])]));
        existing.errors = Array.from(new Set([...(existing.errors ?? []), ...(f.errors ?? [])]));
      };

      for (const f of a.files) addFile(f);
      for (const f of b.files) addFile(f);

      const files = Array.from(byName.values()).sort((x, y) => x.filename.localeCompare(y.filename));
      const hasErrors = files.some((f) => f.status === 'errors');
      const hasWarnings = files.some((f) => f.status === 'warnings');
      const overallStatus = hasErrors ? 'errors' : hasWarnings ? 'warnings' : 'pass';
      const processedAt = ts(a.processedAt) >= ts(b.processedAt) ? a.processedAt : b.processedAt;

      return {
        ...a,
        processedAt,
        profileName: a.profileName ?? b.profileName ?? null,
        overallStatus,
        files
      };
    };

    const out: NcCatValidationReport[] = [];
    for (const report of reports) {
      const reportTs = ts(report.processedAt);
      let merged = false;
      for (let i = out.length - 1; i >= 0; i -= 1) {
        const candidate = out[i];
        const candidateTs = ts(candidate.processedAt);
        if (Number.isFinite(candidateTs) && Number.isFinite(reportTs)) {
          if (Math.abs(candidateTs - reportTs) > COALESCE_WINDOW_MS) {
            break;
          }
        }
        const sameFolder = norm(candidate.folderName) === norm(report.folderName);
        const sameReason = candidate.reason === report.reason;
        const sameProfile = (candidate.profileName ?? null) === (report.profileName ?? null);
        if (sameFolder && sameReason && sameProfile) {
          out[i] = mergeTwo(candidate, report);
          merged = true;
          break;
        }
      }
      if (!merged) out.push(report);
    }
    return out;
  }, []);

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
        const merged = mergeValidationReports(res.value.items, prev);
        const coalesced = coalesceValidationHistory(merged).slice(0, 50);
        setLatestValidationReport(coalesced[0] ?? null);
        return coalesced;
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
        const merged = mergeValidationReports([report], prev);
        const coalesced = coalesceValidationHistory(merged).slice(0, 50);
        setLatestValidationReport(coalesced[0] ?? report);
        return coalesced;
      });
      setValidationResultsOpen(true);
    },
    [coalesceValidationHistory, mergeValidationReports]
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
    // logSelectedFile can change via the dropdown OR programmatically (e.g. when refreshing the list).
    // Always reset the live buffer on file change so we never mix lines from two different files.
    setLogLinesLive(null);
  }, [logSelectedFile]);

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
          // Newest-first for UI, so reverse the incoming chunk.
          const incoming = [...lines].reverse();

          // Keep this as a *buffer of new lines*, not a full replacement of the file tail.
          // The render path combines `logLinesLive + logTail` and slices to `logLimit`.
          const next = prev ? incoming.concat(prev) : incoming;
          return next.slice(0, logLimit);
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
  const logLines = useMemo(() => {
    // Only render the stored tail if it matches the currently selected file.
    // This avoids briefly showing stale lines from a previously-selected file.
    const tail =
      logTail?.file && logSelectedFile && logTail.file === logSelectedFile && logTail.lines
        ? [...logTail.lines].reverse()
        : [];

    // logLinesLive is a small buffer of *new* lines streamed since the last tail fetch.
    // It should never replace the tail; it should prepend to it.
    const live = logLinesLive ?? [];

    // Enforce the UI limit here so we always show a stable "last N lines" window,
    // even as new lines stream in.
    return live.concat(tail).slice(0, logLimit);
  }, [logLimit, logLinesLive, logSelectedFile, logTail]);
  const logAvailable = logTail?.file && logSelectedFile && logTail.file === logSelectedFile ? (logTail.available ?? null) : null;
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
      if (next) {
        // Always render from the file tail on open.
        setLogLinesLive(null);
      }
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

        {dbStatus && !dbStatus.online ? (
          <div className="flex items-center justify-between gap-3 border-b border-red-600/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:border-red-400/30 dark:bg-red-400/10 dark:text-red-300">
            <div>Offline Mode: database not connected</div>
            {dbStatus.error ? (
              <div className="max-w-[65ch] truncate text-xs opacity-80" title={dbStatus.error}>
                {dbStatus.error}
              </div>
            ) : null}
          </div>
        ) : null}

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

        <AppDialogHost />

        {alarms.length > 0 && (
          <div className="fixed right-8 top-16 z-50 space-y-2">
            <div className="flex justify-end">
              <button
                className="rounded border border-red-600/40 dark:border-red-400/40 bg-red-500/25 dark:bg-red-400/20 px-3 py-1.5 text-xs text-red-700 dark:text-red-300 hover:bg-red-500/35 dark:hover:bg-red-400/30 transition-colors"
                title="Clear all toasts"
                onClick={clearAllToasts}
              >
                Clear All
              </button>
            </div>
            {alarms.map((alarm) => (
              <div
                key={alarm.id}
                className="relative w-72 rounded border border-red-600/40 dark:border-red-400/40 bg-red-500/25 dark:bg-red-400/20 p-3 shadow-lg"
              >
                <button
                  className="absolute right-1 top-1 rounded px-1 text-xs text-red-700 dark:text-red-300 hover:bg-red-500/20 dark:hover:bg-red-400/20 transition-colors"
                  title="Dismiss"
                  onClick={() => dismissAlarm(alarm.id)}
                >
                  X
                </button>
                <div className="space-y-1">
                  <div className="text-sm font-semibold text-red-700 dark:text-red-300">{alarm.alarm}</div>
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
        <div className="fixed right-4 top-16 bottom-4 z-40 w-[1040px] rounded border border-[var(--border)] bg-[var(--card)] shadow-lg flex flex-col min-h-0 overflow-hidden">
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
              <div className="mt-2 space-y-2 max-h-72 overflow-y-auto overscroll-contain rounded border border-[var(--border)] bg-[var(--background)] p-2">
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
            <section className="flex-1 min-h-0 flex flex-col">
              <div className="text-sm  text-[var(--muted-foreground)]">Logs</div>
              <div className="mt-2 space-y-2 flex flex-col flex-1 min-h-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={logSelectedFile ?? ""}
                    onValueChange={(v) => {
                      const nextFile = v ? v : null;
                      setLogSelectedFile(nextFile);
                      setLogLinesLive(null);
                    }}
                    disabled={logListLoading || logList.length === 0}
                  >
                    <SelectTrigger className="h-7 text-xs min-w-[120px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {logList.map((item) => (
                        <SelectItem key={item.file} value={item.file}>
                          {item.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={String(logLimit)}
                    onValueChange={(v) => {
                      setLogLimit(Number(v));
                      setLogLinesLive(null);
                    }}
                    disabled={logLoading || !logSelectedFile}
                  >
                    <SelectTrigger className="h-7 text-xs w-24">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[200, 500, 1000, 2000].map((value) => (
                        <SelectItem key={value} value={String(value)}>
                          {value} lines
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={handleClearDiagnosticsViews}
                    title="Clear recent errors"
                    className="h-7 px-2 py-1 text-xs"
                  >
                    Clear Errors
                  </Button>
                </div>
                {logListLoading && logList.length === 0 ? (
                  <div className="text-xs text-[var(--muted-foreground)]">Loading logs...</div>
                ) : logList.length === 0 ? (
                  <div className={cn('text-xs', logError ? 'text-[var(--status-error-text)]' : 'text-[var(--muted-foreground)]')}>
                    {logError ? `Load failed: ${logError}` : 'No log files available.'}
                  </div>
                ) : (
                  <>
                    {logTail?.file && logSelectedFile && logTail.file === logSelectedFile && (
                      <div className="text-xs text-[var(--muted-foreground)]">
                        Showing {logLines.length} {logLines.length === 1 ? "line" : "lines"}
                        {logAvailable != null ? ` of ${logAvailable}` : ""} (limit {logLimit})
                      </div>
                    )}
                    {logError && <div className="text-xs text-[var(--status-error-text)]">{logError}</div>}
                    <div className="flex-1 min-h-0 overflow-y-auto overflow-x-auto overscroll-contain rounded border border-[var(--border)] bg-[var(--background)]">
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

export function AppLayout() {
  return isAdminToolsPopoutWindow() ? <AdminToolsPopoutLayout /> : <FullAppLayout />;
}
