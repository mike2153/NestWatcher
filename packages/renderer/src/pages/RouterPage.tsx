import { useCallback, useEffect, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import type {
  DiagnosticsSnapshot,
  Machine,
  JobStatus,
  ReadyFile,
  ReadyListRes
} from '../../../shared/src';
import { JOB_STATUS_VALUES } from '../../../shared/src';
import { cn } from '../utils/cn';
import { GlobalTable } from '@/components/table/GlobalTable';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import type { ColumnDef, RowSelectionState } from '@tanstack/react-table';
import { getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { ValidationDataModal } from '@/components/ValidationDataModal';

const AUTO_REFRESH_ENABLED_KEY = 'router:autoRefresh';
const AUTO_REFRESH_INTERVAL_KEY = 'router:autoRefreshInterval';
const DEFAULT_AUTO_REFRESH_SECONDS = 30;

type RouterReadyFile = ReadyFile & { machineId: number };

// Keep this list in sync with Main's lifecycle rules.
// Purpose: the Router "manual change" dialog should not offer status jumps that will
// always be rejected by the backend with INVALID_TRANSITION.
const MANUAL_ALLOWED_PREVIOUS_STATUSES: Record<JobStatus, JobStatus[]> = {
  PENDING: ['PENDING'],
  STAGED: ['PENDING', 'STAGED'],
  RUNNING: ['STAGED', 'RUNNING'],
  LOAD_FINISH: ['PENDING', 'STAGED', 'RUNNING', 'LOAD_FINISH'],
  LABEL_FINISH: ['STAGED', 'RUNNING', 'LOAD_FINISH', 'LABEL_FINISH'],
  CNC_FINISH: ['STAGED', 'RUNNING', 'LOAD_FINISH', 'LABEL_FINISH', 'CNC_FINISH'],
  FORWARDED_TO_NESTPICK: ['CNC_FINISH', 'FORWARDED_TO_NESTPICK'],
  NESTPICK_COMPLETE: ['FORWARDED_TO_NESTPICK', 'NESTPICK_COMPLETE']
};

// Percent-based widths (normalized by GlobalTable)
const ROUTER_COL_PCT = {
  machine: 12,
  folder: 14,
  name: 18,
  material: 10,
  size: 10,
  parts: 6,
  status: 12,
  staged: 12,
  inDb: 6,
} as const;

function formatIso(value: string | null) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = d.getDate();
  const mon = months[d.getMonth()];
  const year = d.getFullYear();
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12;
  if (h === 0) h = 12;
  return `${day} ${mon} ${year} ${h}:${m}${ampm}`;
}

function formatStatusLabel(value: string) {
  const upper = value.toUpperCase();
  if (upper === 'FORWARDED_TO_NESTPICK') return 'Nestpick Processing';
  const parts = value.split(/[_\s]+/).filter(Boolean).map((p) => p.toLowerCase());
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function statusClass(status: JobStatus) {
  switch (status) {
    case 'CNC_FINISH':
    case 'FORWARDED_TO_NESTPICK':
    case 'NESTPICK_COMPLETE':
      return 'bg-green-100 text-green-800';
    case 'LABEL_FINISH':
    case 'LOAD_FINISH':
      return 'bg-amber-100 text-amber-800';
    case 'STAGED':
    case 'RUNNING':
      return 'bg-cyan-100 text-cyan-800';
    default:
      return 'bg-accent text-accent-foreground';
  }
}

export function RouterPage() {
  const [files, setFiles] = useState<RouterReadyFile[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [_diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null);
  const [machineFilter, setMachineFilter] = useState<'all' | number>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | JobStatus>('all');
  const [loading, setLoading] = useState(false);
  const [banner, setBanner] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(AUTO_REFRESH_ENABLED_KEY) === 'true';
  });
  const [autoRefreshInterval, setAutoRefreshInterval] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_AUTO_REFRESH_SECONDS;
    const stored = Number(window.localStorage.getItem(AUTO_REFRESH_INTERVAL_KEY)) || 0;
    return stored >= 5 ? stored : DEFAULT_AUTO_REFRESH_SECONDS;
  });
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [deleting, setDeleting] = useState(false);
  const [clearedByMachine, setClearedByMachine] = useState<Map<number, Map<string, number>>>(() => new Map());
  const [validationModalOpen, setValidationModalOpen] = useState(false);
  const [validationJobKey, setValidationJobKey] = useState<string | null>(null);

  // Router context menu: manual status change
  const [contextRow, setContextRow] = useState<RouterReadyFile | null>(null);
  const [changeStatusOpen, setChangeStatusOpen] = useState(false);
  const [changeStatusTo, setChangeStatusTo] = useState<JobStatus | null>(null);
  const [changeStatusReason, setChangeStatusReason] = useState('');
  const [changeStatusSubmitting, setChangeStatusSubmitting] = useState(false);
  const [changeStatusError, setChangeStatusError] = useState<string | null>(null);

  const applyClearedFilter = useCallback(
    (items: ReadyFile[], machineId: number): ReadyFile[] => {
      const cleared = clearedByMachine.get(machineId);
      if (!cleared?.size) return items;
      return items.filter((item) => {
        if (item.status !== 'NESTPICK_COMPLETE') return true;
        const clearedMtime = cleared.get(item.relativePath);
        return clearedMtime === undefined || clearedMtime !== item.mtimeMs;
      });
    },
    [clearedByMachine]
  );

  const allowedForwardStatuses = useMemo(() => {
    const current = contextRow?.status ?? null;
    if (!current) return [] as JobStatus[];
    const idx = JOB_STATUS_VALUES.indexOf(current);
    if (idx < 0) return [] as JobStatus[];

    // "Forward" in UI order AND allowed by backend lifecycle rules.
    // Example: from PENDING you cannot jump straight to FORWARDED_TO_NESTPICK.
    return JOB_STATUS_VALUES.slice(idx + 1).filter((candidate) =>
      MANUAL_ALLOWED_PREVIOUS_STATUSES[candidate]?.includes(current)
    );
  }, [contextRow]);

  const resetChangeStatusDialogState = useCallback(() => {
    setChangeStatusTo(null);
    setChangeStatusReason('');
    setChangeStatusSubmitting(false);
    setChangeStatusError(null);
  }, []);

  const refreshReadyForMachine = useCallback(
    async (machineId: number) => {
      const res = await window.api.files.listReady(machineId);
      if (!res.ok) {
        setBanner({ type: 'error', message: res.error.message ?? 'Failed to refresh router files' });
        return;
      }

      let items = res.value.files as ReadyFile[];
      if (statusFilter !== 'all') {
        items = items.filter((f) => f.status === statusFilter);
      }
      items = applyClearedFilter(items, machineId);
      const enriched = items.map((item) => ({ ...item, machineId }));

      setFiles((prev) => {
        if (machineFilter !== 'all') {
          return enriched;
        }
        const others = prev.filter((f) => f.machineId !== machineId);
        return [...others, ...enriched];
      });
    },
    [applyClearedFilter, machineFilter, statusFilter]
  );

  const handleRowContextMenu = useCallback(
    (row: RouterReadyFile) => {
      // Safety: if a user right-clicks a row that isn't selected, make it the active selection.
      // This matches JobsPage behavior and avoids "actions apply to the wrong row" mistakes.
      if (!rowSelection[row.relativePath]) {
        flushSync(() => {
          setRowSelection({ [row.relativePath]: true });
        });
      }

      // Also record which row the context menu is acting on.
      flushSync(() => {
        setContextRow(row);
      });
    },
    [rowSelection]
  );

  const openChangeStatusDialog = useCallback(() => {
    resetChangeStatusDialogState();
    // Avoid showing stale background banners behind the modal.
    setBanner(null);
    setChangeStatusOpen(true);
  }, [resetChangeStatusDialogState]);

  const submitManualStatusChange = useCallback(async () => {
    const row = contextRow;
    const to = changeStatusTo;
    const reason = changeStatusReason.trim();

    if (!row?.jobKey) {
      setChangeStatusError('This file is not linked to a job in the database yet.');
      return;
    }
    if (!row.status) {
      setChangeStatusError('This job does not have a current status. Cannot apply a manual change.');
      return;
    }
    if (!to) {
      setChangeStatusError('Pick a target status.');
      return;
    }
    if (!allowedForwardStatuses.includes(to)) {
      setChangeStatusError(`Invalid target status: ${to}`);
      return;
    }
    if (!reason) {
      setChangeStatusError('Reason is required.');
      return;
    }

    setChangeStatusSubmitting(true);
    setChangeStatusError(null);

    try {
      const res = await window.api.router.changeStatus({ key: row.jobKey, to, reason });
      if (!res.ok) {
        setChangeStatusError(res.error.message ?? 'Failed to change status.');
        return;
      }
      if (!res.value.ok) {
        const detail = res.value.reason ? ` (${res.value.reason})` : '';
        setChangeStatusError(`Status change rejected${detail}.`);
        return;
      }

      setBanner({
        type: 'success',
        message: `Status changed: ${formatStatusLabel(row.status)} -> ${formatStatusLabel(to)}`
      });

      setChangeStatusOpen(false);
      resetChangeStatusDialogState();
      await refreshReadyForMachine(row.machineId);
    } catch (err) {
      setChangeStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setChangeStatusSubmitting(false);
    }
  }, [allowedForwardStatuses, changeStatusReason, changeStatusTo, contextRow, refreshReadyForMachine, resetChangeStatusDialogState]);

  // Auto-clear banner after 5 seconds
  useEffect(() => {
    if (!banner) return;
    const id = window.setTimeout(() => setBanner(null), 5000);
    return () => window.clearTimeout(id);
  }, [banner]);

  const hasClearable = useMemo(() => {
    if (!files.length) return false;
    if (machineFilter === 'all') {
      return files.some((file) => file.status === 'NESTPICK_COMPLETE');
    }
    return files.some((file) => file.status === 'NESTPICK_COMPLETE' && file.machineId === machineFilter);
  }, [files, machineFilter]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(AUTO_REFRESH_ENABLED_KEY, autoRefreshEnabled ? 'true' : 'false');
    } catch (err) {
      console.warn('Failed to persist router auto refresh toggle', err);
    }
  }, [autoRefreshEnabled]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(AUTO_REFRESH_INTERVAL_KEY, String(autoRefreshInterval));
    } catch (err) {
      console.warn('Failed to persist router auto refresh interval', err);
    }
  }, [autoRefreshInterval]);

  // Removed unused helpers (machine map / issues, health labeling)

  const loadMachines = useCallback(async () => {
    const res = await window.api.machines.list();
    if (!res.ok) {
      alert(`Failed to load machines: ${res.error.message}`);
      setMachines([]);
      return;
    }
    setMachines(res.value.items);
  }, []);
  useEffect(() => { loadMachines(); }, [loadMachines]);

  useEffect(() => {
    let cancelled = false;
    window.api.diagnostics
      .get()
      .then((res) => {
        if (cancelled) return;
        if (res.ok) setDiagnostics(res.value);
      })
      .catch(() => { });
    const unsubscribe = window.api.diagnostics.subscribe((snapshot) => {
      if (!cancelled) setDiagnostics(snapshot);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  // Watch Ready-To-Run folder(s) and update file list
  // Removed unused startSubscription helper

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    const byMachine = new Map<number, RouterReadyFile[]>();

    const emit = () => {
      const merged: RouterReadyFile[] = [];
      for (const list of byMachine.values()) merged.push(...list);
      setFiles(merged);
    };

    const subOne = (mid: number) => {
      const unsub = window.api.files.subscribeReady(mid, (payload: ReadyListRes) => {
        if (payload.machineId !== mid) return;
        let items = payload.files as ReadyFile[];
        if (statusFilter !== 'all') {
          items = items.filter((f) => f.status === statusFilter);
        }
        items = applyClearedFilter(items, mid);
        const enriched = items.map((item) => ({ ...item, machineId: mid }));
        byMachine.set(mid, enriched);
        emit();
      });
      unsubs.push(unsub);
    };

    if (machineFilter === 'all') {
      if (machines.length === 0) {
        setFiles([]);
      } else {
        machines.forEach((m) => subOne(m.machineId));
      }
    } else {
      subOne(machineFilter);
    }

    return () => {
      for (const u of unsubs) {
        try {
          u();
        } catch (error) {
          console.warn('Failed to unsubscribe:', error);
        }
      }
    };
  }, [machineFilter, machines, statusFilter, applyClearedFilter]);

  // Optional periodic refresh as a safety net
  useEffect(() => {
    if (!autoRefreshEnabled) return;
    const id = window.setInterval(async () => {
      if (loading) return;
      if (machineFilter === 'all') {
        const all: RouterReadyFile[] = [];
        for (const m of machines) {
          const res = await window.api.files.listReady(m.machineId);
          if (!res.ok) continue;
          let items = res.value.files as ReadyFile[];
          if (statusFilter !== 'all') {
            items = items.filter((f) => f.status === statusFilter);
          }
          items = applyClearedFilter(items, m.machineId);
          all.push(...items.map((item) => ({ ...item, machineId: m.machineId })));
        }
        setFiles(all);
      } else {
        const res = await window.api.files.listReady(machineFilter);
        if (!res.ok) return;
        let items = res.value.files as ReadyFile[];
        if (statusFilter !== 'all') {
          items = items.filter((f) => f.status === statusFilter);
        }
        items = applyClearedFilter(items, machineFilter);
        setFiles(items.map((item) => ({ ...item, machineId: machineFilter })));
      }
    }, autoRefreshInterval * 1000);
    return () => window.clearInterval(id);
  }, [autoRefreshEnabled, autoRefreshInterval, loading, machineFilter, statusFilter, machines, applyClearedFilter]);

  const extractLeafFolder = useCallback((relativePath: string) => {
    const parts = relativePath.split(/[\\/]/).filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 2] : '';
  }, []);

  const machineNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const m of machines) map.set(m.machineId, m.name);
    return map;
  }, [machines]);



  const columns = useMemo<ColumnDef<RouterReadyFile>[]>(() => [
    {
      id: 'machine',
      header: 'Machine',
      enableSorting: false,
      meta: { widthPercent: ROUTER_COL_PCT.machine, minWidthPx: 140 },
      cell: ({ row }) => {
        const id = row.original.machineId;
        const name = machineNameById.get(id) ?? String(id ?? '');
        return <div className="truncate">{name}</div>;
      }
    },
    {
      accessorKey: 'relativePath',
      header: 'Folder',
      enableSorting: false,
      meta: { widthPercent: ROUTER_COL_PCT.folder, minWidthPx: 160 },
      cell: ({ row }) => (
        <div className="truncate">{extractLeafFolder(row.original.relativePath)}</div>
      )
    },
    {
      accessorKey: 'name',
      header: 'NC File',
      enableSorting: false,
      meta: { widthPercent: ROUTER_COL_PCT.name, minWidthPx: 180 },
      cell: ({ row }) => <div className="truncate">{row.original.name}</div>
    },
    {
      accessorKey: 'jobMaterial',
      header: 'Material',
      enableSorting: false,
      meta: { widthPercent: ROUTER_COL_PCT.material, minWidthPx: 120 },
      cell: ({ row }) => <div className="truncate">{row.original.jobMaterial ?? '-'}</div>
    },
    {
      accessorKey: 'jobSize',
      header: 'Size',
      enableSorting: false,
      meta: { widthPercent: ROUTER_COL_PCT.size, minWidthPx: 120 },
      cell: ({ row }) => <div className="truncate">{row.original.jobSize ?? '-'}</div>
    },
    {
      accessorKey: 'jobParts',
      header: 'Parts',
      enableSorting: false,
      meta: { widthPercent: ROUTER_COL_PCT.parts, minWidthPx: 70 },
      cell: ({ row }) => <div className="truncate">{row.original.jobParts ?? '-'}</div>
    },
    {
      accessorKey: 'status',
      header: 'Status',
      enableSorting: false,
      meta: { widthPercent: ROUTER_COL_PCT.status, minWidthPx: 140 },
      cell: ({ row }) => {
        const status = row.original.status;
        if (!status) return <span className="text-muted-foreground">-</span>;
        return (
          <span className={cn('inline-flex items-center rounded px-2 py-0.5 text-sm font-medium', statusClass(status))}>
            {formatStatusLabel(status)}
          </span>
        );
      }
    },
    {
      accessorKey: 'addedAtR2R',
      header: 'Staged',
      enableSorting: false,
      meta: { widthPercent: ROUTER_COL_PCT.staged, minWidthPx: 150 },
      cell: ({ row }) => {
        const raw =
          row.original.addedAtR2R ??
          row.original.jobDateadded ??
          (row.original.mtimeMs != null ? new Date(row.original.mtimeMs).toISOString() : null);
        return <div className="truncate">{formatIso(raw)}</div>;
      }
    },
    {
      accessorKey: 'inDatabase',
      header: 'In Database',
      enableSorting: false,
      meta: { widthPercent: ROUTER_COL_PCT.inDb, minWidthPx: 100 },
      cell: ({ row }) => <div className="truncate">{row.original.inDatabase ? 'Yes' : 'No'}</div>
    }
  ], [extractLeafFolder, machineNameById]);

  const table = useReactTable({
    data: files,
    columns,
    state: { rowSelection },
    onRowSelectionChange: setRowSelection,
    getRowId: (row) => row.relativePath,
    getCoreRowModel: getCoreRowModel(),
    enableColumnResizing: false,
    enableRowSelection: true,
    enableSorting: false
  });

  const selectedRows = table.getSelectedRowModel().rows;
  const selectedCount = selectedRows.length;

  const handleClearProcessed = () => {
    const targets = files.filter((file) => {
      if (file.status !== 'NESTPICK_COMPLETE') return false;
      if (machineFilter === 'all') return typeof file.machineId === 'number';
      return file.machineId === machineFilter;
    });
    if (!targets.length) return;

    const entriesByMachine = new Map<number, Array<{ path: string; mtime: number }>>();
    for (const file of targets) {
      const mid = file.machineId;
      if (typeof mid !== 'number') continue;
      const list = entriesByMachine.get(mid) ?? [];
      list.push({ path: file.relativePath, mtime: file.mtimeMs });
      entriesByMachine.set(mid, list);
    }
    if (!entriesByMachine.size) return;

    setClearedByMachine((prev) => {
      const next = new Map(prev);
      for (const [mid, entries] of entriesByMachine.entries()) {
        const existing = new Map(next.get(mid) ?? new Map<string, number>());
        for (const entry of entries) {
          existing.set(entry.path, entry.mtime);
        }
        next.set(mid, existing);
      }
      return next;
    });

    setFiles((prev) =>
      prev.filter((file) => {
        if (file.status !== 'NESTPICK_COMPLETE') return true;
        const mid = file.machineId;
        if (typeof mid !== 'number') return true;
        return !entriesByMachine.has(mid);
      })
    );
    setRowSelection({});

    const clearedCount = targets.length;
    const message =
      machineFilter === 'all'
        ? `Cleared ${clearedCount} processed job${clearedCount === 1 ? '' : 's'} from view`
        : `Cleared ${clearedCount} processed job${clearedCount === 1 ? '' : 's'} for ${machines.find((m) => m.machineId === machineFilter)?.name ?? `Machine ${machineFilter}`
        }`;
    setBanner({ type: 'success', message });
  };

  const handleDeleteSelected = async () => {
    if (!selectedCount || deleting) return;
    const confirmed = window.confirm(
      'Delete associated NC, CSV, image, and part files (nc/csv/bmp/jpg/jpeg/png/gif/pts/lpt/txt) for the selected jobs?'
    );
    if (!confirmed) return;

    setDeleting(true);
    setBanner(null);

    const grouped = new Map<number, Set<string>>();
    for (const row of selectedRows) {
      const rels = grouped.get(row.original.machineId) ?? new Set<string>();
      rels.add(row.original.relativePath);
      grouped.set(row.original.machineId, rels);
    }

    let deletedTotal = 0;
    const errorMessages: string[] = [];

    for (const [machineId, relSet] of grouped) {
      if (relSet.size === 0) continue;
      try {
        const res = await window.api.files.deleteReadyAssets({
          machineId,
          relativePaths: Array.from(relSet)
        });
        if (!res.ok) {
          errorMessages.push(`Machine ${machineId}: ${res.error.message ?? 'Failed to delete files'}`);
          continue;
        }
        deletedTotal += res.value.deleted;
        if (res.value.errors.length) {
          for (const failure of res.value.errors) {
            errorMessages.push(`${failure.file}: ${failure.message}`);
          }
        }
      } catch (err) {
        errorMessages.push(`Machine ${machineId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (errorMessages.length) {
      setBanner({ type: 'error', message: errorMessages.join('; ') });
    } else {
      setBanner({
        type: 'success',
        message:
          deletedTotal > 0
            ? `Deleted ${deletedTotal} file${deletedTotal === 1 ? '' : 's'} associated with the selected jobs.`
            : 'No matching asset files were found for the selected jobs.'
      });
    }

    setRowSelection({});
    setDeleting(false);
  };

  const exportCsv = () => {
    const header = 'Folder,NC File,Material,Size,Parts,Status,Date Added,In Database';
    const lines = files.map(f => [
      extractLeafFolder(f.relativePath),
      f.name,
      f.jobMaterial ?? '',
      f.jobSize ?? '',
      f.jobParts ?? '',
      f.status ?? '',
      formatIso(
        f.addedAtR2R ??
        f.jobDateadded ??
        (f.mtimeMs != null ? new Date(f.mtimeMs).toISOString() : null)
      ),
      f.inDatabase ? 'Yes' : 'No'
    ].map(field => `"${String(field ?? '').replace(/"/g, '""')}"`).join(','));
    const csv = [header, ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'router-files.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4 w-full">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">{loading ? 'Refreshing...' : `${files.length} files`}</p>
        </div>
        <div className="relative flex flex-col items-end gap-2">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 border rounded px-2 py-1 text-xs">
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={autoRefreshEnabled}
                  onChange={(e) => setAutoRefreshEnabled(e.target.checked)}
                />
                Auto
              </label>
              <Select
                value={String(autoRefreshInterval)}
                onValueChange={(v) => setAutoRefreshInterval(Number(v))}
                disabled={!autoRefreshEnabled}
              >
                <SelectTrigger className="h-6 text-xs w-16">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[15, 30, 60, 120].map((seconds) => (
                    <SelectItem key={seconds} value={String(seconds)}>{seconds}s</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2">
              {machineFilter !== 'all' && (
                  <Button
                    size="sm"
                    onClick={async () => {
                      setLoading(true);
                      const res = await window.api.files.listReady(machineFilter as number);
                      if (res.ok) {
                        let items = res.value.files as ReadyFile[];
                        if (statusFilter !== 'all') {
                          items = items.filter((f) => f.status === statusFilter);
                        }
                        items = applyClearedFilter(items, machineFilter as number);
                        setFiles(items.map((item) => ({ ...item, machineId: machineFilter as number })));
                      }
                      setLoading(false);
                    }}
                    disabled={loading}
                  >
                    Refresh
                  </Button>
              )}
              <Button
                size="sm"
                onClick={handleClearProcessed}
                disabled={!hasClearable || deleting}
              >
                Clear Processed
              </Button>
              <Button
                size="sm"
                onClick={handleDeleteSelected}
                disabled={deleting || selectedCount === 0}
              >
                {deleting ? 'Deleting...' : selectedCount > 1 ? `Delete Selected (${selectedCount})` : 'Delete Selected'}
              </Button>
              <Button size="sm" onClick={exportCsv}>
                Export CSV
              </Button>
            </div>
          </div>
          {banner && (
            <div
              className={cn(
                'absolute top-full right-0 mt-2 z-15 text-sm px-3 py-2 rounded border shadow-sm',
                banner.type === 'error'
                  ? 'border-red-300 bg-red-50 text-red-700'
                  : 'border-emerald-300 bg-emerald-50 text-emerald-700'
              )}
            >
              {banner.message}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 border rounded p-3 bg-[var(--card)]">
        <div className="text-sm flex items-center gap-2">
          <span>Machine</span>
          <Select
            value={machineFilter === 'all' ? '_all_' : String(machineFilter)}
            onValueChange={(v) => setMachineFilter(v === '_all_' ? 'all' : Number(v))}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_all_">All</SelectItem>
              {machines.map(m => (
                <SelectItem key={m.machineId} value={String(m.machineId)}>{m.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="text-sm flex items-center gap-2">
          <span>Status</span>
          <Select
            value={statusFilter === 'all' ? '_all_' : statusFilter}
            onValueChange={(v) => setStatusFilter(v === '_all_' ? 'all' : (v as JobStatus))}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_all_">All</SelectItem>
              {JOB_STATUS_VALUES.map(status => (
                <SelectItem key={status} value={status}>{status}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div>
            <GlobalTable
              table={table}
              maxHeight="calc(100vh - 200px)"
              rowHeight={41}
              headerHeight={40}
              viewportPadding={200}
              density="normal"
              headerHoverAlways
              preventContextMenuDefault={false}
              onRowContextMenu={(row) => {
                handleRowContextMenu(row.original as RouterReadyFile);
              }}
              onRowDoubleClick={(row) => {
                const original = row.original as RouterReadyFile;
                if (original.jobKey) {
                  setValidationJobKey(original.jobKey);
                  setValidationModalOpen(true);
                }
              }}
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <ContextMenuLabel>
            {contextRow ? (
              <div className="space-y-1">
                <div className="truncate font-medium">{contextRow.name}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {contextRow.status ? formatStatusLabel(contextRow.status) : 'No status'}
                </div>
              </div>
            ) : (
              'No row'
            )}
          </ContextMenuLabel>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={openChangeStatusDialog}
            disabled={
              !contextRow?.jobKey ||
              !contextRow.status ||
              allowedForwardStatuses.length === 0 ||
              changeStatusSubmitting
            }
          >
            Change Status
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <Dialog
        open={changeStatusOpen}
        onOpenChange={(open) => {
          setChangeStatusOpen(open);
          if (!open) {
            resetChangeStatusDialogState();
          }
        }}
      >
        <DialogContent className="sm:max-w-[720px]">
          <div className="p-6 sm:p-7">
            <DialogHeader className="pb-2">
              <DialogTitle>Change Status</DialogTitle>
            </DialogHeader>

            <div className="space-y-5">
              {changeStatusError ? (
                <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {changeStatusError}
                </div>
              ) : null}
              <div className="text-sm">
                <div className="font-medium truncate">
                  {contextRow?.name ?? 'No selection'}
                </div>
                <div className="text-muted-foreground">
                  Current status: {contextRow?.status ? formatStatusLabel(contextRow.status) : 'Unknown'}
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium">New status</div>
                <Select
                  value={changeStatusTo ?? ''}
                  onValueChange={(v) => setChangeStatusTo(v as JobStatus)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select status" />
                  </SelectTrigger>
                  <SelectContent>
                    {allowedForwardStatuses.map((status) => (
                      <SelectItem key={status} value={status}>
                        {formatStatusLabel(status)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium">Reason</div>
                  <div className="text-xs text-muted-foreground">{changeStatusReason.length}/500</div>
                </div>
                <textarea
                  value={changeStatusReason}
                  onChange={(e) => setChangeStatusReason(e.target.value)}
                  maxLength={500}
                  className="w-full min-h-[110px] border rounded-md px-3 py-2 text-sm bg-transparent"
                  placeholder="Why are you forcing this status forward?"
                />
              </div>
            </div>

            <DialogFooter className="pt-6">
              <Button
                variant="outline"
                onClick={() => setChangeStatusOpen(false)}
                disabled={changeStatusSubmitting}
              >
                Cancel
              </Button>
              <Button
                onClick={submitManualStatusChange}
                disabled={changeStatusSubmitting || !contextRow?.jobKey}
              >
                {changeStatusSubmitting ? 'Saving...' : 'Save'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <ValidationDataModal
        open={validationModalOpen}
        onOpenChange={(next) => {
          setValidationModalOpen(next);
          if (!next) setValidationJobKey(null);
        }}
        jobKey={validationJobKey}
      />
    </div>
  );
}


