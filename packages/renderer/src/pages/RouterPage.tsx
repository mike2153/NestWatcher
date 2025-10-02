import { useCallback, useEffect, useMemo, useState } from 'react';
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
import type { ColumnDef } from '@tanstack/react-table';
import { getCoreRowModel, useReactTable } from '@tanstack/react-table';

const AUTO_REFRESH_ENABLED_KEY = 'router:autoRefresh';
const AUTO_REFRESH_INTERVAL_KEY = 'router:autoRefreshInterval';
const DEFAULT_AUTO_REFRESH_SECONDS = 30;

function formatIso(value: string | null) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
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
      default:
      return 'bg-accent text-accent-foreground';
    }
  }

export function RouterPage() {
  const [files, setFiles] = useState<ReadyFile[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [_diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null);
  const [machineFilter, setMachineFilter] = useState<'all' | number>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | JobStatus>('all');
  const [loading, setLoading] = useState(false);
  const [error, _setError] = useState<string | null>(null);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(AUTO_REFRESH_ENABLED_KEY) === 'true';
  });
  const [autoRefreshInterval, setAutoRefreshInterval] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_AUTO_REFRESH_SECONDS;
    const stored = Number(window.localStorage.getItem(AUTO_REFRESH_INTERVAL_KEY)) || 0;
    return stored >= 5 ? stored : DEFAULT_AUTO_REFRESH_SECONDS;
  });

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
      .catch(() => {});
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
    // Subscribe for selected machine, or all machines when 'all'
    const unsubs: Array<() => void> = [];
    const byMachine = new Map<number, ReadyFile[]>();

    const emit = () => {
      // Merge all machine files into a single list
      const merged: ReadyFile[] = [];
      for (const list of byMachine.values()) merged.push(...list);
      setFiles(merged);
    };

    const subOne = (mid: number) => {
      const unsub = window.api.files.subscribeReady(mid, (payload: ReadyListRes) => {
        if (payload.machineId !== mid) return;
        let items = payload.files;
        if (statusFilter !== 'all') items = items.filter((f: ReadyFile) => f.status === statusFilter);
        byMachine.set(mid, items);
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
  }, [machineFilter, machines, statusFilter]);

  // Optional periodic refresh as a safety net
  useEffect(() => {
    if (!autoRefreshEnabled) return;
    const id = window.setInterval(async () => {
      if (loading) return;
      if (machineFilter === 'all') {
        const all: ReadyFile[] = [];
        for (const m of machines) {
          const res = await window.api.files.listReady(m.machineId);
          if (!res.ok) continue;
          let items = res.value.files;
          if (statusFilter !== 'all') items = items.filter((f: ReadyFile) => f.status === statusFilter);
          all.push(...items);
        }
        setFiles(all);
      } else {
        const res = await window.api.files.listReady(machineFilter);
        if (!res.ok) return;
        let items = res.value.files;
        if (statusFilter !== 'all') items = items.filter((f: ReadyFile) => f.status === statusFilter);
        setFiles(items);
      }
    }, autoRefreshInterval * 1000);
    return () => window.clearInterval(id);
  }, [autoRefreshEnabled, autoRefreshInterval, loading, machineFilter, statusFilter, machines]);

  const extractLeafFolder = useCallback((relativePath: string) => {
    const parts = relativePath.split(/[\\/]/).filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 2] : '';
  }, []);

  const columns = useMemo<ColumnDef<ReadyFile>[]>(() => [
    {
      accessorKey: 'relativePath',
      header: 'Folder',
      size: 220,
      minSize: 180,
      maxSize: 300,
      enableSorting: false,
      cell: ({ row }) => (
        <div className="truncate">{extractLeafFolder(row.original.relativePath)}</div>
      )
    },
    {
      accessorKey: 'name',
      header: 'NC File',
      size: 240,
      minSize: 200,
      maxSize: 360,
      enableSorting: false,
      cell: ({ row }) => <div className="truncate">{row.original.name}</div>
    },
    {
      accessorKey: 'jobMaterial',
      header: 'Material',
      size: 140,
      minSize: 120,
      maxSize: 200,
      enableSorting: false,
      cell: ({ row }) => <div className="truncate">{row.original.jobMaterial ?? '-'}</div>
    },
    {
      accessorKey: 'jobSize',
      header: 'Size',
      size: 140,
      minSize: 120,
      maxSize: 200,
      enableSorting: false,
      cell: ({ row }) => <div className="truncate">{row.original.jobSize ?? '-'}</div>
    },
    {
      accessorKey: 'jobParts',
      header: 'Parts',
      size: 80,
      minSize: 60,
      maxSize: 120,
      enableSorting: false,
      cell: ({ row }) => <div className="truncate">{row.original.jobParts ?? '-'}</div>
    },
    {
      accessorKey: 'status',
      header: 'Status',
      size: 180,
      minSize: 160,
      maxSize: 260,
      enableSorting: false,
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
      accessorKey: 'jobDateadded',
      header: 'Date Added',
      size: 200,
      minSize: 160,
      maxSize: 260,
      enableSorting: false,
      cell: ({ row }) => {
        const raw = row.original.jobDateadded ?? (row.original.mtimeMs != null ? new Date(row.original.mtimeMs).toISOString() : null);
        return <div className="truncate">{formatIso(raw)}</div>;
      }
    },
    {
      accessorKey: 'inDatabase',
      header: 'In Database',
      size: 140,
      minSize: 120,
      maxSize: 200,
      enableSorting: false,
      cell: ({ row }) => <div className="truncate">{row.original.inDatabase ? 'Yes' : 'No'}</div>
    }
  ], [extractLeafFolder]);

  const table = useReactTable({
    data: files,
    columns,
    getRowId: (row) => row.relativePath,
    getCoreRowModel: getCoreRowModel(),
    columnResizeMode: 'onChange',
    enableColumnResizing: true,
    enableRowSelection: false,
    enableSorting: false
  });

  const exportCsv = () => {
    const header = 'Folder,NC File,Material,Size,Parts,Status,Date Added,In Database';
    const lines = files.map(f => [
      extractLeafFolder(f.relativePath),
      f.name,
      f.jobMaterial ?? '',
      f.jobSize ?? '',
      f.jobParts ?? '',
      f.status ?? '',
      formatIso(f.jobDateadded ?? new Date(f.mtimeMs).toISOString()),
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
        <div className="flex flex-col items-end gap-2">
          {error && (
            <div className="border border-red-300 bg-red-50 text-red-700 text-sm px-3 py-2 rounded">{error}</div>
          )}
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
              <select
                className="border rounded px-1 py-0.5"
                value={autoRefreshInterval}
                onChange={(e) => setAutoRefreshInterval(Number(e.target.value))}
                disabled={!autoRefreshEnabled}
              >
                {[15, 30, 60, 120].map((seconds) => (
                  <option key={seconds} value={seconds}>{seconds}s</option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              {machineFilter !== 'all' && (
                <button
                  className="border rounded px-3 py-1"
                  onClick={async () => {
                    setLoading(true);
                    const res = await window.api.files.listReady(machineFilter as number);
                    if (res.ok) setFiles(res.value.files);
                    setLoading(false);
                  }}
                  disabled={loading}
                >
                  Refresh
                </button>
              )}
              <button className="border rounded px-3 py-1" onClick={exportCsv}>
                Export CSV
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <label className="text-sm flex items-center gap-2">
          <span>Machine</span>
          <select className="border rounded px-2 py-1" value={machineFilter === 'all' ? '' : machineFilter}
            onChange={(e) => setMachineFilter(e.target.value ? Number(e.target.value) : 'all')}>
            <option value="">All</option>
            {machines.map(m => (
              <option key={m.machineId} value={m.machineId}>{m.name}</option>
            ))}
          </select>
        </label>
        <label className="text-sm flex items-center gap-2">
          <span>Status</span>
          <select className="border rounded px-2 py-1" value={statusFilter === 'all' ? '' : statusFilter}
            onChange={(e) => setStatusFilter(e.target.value ? (e.target.value as JobStatus) : 'all')}>
            <option value="">All</option>
            {JOB_STATUS_VALUES.map(status => (
              <option key={status} value={status}>{status}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex justify-between items-center px-1">
        <div className="text-sm text-muted-foreground">Ready-To-Run folder view</div>
      </div>
      <GlobalTable
        table={table}
        maxHeight="calc(100vh - 200px)"
        rowHeight={41}
        headerHeight={40}
        viewportPadding={200}
        interactiveRows={false}
        toggleRowSelectionOnClick={false}
        density="normal"
        headerHoverAlways
      />
    </div>
  );
}


