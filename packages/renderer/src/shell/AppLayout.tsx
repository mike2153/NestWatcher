import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/AppSidebar';
import type { AlarmEntry, DiagnosticsLogSummary, DiagnosticsLogTailRes, DiagnosticsSnapshot, MachineHealthEntry, ThemePreference } from '../../../shared/src';
import { cn } from '../utils/cn';
import { selectCurrentAlarms } from './alarmUtils';

// Nav is defined in AppSidebar; no local nav here.
const PAGE_TITLES: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/jobs': 'Jobs',
  '/history': 'History',
  '/machines': 'Machines',
  '/settings': 'Settings',
  '/grundner': 'Grundner',
  '/router': 'Router',
  '/theme': 'Theme',
  '/telemetry': 'Telemetry',
  '/cnc-alarms': 'CNC Alarms'
};

export function AppLayout() {
  const { pathname } = useLocation();
  const pageTitle = PAGE_TITLES[pathname] || pathname;
  const isSettingsPage = pathname === '/settings' || pathname.startsWith('/settings/');

  const [alarms, setAlarms] = useState<AlarmEntry[]>([]);
  const [dismissedAlarmIds, setDismissedAlarmIds] = useState<Set<string>>(new Set());
  const alarmTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [showAlarmPanel, setShowAlarmPanel] = useState(false);

  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [copyingDiagnostics, setCopyingDiagnostics] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [logList, setLogList] = useState<DiagnosticsLogSummary[]>([]);
  const [logListLoading, setLogListLoading] = useState(false);
  const [logSelectedFile, setLogSelectedFile] = useState<string | null>(null);
  const [logLimit, setLogLimit] = useState(200);
  const [logTail, setLogTail] = useState<DiagnosticsLogTailRes | null>(null);
  const logTailRef = useRef<DiagnosticsLogTailRes | null>(null);
  const [logLinesLive, setLogLinesLive] = useState<string[] | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [themePreference, setThemePreference] = useState<ThemePreference>('system');

  const applyThemePreference = useCallback((preference: ThemePreference) => {
    const root = document.documentElement;
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    
    // Remove all theme classes
    root.classList.remove('dark', 'modern');
    
    // Apply the appropriate theme class
    if (preference === "dark") {
      root.classList.add('dark');
    } else if (preference === "modern") {
      root.classList.add('modern');
    } else if (preference === "system") {
      if (prefersDark) {
        root.classList.add('dark');
      }
      // For light system preference, no class needed (default light theme)
    }
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
    if (logSelectedFile) {
      fetchLogTail(logSelectedFile, logLimit);
    }
  }, [fetchLogTail, logLimit, logSelectedFile]);

  const handleThemeChange = useCallback(async (next: ThemePreference) => {
    setThemePreference(next);
    applyThemePreference(next);
    try {
      const res = await window.api.ui.theme.set({ preference: next });
      if (!res.ok) {
        console.error('Failed to persist theme preference', res.error);
      }
    } catch (err) {
      console.error('Failed to persist theme preference', err);
    }
  }, [applyThemePreference]);

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
    let cancelled = false;
    window.api.ui.theme
      .get()
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          console.error('Failed to load theme preference', res.error);
          return;
        }
        setThemePreference(res.value.preference);
      })
      .catch((err) => console.error('Failed to load theme preference', err));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    applyThemePreference(themePreference);
    try {
      window.localStorage.setItem('ui:theme', themePreference);
    } catch (error) {
      console.warn('Failed to persist theme preference locally', error);
    }
  }, [applyThemePreference, themePreference]);

  useEffect(() => {
    if (themePreference !== 'system') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyThemePreference('system');
    query.addEventListener('change', handler);
    return () => query.removeEventListener('change', handler);
  }, [applyThemePreference, themePreference]);

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
  const watcherAlerts = diagnosticsWatchers.filter((watcher) => watcher.status === 'error');
  const recentErrorIsFresh = diagnosticsErrors.some((entry) => {
    const parsed = Date.parse(entry.timestamp);
    return !Number.isNaN(parsed) && Date.now() - parsed < 15 * 60 * 1000;
  });
  const diagnosticsAlertCount =
    machineHealthAlerts.length + watcherAlerts.length + (recentErrorIsFresh ? 1 : 0);
  const hasDiagnosticsAlert = diagnosticsAlertCount > 0;
  const selectedLogSummary = useMemo(
    () => logList.find((item) => item.file === logSelectedFile) ?? null,
    [logList, logSelectedFile]
  );
  const logLines = useMemo(() => (logLinesLive ?? (logTail?.lines ? [...logTail.lines].reverse() : [])), [logLinesLive, logTail]);
  const logAvailable = logTail?.available ?? null;

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

  const alarmBadgeClass = cn(
    'inline-flex min-w-[1.5rem] items-center justify-center rounded-full px-1.5 text-xs font-medium',
    hasActiveAlarms ? 'bg-red-500 text-white' : 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-100'
  );

  const diagnosticsButtonClass = cn(
    'flex items-center gap-1 rounded border px-2 py-1 text-sm',
    hasDiagnosticsAlert && 'border-amber-500 text-amber-600'
  );
  const diagnosticsBadgeClass = cn(
    'inline-flex min-w-[1.5rem] items-center justify-center rounded-full px-1.5 text-xs font-medium',
    diagnosticsAlertCount > 0
      ? 'bg-amber-500 text-white'
      : 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-100'
  );

  return (
    <SidebarProvider style={{ '--sidebar-width': '12rem', '--header-height': '3rem' } as React.CSSProperties}>
  <AppSidebar />
  <SidebarInset>
    <header className="flex h-12 items-center justify-between gap-2 border-b px-3 bg-card/95 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-card/80">
      <div className="flex items-center gap-2">
        <div className="page-title-gradient">{pageTitle}</div>
      </div>
      <div className="flex items-center gap-2">
        <button
          className={cn('flex items-center gap-1 rounded border px-2 py-1 text-sm', hasActiveAlarms && 'border-red-500 text-red-600')}
          onClick={toggleAlarmPanel}
        >
          Alarms
          <span className={alarmBadgeClass}>{activeAlarmCount}</span>
        </button>
        <button className={diagnosticsButtonClass} onClick={toggleDiagnosticsPanel}>
          Diagnostics
          {diagnosticsAlertCount > 0 && <span className={diagnosticsBadgeClass}>{diagnosticsAlertCount}</span>}
        </button>
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">Theme</label>
          <select
            className="rounded border px-2 py-1 text-sm"
            value={themePreference}
            onChange={(e) => handleThemeChange(e.target.value as ThemePreference)}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
      </div>
    </header>
    <main className={cn(isSettingsPage ? 'overflow-auto' : 'overflow-y-auto overflow-x-hidden', 'p-4 min-w-0')}>
      <Outlet />
    </main>{alarms.length > 0 && (
        <div className="fixed right-8 top-16 z-50 space-y-2">
          <div className="flex justify-end">
            <button className="rounded border border-slate-800 bg-red-400 px-3 py-1.5 text-xs text-slate-900 hover:bg-red-300 hover:text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-blue-500" title="Clear all toasts" onClick={clearAllToasts}>
              Clear All
            </button>
          </div>
          {alarms.map((alarm) => (
            <div
              key={alarm.id}
              className="relative w-72 rounded border border-red-200 bg-red-100 p-3 shadow-lg dark:border-red-700 dark:bg-red-950/70"
            >
              <button
                className="absolute right-1 top-1 rounded px-1 text-xs text-red-700 hover:bg-red-100 dark:text-red-300 dark:hover:bg-red-900/40"
                title="Dismiss"
                onClick={() => dismissAlarm(alarm.id)}
              >
                X
              </button>
              <div className="space-y-1">
                <div className="text-sm font-semibold text-red-700 dark:text-red-300">{alarm.alarm}</div>
                <div className="text-xs text-muted-foreground">{alarm.key}</div>
                {alarm.status && <div className="text-xs text-muted-foreground">Status: {alarm.status}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {showAlarmPanel && (
        <div className="fixed right-4 top-16 z-40 w-80 rounded border bg-background shadow-lg">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <div className="text-sm font-semibold">Active Alarms</div>
            <button className="text-xs text-muted-foreground" onClick={() => setShowAlarmPanel(false)}>
              Close
            </button>
          </div>
          <div className="max-h-80 space-y-2 overflow-y-auto p-3 text-sm">
            {alarms.length === 0 ? (
              <div className="text-muted-foreground">No active alarms.</div>
            ) : (
              alarms.map((alarm) => (
                <div key={alarm.id} className="rounded border p-2">
                  <div className="font-medium">{alarm.key}</div>
                  <div className="text-sm">{alarm.alarm}</div>
                  {alarm.mode && <div className="text-xs text-muted-foreground">Mode: {alarm.mode}</div>}
                  {alarm.status && <div className="text-xs text-muted-foreground">Status: {alarm.status}</div>}
                  {alarm.lastSeenAt && (
                    <div className="text-xs text-muted-foreground">
                      Last seen {new Date(alarm.lastSeenAt).toLocaleTimeString()}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
      {showDiagnostics && (
        <div className="fixed right-4 top-16 z-40 w-[800px] rounded border bg-background shadow-lg">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <div className="text-sm font-semibold">Diagnostics</div>
            <div className="flex items-center gap-2">
              <button
                className="text-xs rounded border px-2 py-1"
                onClick={handleCopyDiagnostics}
                disabled={copyingDiagnostics}
              >
                {copyingDiagnostics ? 'Copying...' : 'Copy Diagnostics'}
              </button>
              <button className="text-xs text-muted-foreground" onClick={() => setShowDiagnostics(false)}>
                Close
              </button>
            </div>
          </div>
          <div className="space-y-3 p-3 text-sm">
            {copyFeedback && (
              <div
                className={cn(
                  'rounded border px-2 py-1 text-xs',
                  copyFeedback.type === 'success'
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                    : 'border-red-300 bg-red-50 text-red-700'
                )}
              >
                {copyFeedback.message}
              </div>
            )}
            <div>
              <div className="text-xs uppercase text-muted-foreground">Database</div>
              <div className="mt-1 flex items-center gap-2">
                <span
                  className={cn(
                    'h-2.5 w-2.5 rounded-full',
                    diagnostics?.dbStatus?.online ? 'bg-emerald-500' : 'bg-red-500'
                  )}
                  aria-hidden
                />
                <span>{diagnostics?.dbStatus?.online ? 'Online' : 'Offline'}</span>
                {typeof diagnostics?.dbStatus?.latencyMs === 'number' && (
                  <span className="text-xs text-muted-foreground">{diagnostics.dbStatus.latencyMs} ms</span>
                )}
              </div>
              {diagnostics?.dbStatus?.error && (
                <div className="text-xs text-red-600">{diagnostics.dbStatus.error}</div>
              )}
            </div>
            <div>
              <div className="text-xs uppercase text-muted-foreground">Machine Health</div>
              <div className="mt-1 space-y-2">
                {machineHealthEntries.length === 0 ? (
                  <></>
                ) : (
                  machineHealthEntries.map((issue) => (
                    <div key={issue.id} className="rounded border p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">
                          {issue.machineId != null ? `Machine ${issue.machineId}` : 'General'}
                        </span>
                        <span
                          className={cn(
                            'text-xs font-semibold uppercase tracking-wide',
                            issue.severity === 'critical'
                              ? 'text-red-600'
                              : issue.severity === 'warning'
                              ? 'text-amber-600'
                              : 'text-muted-foreground'
                          )}
                        >
                          {issue.code.replace(/_/g, ' ')}
                        </span>
                      </div>
                      <div className="mt-1 text-sm">{issue.message}</div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(issue.lastUpdatedAt).toLocaleTimeString()}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase text-muted-foreground">Watchers</div>
              <div className="mt-1 grid grid-cols-2 gap-2">
                {diagnosticsWatchers.length === 0 ? (
                  <div className="text-xs text-muted-foreground col-span-2">No watcher metrics available.</div>
                ) : (
                  diagnosticsWatchers.map((watcher) => (
                    <div key={watcher.name} className="rounded border p-2">
                      <div className="flex items-center justify-between">
                        <span className="font-medium truncate" title={watcher.label}>{watcher.label}</span>
                        <span
                          className={cn(
                            'text-xs font-semibold uppercase tracking-wide',
                            watcher.status === 'error'
                              ? 'text-red-600'
                              : watcher.status === 'watching'
                              ? 'text-emerald-600'
                              : 'text-muted-foreground'
                          )}
                        >
                          {watcher.status}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase text-muted-foreground">Logs</div>
              <div className="mt-1 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className="border rounded px-2 py-1 text-xs"
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
                    className="border rounded px-2 py-1 text-xs"
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
                    className="border rounded px-2 py-1 text-xs"
                    onClick={fetchLogList}
                    disabled={logListLoading}
                  >
                    Refresh List
                  </button>
                  <button
                    className="border rounded px-2 py-1 text-xs"
                    onClick={refreshLogTail}
                    disabled={logLoading || !logSelectedFile}
                  >
                    Reload Log
                  </button>
                </div>
                {logListLoading && logList.length === 0 ? (
                  <div className="text-xs text-muted-foreground">Loading logs...</div>
                ) : logList.length === 0 ? (
                  <div className={cn('text-xs', logError ? 'text-red-600' : 'text-muted-foreground')}>
                    {logError ? `Load failed: ${logError}` : 'No log files available.'}
                  </div>
                ) : (
                  <>
                    {selectedLogSummary && (
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>{selectedLogSummary.name}</span>
                        <span>
                          Updated {selectedLogSummary.updatedAt ? new Date(selectedLogSummary.updatedAt).toLocaleString() : '-'}
                        </span>
                        <span>
                          Size {typeof selectedLogSummary.size === 'number' ? (selectedLogSummary.size < 1024 ? `${selectedLogSummary.size} B` : `${(selectedLogSummary.size / 1024).toFixed(1)} KB`) : '-'}
                        </span>
                      </div>
                    )}
                    {logTail && (
                      <div className="text-xs text-muted-foreground">
                        Showing {logLines.length} {logLines.length === 1 ? "line" : "lines"}
                        {logAvailable != null ? ` of ${logAvailable}` : ""} (limit {logLimit})
                      </div>
                    )}
                    {logError && <div className="text-xs text-red-600">{logError}</div>}
                    <pre key={logSelectedFile ?? 'none'} className="max-h-96 overflow-auto rounded border bg-muted/40 p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap">
                      {logLoading
                        ? 'Loading log...'
                        : logLines.length
                          ? logLines.join('\n')
                          : 'No log lines to display.'}
                    </pre>
                  </>
                )}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase text-muted-foreground">Recent Errors</div>
              <div className="mt-1 max-h-40 space-y-2 overflow-y-auto">
                {diagnosticsErrors.length === 0 ? (
                  <div className="text-xs text-muted-foreground">No errors recorded.</div>
                ) : (
                  diagnosticsErrors.slice(0, 5).map((entry) => (
                    <div key={entry.id} className="rounded border p-2">
                      <div className="text-xs text-muted-foreground">
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </div>
                      <div className="text-sm font-medium">{entry.source}</div>
                      <div>{entry.message}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      </SidebarInset>
    </SidebarProvider>
  );
}





