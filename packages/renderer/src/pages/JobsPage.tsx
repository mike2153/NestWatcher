import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MouseEvent } from 'react';
import {
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import type { ColumnDef, ColumnSizingState, RowSelectionState, SortingState } from '@tanstack/react-table';
import type {
  DiagnosticsSnapshot,
  JobEvent,
  JobRow,
  JobsFiltersRes,
  JobsListReq,
  JobStatus,
  Machine,
  MachineHealthEntry,
  MachineHealthCode
} from '../../../shared/src';
import { JOB_STATUS_VALUES } from '../../../shared/src';
import { cn } from '../utils/cn';
import { GlobalTable } from '@/components/table/GlobalTable';
import { Button } from '@/components/ui/button';
import {
  Filter,
  FilterX,
  Lock,
  Unlock,
  Plus,
  Eye,
  EyeOff,
  RefreshCw,
  PlayCircle
} from 'lucide-react';

const COLUMN_SIZING_KEY = 'jobs:columnSizing';
const AUTO_REFRESH_ENABLED_KEY = 'jobs:autoRefresh';
const AUTO_REFRESH_INTERVAL_KEY = 'jobs:autoRefreshInterval';
const DEFAULT_LIMIT = 200;
const HISTORY_LIMIT = 200;

type FiltersState = {
  statusQuick: NonNullable<JobsListReq['filter']['status']>;
  statuses: JobStatus[];
  materials: string[];
  machineId?: number;
};

type ContextMenuState = {
  position: { x: number; y: number };
  keys: string[];
};

const defaultFilters: FiltersState = {
  statusQuick: 'all',
  statuses: [],
  materials: [],
  machineId: undefined
};

function formatTimestamp(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const day = d.getDate();
  const mon = months[d.getMonth()];
  const year = d.getFullYear();
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12; if (h === 0) h = 12;
  return `${day} ${mon} ${year} ${h}:${m}${ampm}`;
}

function formatStatusLabel(value: string) {
  const upper = value.toUpperCase();
  if (upper === 'FORWARDED_TO_NESTPICK') return 'Nestpick Processing';
  const parts = value.split(/[_\s]+/).filter(Boolean).map((p) => p.toLowerCase());
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function statusBadgeClass(status: JobStatus) {
  switch (status) {
    case 'CNC_FINISH':
    case 'FORWARDED_TO_NESTPICK':
    case 'NESTPICK_COMPLETE':
      return 'bg-green-100 text-green-800';
    case 'LABEL_FINISH':
    case 'LOAD_FINISH':
      return 'bg-amber-100 text-amber-800';
    case 'STAGED':
      return 'bg-blue-100 text-blue-800';
    case 'PENDING':
    default:
      return 'bg-accent text-accent-foreground';
  }
}

function loadColumnSizing(): ColumnSizingState {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(COLUMN_SIZING_KEY);
    return raw ? (JSON.parse(raw) as ColumnSizingState) : {};
  } catch (err) {
    console.warn('Failed to load jobs column sizing', err);
    return {};
  }
}


export function JobsPage() {
  const [data, setData] = useState<JobRow[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null);
  const [search, setSearch] = useState('');
  const [sorting, setSorting] = useState<SortingState>([{ id: 'dateadded', desc: true }]);
  const [filters, setFilters] = useState<FiltersState>({ ...defaultFilters });
  const [filterOptions, setFilterOptions] = useState<JobsFiltersRes['options']>({ materials: [], statuses: JOB_STATUS_VALUES });
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(loadColumnSizing);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  
  const [bulkMachine, setBulkMachine] = useState<number | ''>('');
  const [actionBusy, setActionBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [autoRefreshEnabled, _setAutoRefreshEnabled] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(AUTO_REFRESH_ENABLED_KEY) === 'true';
  });
  const [autoRefreshInterval, _setAutoRefreshInterval] = useState(() => {
    if (typeof window === 'undefined') return 30;
    const stored = Number(window.localStorage.getItem(AUTO_REFRESH_INTERVAL_KEY)) || 0;
    return stored >= 5 ? stored : 30;
  });
  const [listError, setListError] = useState<string | null>(null);
  const [historyEvents, setHistoryEvents] = useState<JobEvent[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(true);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(COLUMN_SIZING_KEY, JSON.stringify(columnSizing));
    } catch (err) {
      console.warn('Failed to persist jobs column sizing', err);
    }
  }, [columnSizing]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(AUTO_REFRESH_ENABLED_KEY, autoRefreshEnabled ? 'true' : 'false');
  }, [autoRefreshEnabled]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(AUTO_REFRESH_INTERVAL_KEY, String(autoRefreshInterval));
  }, [autoRefreshInterval]);

  useEffect(() => {
    (async () => {
      try {
        const res = await window.api.machines.list();
        if (!res.ok) {
          console.error('Failed to load machines', res.error);
        } else {
          setMachines(res.value.items);
        }
      } catch (err) {
        console.error('Failed to load machines', err);
      }
    })();
  }, []);

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

  useEffect(() => {
    (async () => {
      try {
        const res = await window.api.jobs.filters();
        if (!res.ok) {
          console.error('Failed to load job filter options', res.error);
        } else {
          setFilterOptions(res.value.options);
        }
      } catch (err) {
        console.error('Failed to load job filter options', err);
      }
    })();
  }, []);

  const refresh = useCallback(async (override?: { filters?: FiltersState; search?: string; sorting?: SortingState }) => {
    setLoading(true);
    try {
      const sortingState = override?.sorting ?? sorting;
      const primarySort = sortingState[0] ?? { id: 'dateadded', desc: true };
      const filterState = override?.filters ?? filters;
      const searchValue = override?.search ?? search;
      const filter: JobsListReq['filter'] = {
        status: filterState.statusQuick,
        machineId: filterState.machineId
      };
      if (filterState.statuses.length) {
        filter.statusIn = filterState.statuses as JobsListReq['filter']['statusIn'];
      }
      if (filterState.materials.length) {
        filter.materialIn = [...filterState.materials];
      }
      const res = await window.api.jobs.list({
        search: searchValue || undefined,
        sortBy: primarySort.id as JobsListReq['sortBy'],
        sortDir: (primarySort.desc ? 'desc' : 'asc') as JobsListReq['sortDir'],
        limit: DEFAULT_LIMIT,
        filter
      });
      if (!res.ok) {
        console.error('Failed to load jobs', res.error);
        setListError(res.error.message);
        setData([]);
      } else {
        setListError(null);
        setData(res.value.items);
      }
    } catch (err) {
      console.error('Failed to load jobs', err);
    } finally {
      setLoading(false);
    }
  }, [filters, search, sorting]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!autoRefreshEnabled) return;
    const id = window.setInterval(() => {
      if (!loading) {
        refresh();
      }
    }, autoRefreshInterval * 1000);
    return () => window.clearInterval(id);
  }, [autoRefreshEnabled, autoRefreshInterval, loading, refresh]);

  useEffect(() => {
    setRowSelection((prev) => {
      if (!Object.keys(prev).length) return prev;
      const available = new Set(data.map((row) => row.key));
      const next: RowSelectionState = {};
      for (const key of Object.keys(prev)) {
        if (available.has(key)) next[key] = true;
      }
      return next;
    });
  }, [data]);

  useEffect(() => {
    if (!contextMenu) return;
    if (!contextMenu.keys?.some((key) => rowSelection[key])) {
      setContextMenu(null);
    }
  }, [contextMenu, rowSelection]);

  const machineNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const machine of machines) {
      map.set(machine.machineId, machine.name);
    }
    return map;
  }, [machines]);

  const machineIssuesById = useMemo(() => {
    const entries: MachineHealthEntry[] = diagnostics?.machineHealth ?? [];
    const byId = new Map<number | 'global', MachineHealthEntry[]>();
    for (const issue of entries) {
      const key = issue.machineId ?? 'global';
      const list = byId.get(key) ?? [];
      list.push(issue);
      byId.set(key, list);
    }
    return byId;
  }, [diagnostics]);

  function healthLabel(code: MachineHealthCode): string {
    switch (code) {
      case 'NO_PARTS_CSV':
        return 'Parts CSV missing';
      case 'NESTPICK_SHARE_UNREACHABLE':
        return 'Nestpick share unreachable';
      case 'COPY_FAILURE':
        return 'Copy failures';
    }
    return (code as string).replace(/_/g, ' ');
  }

  function severityDotClass(severity: MachineHealthEntry['severity']): string {
    switch (severity) {
      case 'critical':
        return 'bg-red-500';
      case 'warning':
        return 'bg-amber-500';
      default:
        return 'bg-muted-foreground';
    }
  }

  const jobByKey = useMemo(() => {
    const map = new Map<string, JobRow>();
    for (const job of data) {
      map.set(job.key, job);
    }
    return map;
  }, [data]);

  const formatFolderLabel = useCallback((value: string | null) => {
    if (!value) return '';
    const parts = value.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : value;
  }, []);

  const columns = useMemo<ColumnDef<JobRow>[]>(() => [
    {
      accessorKey: 'folder',
      header: 'Folder',
      size: 220,
      minSize: 160,
      maxSize: 300,
      cell: ({ getValue }) => {
        const value = getValue<string | null>();
        return formatFolderLabel(value);
      }
    },
    {
      accessorKey: 'ncfile',
      header: 'NC File',
      size: 240,
      minSize: 180,
      maxSize: 350
    },
    {
      accessorKey: 'material',
      header: 'Material',
      size: 120,
      minSize: 100,
      maxSize: 180
    },
    {
      accessorKey: 'parts',
      header: 'Parts',
      size: 40,
      minSize: 40,
      maxSize: 100
    },
    {
      accessorKey: 'size',
      header: 'Size',
      size: 120,
      minSize: 100,
      maxSize: 160
    },
    {
      accessorKey: 'thickness',
      header: 'Thickness',
      size: 90,
      minSize: 80,
      maxSize: 120
    },
    {
      accessorKey: 'processingSeconds',
      header: 'Processing Time',
      size: 130,
      minSize: 110,
      maxSize: 160,
      enableSorting: false,
      cell: ({ getValue }) => {
        const seconds = getValue<number | null | undefined>();
        if (seconds == null || !Number.isFinite(seconds)) return '';
        const total = Math.max(0, Math.floor(seconds));
        const dd = Math.floor(total / 86400);
        const hh = Math.floor((total % 86400) / 3600);
        const mm = Math.floor((total % 3600) / 60);
        const ss = total % 60;
        if (dd > 0) return `${dd}d ${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
        if (hh > 0) return `${hh}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
        return `${mm}:${String(ss).padStart(2,'0')}`;
      }
    },
    {
      accessorKey: 'dateadded',
      header: 'Date Added',
      size: 160,
      minSize: 140,
      maxSize: 200,
      cell: ({ getValue }) => {
        const value = getValue<string | null>();
        if (!value) return '';
        return formatTimestamp(value);
      }
    },
    {
      accessorKey: 'reserved',
      header: 'Reserved',
      size: 80,
      minSize: 70,
      maxSize: 100,
      cell: ({ getValue }) => (getValue<boolean>() ? 'Yes' : 'No')
    },
    {
      accessorKey: 'status',
      header: 'Status',
      size: 120,
      minSize: 100,
      maxSize: 180,
      cell: ({ getValue }) => {
        const raw = getValue<JobStatus | null>();
        if (!raw) return <span className="text-muted-foreground">-</span>;
        return (
          <span className={cn('inline-flex items-center rounded px-2 py-0.5 text-sm font-medium', statusBadgeClass(raw))}>
            {formatStatusLabel(raw)}
          </span>
        );
      }
    },
    {
      accessorKey: 'machineId',
      header: 'Machine',
      size: 150,
      minSize: 120,
      maxSize: 220,
      enableSorting: false,
      cell: ({ getValue }) => {
        const id = getValue<number | null>();
        if (id == null) return '';
        const name = machineNameById.get(id) ?? String(id);
        const issues: MachineHealthEntry[] = [
          ...(machineIssuesById.get(id) ?? []),
          ...(machineIssuesById.get('global') ?? [])
        ]
          .slice()
          .sort((a, b) => {
            const sev = (s: MachineHealthEntry['severity']) => (s === 'critical' ? 2 : s === 'warning' ? 1 : 0);
            const d = sev(b.severity) - sev(a.severity);
            if (d) return d;
            return b.lastUpdatedAt.localeCompare(a.lastUpdatedAt);
          });
        return (
          <div className="flex items-center gap-2">
            <span>{name}</span>
            {issues.length > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                {issues.slice(0, 2).map((issue) => (
                  <span
                    key={issue.id}
                    className={cn(
                      'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-white',
                      issue.severity === 'critical'
                        ? 'bg-red-600'
                        : issue.severity === 'warning'
                        ? 'bg-amber-600'
                        : 'bg-muted-foreground'
                    )}
                    title={`${healthLabel(issue.code)} ? ${issue.message}`}
                  >
                    <span className={cn('h-1.5 w-1.5 rounded-full', severityDotClass(issue.severity))} />
                    <span>{healthLabel(issue.code)}</span>
                  </span>
                ))}
                {issues.length > 2 && (
                  <span className="text-[10px] text-muted-foreground">+{issues.length - 2} more</span>
                )}
              </div>
            )}
          </div>
        );
      }
    }
  ], [formatFolderLabel, machineNameById, machineIssuesById]);

  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
      rowSelection,
      columnSizing
    },
    getRowId: (row) => row.key,
    onSortingChange: setSorting,
    onRowSelectionChange: setRowSelection,
    onColumnSizingChange: setColumnSizing,
    columnResizeMode: 'onChange',
    enableRowSelection: true,
    enableColumnResizing: true,
    enableMultiSort: false,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel()
  });

  const selectedRows = table.getSelectedRowModel().rows;
  const selectedKeys = selectedRows.map((row) => row.original.key);
  const selectedCount = selectedKeys.length;
  const anyReserved = selectedRows.some((row) => row.original.reserved);
  const anyUnreserved = selectedRows.some((row) => !row.original.reserved);
  const allPendingForSelection =
    selectedRows.length > 0 && selectedRows.every((row) => row.original.status === 'PENDING');
  const historyKey = selectedKeys[0] ?? null;
  const canBulkReserve = anyUnreserved && allPendingForSelection;


  const performReserve = useCallback(
    async (targetKeys: string[], mode: 'reserve' | 'unreserve') => {
      if (!targetKeys.length) return;
      if (mode === 'reserve') {
        const blocked = targetKeys.filter((key) => {
          const job = jobByKey.get(key);
          if (!job) return true;
          return job.status !== 'PENDING';
        });
        if (blocked.length) {
          alert(
            'Only jobs in PENDING status can be reserved. Please deselect jobs that are not pending before reserving.'
          );
          setContextMenu(null);
          return;
        }
      }
      setActionBusy(true);
      try {
        const failures: string[] = [];
        for (const key of targetKeys) {
          const res = mode === 'reserve' ? await window.api.jobs.reserve(key) : await window.api.jobs.unreserve(key);
          if (!res.ok) {
            console.error(`Failed to ${mode} job`, key, res.error);
            failures.push(`${key}: ${res.error.message}`);
          }
        }
        if (failures.length) {
          alert(`Failed to ${mode} ${failures.length} job(s): ${failures.join(', ')}`);
        }
        await refresh();
        setRowSelection({});
      } finally {
        setActionBusy(false);
        setContextMenu(null);
      }
    },
    [jobByKey, refresh]
  );

  const performWorklist = useCallback(async (targetKeys: string[], machineId: number) => {
    if (!targetKeys.length) return;
    setActionBusy(true);
    try {
      const failures: string[] = [];
      let successCount = 0;
      for (const key of targetKeys) {
        const res = await window.api.jobs.addToWorklist(key, machineId);
        if (!res.ok) {
          console.error('Failed to add job to worklist', key, res.error);
          failures.push(`${key}: ${res.error.message}`);
        } else if (res.value.ok) {
          successCount += 1;
        } else {
          failures.push(`${key}: ${res.value.error}`);
        }
      }
      if (successCount) {
        alert(`Added ${successCount} job(s) to worklist.`);
      }
      if (failures.length) {
        alert(`Failed to add ${failures.length} job(s): ${failures.join(', ')}`);
      }
      await refresh();
      setRowSelection({});
      setBulkMachine('');
    } finally {
      setActionBusy(false);
      setContextMenu(null);
    }
  }, [refresh]);

  const loadHistory = useCallback(async (key: string) => {
    setHistoryLoading(true);
    setHistoryError(null);
    const res = await window.api.jobs.events({ key, limit: HISTORY_LIMIT });
    if (!res.ok) {
      console.error('Failed to load job events', res.error);
      setHistoryEvents([]);
      setHistoryError(res.error.message);
    } else {
      const events = Array.isArray(res.value.events) ? res.value.events : [];
      if (!Array.isArray(res.value.events)) {
        console.warn('jobs.events returned unexpected payload, defaulting to empty list', res.value);
      }
      setHistoryEvents(events);
    }
    setHistoryLoading(false);
  }, []);

  useEffect(() => {
    if (!historyKey) {
      setHistoryEvents([]);
      setHistoryError(null);
      return;
    }
    if (!historyOpen) return;
    loadHistory(historyKey);
  }, [historyKey, historyOpen, loadHistory]);

  useEffect(() => {
    if (historyKey) setHistoryOpen(true);
  }, [historyKey]);

  const refreshHistory = useCallback(() => {
    if (historyKey) loadHistory(historyKey);
  }, [historyKey, loadHistory]);

  const handleRowContextMenu = useCallback((event: MouseEvent<HTMLTableRowElement>, rowKey: string) => {
    event.preventDefault();
    const keys = Object.keys(rowSelection).length ? Object.keys(rowSelection) : [rowKey];
    setContextMenu({ position: { x: event.clientX, y: event.clientY }, keys });
  }, [rowSelection]);

  useEffect(() => {
    if (!contextMenu) return;
    const handleMouse = (event: globalThis.MouseEvent) => {
      if ((event.target as HTMLElement).closest('[data-context-menu]')) return;
      setContextMenu(null);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('mousedown', handleMouse);
    window.addEventListener('contextmenu', handleMouse);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('mousedown', handleMouse);
      window.removeEventListener('contextmenu', handleMouse);
      window.removeEventListener('keydown', handleKey);
    };
  }, [contextMenu]);

  const statusOptions = filterOptions?.statuses?.length ? filterOptions.statuses : JOB_STATUS_VALUES;
  const materialOptions = filterOptions?.materials || [];

  return (
    <div className="space-y-4 w-full">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">{loading ? 'Refreshing?' : `${data.length} rows`}</p>
        </div>
        {listError && (
          <div className="border border-red-300 bg-red-50 text-red-700 text-sm px-3 py-2 rounded">{listError}</div>
        )}
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium">Search</span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search all fields"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium">Quick Status</span>
          <select
            value={filters.statusQuick}
            onChange={(e) => setFilters((prev) => ({ ...prev, statusQuick: e.target.value as FiltersState['statusQuick'] }))}
            className="border rounded px-2 py-1"
          >
            <option value="all">All</option>
            <option value="cut">Cut</option>
            <option value="uncut">Uncut</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium">Status</span>
          <select
            value={filters.statuses[0] ?? ''}
            onChange={(e) => {
              const v = e.target.value as '' | JobStatus;
              setFilters((prev) => ({ ...prev, statuses: v ? [v] : [] }));
            }}
            className="border rounded px-2 py-1"
          >
            <option value="">Any</option>
            {statusOptions.map((status) => (
              <option key={status} value={status}>{formatStatusLabel(status)}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium">Material</span>
          <select
            value={filters.materials[0] ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              setFilters((prev) => ({ ...prev, materials: v ? [v] : [] }));
            }}
            className="border rounded px-2 py-1"
          >
            <option value="">Any</option>
            {materialOptions.map((material) => (
              <option key={material} value={material}>{material}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium">Machine</span>
          <select
            value={filters.machineId != null ? String(filters.machineId) : ''}
            onChange={(e) => setFilters((prev) => ({ ...prev, machineId: e.target.value ? Number(e.target.value) : undefined }))}
            className="border rounded px-2 py-1"
          >
            <option value="">Any</option>
            {machines.map((machine) => (
              <option key={machine.machineId} value={machine.machineId}>{machine.name}</option>
            ))}
          </select>
        </label>
        <div className="flex gap-2">
          <Button
            variant="default"
            size="sm"
            onClick={() => refresh()}
            disabled={loading}
          >
            <Filter />
            Apply
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const reset = { ...defaultFilters };
              setSearch('');
              setFilters(reset);
              setRowSelection({});
              setContextMenu(null);
              setBulkMachine('');
              refresh({ filters: reset, search: '' });
            }}
            disabled={loading}
          >
            <FilterX />
            Reset
          </Button>
        </div>
      </div>

      {selectedCount > 0 && (
        <div className="flex flex-wrap items-center gap-3 border rounded px-3 py-2 bg-muted/40">
          <span className="text-sm font-medium">{selectedCount} selected</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => performReserve(selectedKeys, 'reserve')}
            disabled={actionBusy || !canBulkReserve}
          >
            <Lock />
            Reserve
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => performReserve(selectedKeys, 'unreserve')}
            disabled={actionBusy || !anyReserved}
          >
            <Unlock />
            Unreserve
          </Button>
          <div className="flex items-center gap-2">
            <select
              value={bulkMachine === '' ? '' : String(bulkMachine)}
              onChange={(e) => setBulkMachine(e.target.value ? Number(e.target.value) : '')}
              className="border rounded px-2 py-1 text-sm"
            >
              <option value="">Select machine</option>
              {machines.map((machine) => (
                <option key={machine.machineId} value={machine.machineId}>{machine.name}</option>
              ))}
            </select>
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                if (typeof bulkMachine === 'number') {
                  performWorklist(selectedKeys, bulkMachine);
                }
              }}
              disabled={actionBusy || typeof bulkMachine !== 'number'}
            >
              <Plus />
              Add to Worklist
            </Button>
          </div>
        </div>
      )}

      <GlobalTable
        table={table}
        onRowContextMenu={(row, event) => handleRowContextMenu(event, row.original.key)}
      />

      {historyKey && historyOpen && (
        <div className="border rounded bg-card text-card-foreground p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold">History ? {historyKey}</h2>
              <p className="text-xs text-muted-foreground">
                {historyLoading ? 'Loading?' : historyError ? historyError : `${historyEvents?.length || 0} event(s)`}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={refreshHistory} disabled={historyLoading}>
                <RefreshCw />
                Refresh
              </Button>
              <Button variant="outline" size="sm" onClick={() => setHistoryOpen(false)}>
                <EyeOff />
                Hide
              </Button>
            </div>
          </div>
          <div className="max-h-60 overflow-auto border border-[var(--table-border)] rounded bg-table">
            <table className="w-full text-xs text-[var(--table-text)] table-text">
              <thead className="bg-[var(--table-header-bg)] text-[var(--table-text)] sticky top-0 z-10">
                <tr className="border-b-0">
                  <th className="text-left px-2 py-1 font-medium">Time</th>
                  <th className="text-left px-2 py-1 font-medium">Event</th>
                  <th className="text-left px-2 py-1 font-medium">Machine</th>
                  <th className="text-left px-2 py-1 font-medium">Details</th>
                </tr>
              </thead>
              <tbody>
                {historyEvents.map((event) => (
                  <tr key={event.id} className="border-b border-[var(--table-row-border)]">
                    <td className="px-2 py-1 whitespace-nowrap">{formatTimestamp(event.createdAt)}</td>
                    <td className="px-2 py-1 font-mono text-[11px]">{event.eventType}</td>
                    <td className="px-2 py-1">{event.machineId != null ? machineNameById.get(event.machineId) ?? event.machineId : ''}</td>
                    <td className="px-2 py-1">
                      <pre className="whitespace-pre-wrap text-[11px]">{event.payload != null ? JSON.stringify(event.payload, null, 2) : ''}</pre>
                    </td>
                  </tr>
                ))}
                {!(historyEvents?.length) && !historyLoading && !historyError && (
                  <tr>
                    <td colSpan={4} className="px-2 py-3 text-center text-muted-foreground">No history events.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {historyKey && !historyOpen && (
        <div className="text-xs text-muted-foreground">
          History hidden ? <Button variant="link" size="sm" onClick={() => setHistoryOpen(true)}>
            <Eye />
            show for {historyKey}
          </Button>
        </div>
      )}

      {contextMenu && (
        <div className="fixed inset-0 z-30" onClick={() => setContextMenu(null)}>
          <div
            data-context-menu
            className="absolute min-w-[220px] rounded border bg-background shadow-lg p-2 space-y-2"
            style={{
              top: Math.min(contextMenu.position.y, window.innerHeight - 220),
              left: Math.min(contextMenu.position.x, window.innerWidth - 240)
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="text-xs text-muted-foreground">{contextMenu.keys?.length || 0} job(s) selected</div>
            <div className="border-t pt-2">
              <div className="text-xs uppercase text-muted-foreground mb-1">Add to Worklist</div>
              <div className="max-h-64 overflow-auto">
                {machines.map((machine) => (
                  <Button
                    key={machine.machineId}
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start"
                    disabled={actionBusy}
                    onClick={() => performWorklist(contextMenu.keys || [], machine.machineId)}
                  >
                    <PlayCircle />
                    {machine.name}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


