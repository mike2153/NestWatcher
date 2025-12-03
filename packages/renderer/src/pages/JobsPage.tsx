import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { flushSync } from 'react-dom';
import {
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  getExpandedRowModel,
} from '@tanstack/react-table';
import type { ColumnDef, ColumnSizingState, RowSelectionState, SortingState, ExpandedState } from '@tanstack/react-table';
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
import { ValidationDataModal } from '@/components/ValidationDataModal';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent
} from '@/components/ui/context-menu';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription
} from '@/components/ui/sheet';
import {
  Filter,
  FilterX,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  ChevronsDown,
  ChevronsRight
} from 'lucide-react';

const COLUMN_SIZING_KEY = 'jobs:columnSizing';
const AUTO_REFRESH_ENABLED_KEY = 'jobs:autoRefresh';
const AUTO_REFRESH_INTERVAL_KEY = 'jobs:autoRefreshInterval';
const DEFAULT_LIMIT = 200;
const HISTORY_LIMIT = 200;

// Type for grouped table rows
type TableRow = JobRow | FolderGroupRow;

function isFolderGroupRow(row: TableRow): row is FolderGroupRow {
  return (row as FolderGroupRow)._type === 'folder-group';
}

function isJobRow(row: TableRow): row is JobRow {
  return !isFolderGroupRow(row);
}
type FolderGroupRow = {
  _type: 'folder-group';
  folder: string;
  subRows: JobRow[];
};

// Configure target percent widths for Jobs table columns. Values do not need to sum to 100;
// they will be normalized at render time. Adjust here to tweak layout globally.
const JOBS_COLUMN_WIDTHS_PCT: Record<string, number> = {
  folder: 14,
  ncfile: 12,
  material: 8,
  parts: 5,
  size: 10,
  dateadded: 12,
  locked: 6,
  status: 11,
  processingSeconds: 10,
  machineId: 8,
};

type StatusGroup = 'pending' | 'processing' | 'complete';

type FiltersState = {
  statusGroups: StatusGroup[];
  materials: string[];
  machineId?: number;
  completedTimeframe: '1day' | '3days' | '7days' | '1month' | 'all';
};

const defaultFilters: FiltersState = {
  statusGroups: ['pending', 'processing', 'complete'],
  materials: [],
  machineId: undefined,
  completedTimeframe: '7days'
};

function renderUserMeta(name?: string | null, timestamp?: string | null) {
  if (!name && !timestamp) return null;
  const parts: string[] = [];
  if (name) parts.push(name);
  if (timestamp) {
    const formatted = formatTimestamp(timestamp);
    if (formatted) parts.push(formatted);
  }
  if (!parts.length) return null;
  return <span className="text-xs text-muted-foreground">{parts.join(' • ')}</span>;
}

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

function formatEventName(eventType: string): string {
  // Convert event type to user-friendly format
  // Examples: "autopac:cnc_finish" -> "AutoPAC CNC Finish"
  //           "nestpick:forwarded" -> "Nestpick Forwarded"
  //           "lifecycle:staged" -> "Lifecycle Staged"

  const parts = eventType.split(':');
  const formatted = parts.map(part => {
    // Split by underscore and capitalize each word
    return part
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }).join(': ');

  return formatted;
}

function formatPayload(payload: unknown): React.ReactNode {
  if (payload == null) return null;
  if (typeof payload !== 'object') return String(payload);

  const obj = payload as Record<string, unknown>;
  const entries = Object.entries(obj);

  if (entries.length === 0) return null;

  // Track seen keys (case-insensitive and normalized) to avoid duplicates
  const seenKeys = new Set<string>();
  const uniqueEntries = entries.filter(([key]) => {
    const normalizedKey = key.toLowerCase().replace(/[_\s-]/g, '');
    if (seenKeys.has(normalizedKey)) {
      return false;
    }
    seenKeys.add(normalizedKey);
    return true;
  });

  // Format as key-value pairs
  return (
    <div className="space-y-1">
      {uniqueEntries.map(([key, value]) => {
        // Format key to be more readable
        const formattedKey = key
          .replace(/([A-Z])/g, ' $1')
          .replace(/^./, str => str.toUpperCase())
          .trim();

        // Format value based on type
        let formattedValue: string;
        if (value == null) {
          formattedValue = '-';
        } else if (typeof value === 'object') {
          formattedValue = JSON.stringify(value);
        } else {
          formattedValue = String(value);
        }

        return (
          <div key={key} className="text-xs">
            <span className="text-muted-foreground">{formattedKey}:</span>{' '}
            <span className="font-medium">{formattedValue}</span>
          </div>
        );
      })}
    </div>
  );
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

// Formatter used to normalize number display (no grouping)
const numberFormatter = new Intl.NumberFormat(undefined, { useGrouping: false });

// Parse size and thickness fields into a unified L x W x T string
function formatJobDimensions(row: JobRow): string {
  const size = row.size ?? '';
  const thickness = row.thickness ?? '';

  // Extract up to first two numeric parts from size (handles separators like x, *, spaces)
  const sizeNums = Array.from(size.matchAll(/\d+(?:\.\d+)?/g)).map((m) => m[0]);
  const parts: string[] = [];
  if (sizeNums[0]) parts.push(numberFormatter.format(Number(sizeNums[0])));
  if (sizeNums[1]) parts.push(numberFormatter.format(Number(sizeNums[1])));

  // Extract first numeric part from thickness
  const tMatch = thickness.match(/\d+(?:\.\d+)?/);
  if (tMatch) parts.push(numberFormatter.format(Number(tMatch[0])));

  return parts.length ? parts.join(' x ') : 'N/A';
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
  const [columnSizing, _setColumnSizing] = useState<ColumnSizingState>(loadColumnSizing);
  // Context menu is now handled by shadcn-style component; keep only selection logic
  
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
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [historyJobKey, setHistoryJobKey] = useState<string | null>(null);
  const [validationModalOpen, setValidationModalOpen] = useState(false);
  const [validationJobKey, setValidationJobKey] = useState<string | null>(null);
  const [validationJobKeys, setValidationJobKeys] = useState<string[] | null>(null);
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const isRefreshingRef = useRef(false);

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
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem('jobs:statusFilter');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((value) => ['pending', 'processing', 'complete'].includes(value))) {
        setFilters((prev) => ({ ...prev, statusGroups: parsed as StatusGroup[] }));
      }
    } catch (err) {
      console.warn('Failed to load persisted jobs status filter', err);
    }
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

  const statusGroupsToStatuses = useCallback((groups: StatusGroup[]): JobStatus[] => {
    const statuses: JobStatus[] = [];

    if (groups.includes('pending')) {
      statuses.push('PENDING');
    }

    if (groups.includes('processing')) {
      statuses.push('STAGED', 'LOAD_FINISH', 'LABEL_FINISH', 'FORWARDED_TO_NESTPICK');
    }

    if (groups.includes('complete')) {
      statuses.push('CNC_FINISH', 'NESTPICK_COMPLETE');
    }

    return statuses;
  }, []);

  const refresh = useCallback(async (override?: { filters?: FiltersState; search?: string; sorting?: SortingState }) => {
    if (isRefreshingRef.current) return;
    isRefreshingRef.current = true;
    setLoading(true);
    try {
      const sortingState = override?.sorting ?? sorting;
      const primarySort = sortingState[0] ?? { id: 'dateadded', desc: true };
      const filterState = override?.filters ?? filters;
      const searchValue = override?.search ?? search;
      const filter: JobsListReq['filter'] = {
        machineId: filterState.machineId,
        completedTimeframe: filterState.completedTimeframe
      };

      // Convert status groups to actual statuses
      const statuses = statusGroupsToStatuses(filterState.statusGroups);
      if (statuses.length > 0 && statuses.length < JOB_STATUS_VALUES.length) {
        filter.statusIn = statuses as JobsListReq['filter']['statusIn'];
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
      isRefreshingRef.current = false;
    }
  }, [filters, search, sorting, statusGroupsToStatuses]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!autoRefreshEnabled) return;
    const id = window.setInterval(() => {
      if (!isRefreshingRef.current) {
        void refresh();
      }
    }, autoRefreshInterval * 1000);
    return () => window.clearInterval(id);
  }, [autoRefreshEnabled, autoRefreshInterval, refresh]);

  // Group jobs by folder
  const displayData = useMemo<TableRow[]>(() => {
    const grouped = new Map<string, JobRow[]>();

    for (const job of data) {
      const folderKey = job.folder || '__no_folder__';
      const list = grouped.get(folderKey) || [];
      list.push(job);
      grouped.set(folderKey, list);
    }

    const result: TableRow[] = [];
    for (const [folderKey, jobs] of grouped.entries()) {
      const folderGroup: FolderGroupRow = {
        _type: 'folder-group',
        folder: folderKey === '__no_folder__' ? '' : folderKey,
        subRows: jobs
      };
      result.push(folderGroup);
    }

    return result;
  }, [data]);

  useEffect(() => {
    setRowSelection((prev) => {
      if (!Object.keys(prev).length) return prev;
      const available = new Set<string>();
      for (const row of displayData) {
        if ('_type' in row && row._type === 'folder-group') {
          for (const job of row.subRows) {
            available.add(job.key);
          }
        }
      }
      const next: RowSelectionState = {};
      for (const key of Object.keys(prev)) {
        if (available.has(key)) next[key] = true;
      }
      return next;
    });
  }, [displayData]);

  // No custom overlay state to sync

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

  const columns = useMemo<ColumnDef<TableRow>[]>(() => [
    {
      accessorKey: 'folder',
      header: 'Folder',
      meta: { widthPercent: JOBS_COLUMN_WIDTHS_PCT.folder, minWidthPx: 140 },
      cell: ({ row, getValue }) => {
        const rowData = row.original;
        if ('_type' in rowData && rowData._type === 'folder-group') {
          return (
            <div className="flex items-center gap-2 font-medium">
              <button
                onClick={(e) => { e.stopPropagation(); row.toggleExpanded(); }}
                className="inline-flex items-center"
              >
                {row.getIsExpanded() ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>
              {formatFolderLabel(rowData.folder)}
            </div>
          );
        }
        const value = getValue<string | null>();
        const isSubRow = row.depth > 0;
        return (
          <div className={isSubRow ? 'pl-8' : ''}>
            {formatFolderLabel(value)}
          </div>
        );
      }
    },
    {
      accessorKey: 'ncfile',
      header: 'NC File',
      meta: { widthPercent: JOBS_COLUMN_WIDTHS_PCT.ncfile, minWidthPx: 140 },
      cell: ({ row, getValue }) => {
        if ('_type' in row.original && row.original._type === 'folder-group') return '';
        return getValue();
      }
    },
    {
      accessorKey: 'material',
      header: 'Material',
      meta: { widthPercent: JOBS_COLUMN_WIDTHS_PCT.material, minWidthPx: 100 },
      cell: ({ row, getValue }) => {
        if ('_type' in row.original && row.original._type === 'folder-group') return '';
        return getValue();
      }
    },
    {
      accessorKey: 'parts',
      header: 'Parts',
      meta: { widthPercent: JOBS_COLUMN_WIDTHS_PCT.parts, minWidthPx: 60 },
      cell: ({ row, getValue }) => {
        if ('_type' in row.original && row.original._type === 'folder-group') return '';
        return getValue();
      }
    },
    {
      id: 'size',
      header: 'Dimensions (LxWxT)',
      accessorFn: (row) => (isFolderGroupRow(row) ? '' : formatJobDimensions(row)),
      cell: (info) => info.getValue<string>(),
      sortingFn: 'alphanumeric',
      meta: { widthPercent: JOBS_COLUMN_WIDTHS_PCT.size, minWidthPx: 120 }
    },

    {
      accessorKey: 'dateadded',
      header: 'Date Added',
      meta: { widthPercent: JOBS_COLUMN_WIDTHS_PCT.dateadded, minWidthPx: 150 },
      cell: ({ row, getValue }) => {
        if ('_type' in row.original && row.original._type === 'folder-group') return '';
        const value = getValue<string | null>();
        if (!value) return '';
        return formatTimestamp(value);
      }
    },
    {
      accessorKey: 'locked',
      header: 'Locked',
      meta: { widthPercent: JOBS_COLUMN_WIDTHS_PCT.locked, minWidthPx: 70 },
      cell: ({ row, getValue }) => {
        if ('_type' in row.original && row.original._type === 'folder-group') return '';
        const locked = getValue<boolean>();
        if (!locked) return 'No';
        const jobRow = row.original as JobRow;
        return (
          <div className="flex flex-col">
            <span>Yes</span>
            {renderUserMeta(jobRow.lockedBy, jobRow.allocatedAt)}
          </div>
        );
      }
    },
    {
      accessorKey: 'status',
      header: 'Status',
      meta: { widthPercent: JOBS_COLUMN_WIDTHS_PCT.status, minWidthPx: 110 },
      cell: ({ row, getValue }) => {
        if ('_type' in row.original && row.original._type === 'folder-group') return '';
        const raw = getValue<JobStatus | null>();
        if (!raw) return <span className="text-muted-foreground">-</span>;
        const badge = (
          <span className={cn('inline-flex items-center rounded px-2 py-0.5 text-sm font-medium', statusBadgeClass(raw))}>
            {formatStatusLabel(raw)}
          </span>
        );
        if ((row.original as JobRow).status === 'STAGED') {
          const jobRow = row.original as JobRow;
          return (
            <div className="flex flex-col">
              {badge}
              {renderUserMeta(jobRow.stagedBy, jobRow.stagedAt)}
            </div>
          );
        }
        return badge;
      }
    },
    {
      accessorKey: 'processingSeconds',
      header: 'Processing Time',
      meta: { widthPercent: JOBS_COLUMN_WIDTHS_PCT.processingSeconds, minWidthPx: 110 },
      enableSorting: false,
      cell: ({ row, getValue }) => {
        if ('_type' in row.original && row.original._type === 'folder-group') return '';
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
      accessorKey: 'machineId',
      header: 'Machine',
      meta: { widthPercent: JOBS_COLUMN_WIDTHS_PCT.machineId, minWidthPx: 130 },
      enableSorting: false,
      cell: ({ row, getValue }) => {
        if ('_type' in row.original && row.original._type === 'folder-group') return '';
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
    data: displayData,
    columns,
    state: {
      sorting,
      rowSelection,
      expanded
    },
    getRowId: (row) => (isFolderGroupRow(row) ? `folder:${row.folder}` : row.key),
    getSubRows: (row) => (isFolderGroupRow(row) ? row.subRows : undefined),
    onSortingChange: setSorting,
    onRowSelectionChange: setRowSelection,
    onExpandedChange: setExpanded,
    // use percentage widths; disable column resizing
    enableRowSelection: (row) => isJobRow(row.original),
    enableSubRowSelection: true,
    enableColumnResizing: false,
    enableMultiSort: false,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getExpandedRowModel: getExpandedRowModel()
  });

  const selectedRowsData = useMemo(() => {
    const selectedRows = table.getSelectedRowModel().flatRows;

    console.log('=== Selection Debug ===');
    console.log('rowSelection state:', rowSelection);
    console.log('selectedRows from table:', selectedRows.length, selectedRows.map(r => ({ id: r.id, original: r.original })));

    const selectedKeys = selectedRows
      .map((row) => row.original)
      .filter(isJobRow)
      .map((r) => r.key);
    const selectedJobs = selectedRows
      .map((row) => row.original)
      .filter(isJobRow);

    console.log('selectedKeys:', selectedKeys);
    console.log('selectedJobs count:', selectedJobs.length);

    const anyLocked = selectedJobs.some((job) => job.locked);
    const anyUnlocked = selectedJobs.some((job) => !job.locked);
    const isSingleSelection = selectedKeys.length === 1;

    console.log('Computed values:', { anyLocked, anyUnlocked });

    return {
      selectedKeys,
      selectedJobs,
      anyLocked,
      anyUnlocked,
      isSingleSelection
    };
  }, [table, rowSelection]);

  const { selectedKeys, anyLocked, anyUnlocked, isSingleSelection } = selectedRowsData;

  const performLock = useCallback(
    async (targetKeys: string[], mode: 'lock' | 'unlock') => {
      if (!targetKeys.length) return;
      setActionBusy(true);
      try {
        if (mode === 'lock') {
          const res = await window.api.jobs.lockBatch(targetKeys);
          if (!res.ok) {
            alert(`Lock failed: ${res.error.message}`);
          }
        } else {
          const res = await window.api.jobs.unlockBatch(targetKeys);
          if (!res.ok) {
            alert(`Unlock failed: ${res.error.message}`);
          }
        }
        await refresh();
        setRowSelection({});
      } finally {
        setActionBusy(false);
      }
    },
    [refresh]
  );

  const performWorklist = useCallback(async (targetKeys: string[], machineId: number) => {
    if (!targetKeys.length) return;
    setActionBusy(true);
    try {
      const failures: string[] = [];
      let stagedCount = 0;
      const rerunKeys: string[] = [];
      const normalKeys: string[] = [];
      for (const key of targetKeys) {
        const job = jobByKey.get(key);
        if (!job) continue;
        const notPending = job.status !== 'PENDING';
        const differentMachineWhileStaged = job.status === 'STAGED' && job.machineId != null && job.machineId !== machineId;
        const needsRerun = notPending || differentMachineWhileStaged;
        if (needsRerun) rerunKeys.push(key); else normalKeys.push(key);
      }

      if (rerunKeys.length) {
        const list = rerunKeys
          .map((k) => jobByKey.get(k))
          .filter((j): j is JobRow => !!j)
          .map((j) => `${j.folder ?? ''}/${j.ncfile ?? j.key} — ${j.status}${j.machineId != null ? ` (Machine ${j.machineId})` : ''}`)
          .join('\n');
        const ok = window.confirm(
          `${rerunKeys.length} job(s) will be re-run (run2, run3, ...) and staged to the selected machine.\n\n${list}\n\nContinue?`
        );
        if (!ok) {
          setActionBusy(false);
          return;
        }
      }

      // Stage normal PENDING jobs first
      for (const key of normalKeys) {
        const res = await window.api.jobs.addToWorklist(key, machineId);
        if (!res.ok) failures.push(`${key}: ${res.error.message}`);
        else if (!res.value.ok) failures.push(`${key}: ${res.value.error}`);
        else stagedCount += 1;
      }

      // Rerun and stage
      for (const key of rerunKeys) {
        const res = await window.api.jobs.rerunAndStage(key, machineId);
        if (!res.ok) failures.push(`${key}: ${res.error.message}`);
        else if (!res.value.ok) failures.push(`${key}: ${res.value.error}`);
        else stagedCount += 1;
      }

      if (stagedCount) alert(`Staged ${stagedCount} job(s).`);
      if (failures.length) alert(`Failed to stage ${failures.length} job(s):\n\n${failures.join('\n')}`);

      await refresh();
      setRowSelection({});
    } finally {
      setActionBusy(false);
    }
  }, [jobByKey, refresh]);

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
    if (!historyJobKey || !historyModalOpen) {
      return;
    }
    loadHistory(historyJobKey);
  }, [historyJobKey, historyModalOpen, loadHistory]);

  const refreshHistory = useCallback(() => {
    if (historyJobKey) loadHistory(historyJobKey);
  }, [historyJobKey, loadHistory]);

  const openHistoryModal = useCallback((key: string) => {
    setHistoryJobKey(key);
    setHistoryModalOpen(true);
  }, []);

  const updateStatusFilter = useCallback(async (newGroups: StatusGroup[]) => {
    setFilters((prev) => ({ ...prev, statusGroups: newGroups }));
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem('jobs:statusFilter', JSON.stringify(newGroups));
      } catch (err) {
        console.warn('Failed to persist jobs status filter', err);
      }
    }
  }, []);

  const handleRowContextMenu = useCallback((event: MouseEvent<HTMLTableRowElement>, rowKey: string) => {
    // If the right-clicked row is not part of the current selection,
    // select only that row so context menu actions apply as expected.
    if (!rowSelection[rowKey]) {
      // Use flushSync to ensure the selection update happens before the context menu opens
      flushSync(() => {
        setRowSelection({ [rowKey]: true });
      });
    }
    // Don't prevent default - let ContextMenu component handle it
  }, [rowSelection]);

  // Context menu open/close handled by ContextMenu component

  // const statusOptions = filterOptions?.statuses?.length ? filterOptions.statuses : JOB_STATUS_VALUES; // unused
  const materialOptions = filterOptions?.materials || [];

  return (
    <div className="space-y-3 w-full">
      <div className="flex items-center justify-between">
        <div />
        <div className="flex items-center gap-3">
          {listError && (
            <div className="border border-red-300 bg-red-50 text-red-700 text-sm px-3 py-1.5 rounded">{listError}</div>
          )}
          <p className="text-sm text-muted-foreground">
            {loading ? 'Refreshing…' : `${data.length} job${data.length === 1 ? '' : 's'} in ${displayData.length} folder${displayData.length === 1 ? '' : 's'}`}
          </p>
        </div>
      </div>

      <div className="flex flex-nowrap gap-2 items-end overflow-x-auto">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium">Search</span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search all fields"
            className="border rounded px-2 py-1 min-w-[12rem]"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium">Status</span>
          <select
            value={
              filters.statusGroups.length === 3 ? 'all' :
              filters.statusGroups.length === 1 ? filters.statusGroups[0] :
              // If a mixed selection somehow exists, treat as 'all' for display
              'all'
            }
            onChange={(e) => {
              const v = e.target.value as 'all' | StatusGroup;
              if (v === 'all') {
                updateStatusFilter(['pending', 'processing', 'complete']);
              } else {
                updateStatusFilter([v]);
              }
            }}
            className="border rounded px-2 py-1 w-48"
          >
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="processing">Processing</option>
            <option value="complete">Complete</option>
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
            className="border rounded px-2 py-1 w-48"
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
            className="border rounded px-2 py-1 w-48"
          >
            <option value="">Any</option>
            {machines.map((machine) => (
              <option key={machine.machineId} value={machine.machineId}>{machine.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium">Completed Jobs</span>
          <select
            value={filters.completedTimeframe}
            onChange={(e) => setFilters((prev) => ({ ...prev, completedTimeframe: e.target.value as FiltersState['completedTimeframe'] }))}
            className="border rounded px-2 py-1 w-48"
          >
            <option value="1day">Last 24 Hours</option>
            <option value="3days">Last 3 Days</option>
            <option value="7days">Last 7 Days</option>
            <option value="1month">Last Month</option>
            <option value="all">All Time</option>
          </select>
        </label>
        <div className="flex gap-2">
          <Button
            variant="default"
            size="sm"
            onClick={() => refresh()}
            disabled={loading}
            className="text-white"
          >
            <Filter />
            Apply
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              const reset = { ...defaultFilters };
              setSearch('');
              setFilters(reset);
              setRowSelection({});
              if (typeof window !== 'undefined') {
                try {
                  window.localStorage.setItem('jobs:statusFilter', JSON.stringify(reset.statusGroups));
                } catch (err) {
                  console.warn('Failed to persist jobs status filter', err);
                }
              }

              refresh({ filters: reset, search: '' });
            }}
            disabled={loading}
          >
            <FilterX />
            Reset
          </Button>
          <Button
            variant={table.getIsAllRowsExpanded() ? "default" : "outline"}
            size="sm"
            onClick={() => table.toggleAllRowsExpanded()}
            title={table.getIsAllRowsExpanded() ? "Collapse all folder groups" : "Expand all folder groups"}
          >
            {table.getIsAllRowsExpanded() ? (
              <>
                <ChevronsRight className="h-4 w-4" />
                Collapse All
              </>
            ) : (
              <>
                <ChevronsDown className="h-4 w-4" />
                Expand All
              </>
            )}
          </Button>
        </div>
        <div className="ml-auto flex gap-2 items-end" />
      </div>

      {/* Right-click for actions — toolbar removed as per request */}

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div>
            <GlobalTable
              table={table}
              onRowContextMenu={(row, event) => {
                const original = row.original;
                // Handle folder group rows - select all jobs in folder and show stats
                if (isFolderGroupRow(original)) {
                  const folderJobKeys = original.subRows.map((job) => job.key);
                  if (folderJobKeys.length > 0) {
                    // Set keys for aggregated stats and open modal directly
                    setValidationJobKey(null);
                    setValidationJobKeys(folderJobKeys);
                    setValidationModalOpen(true);
                  }
                  event.preventDefault();
                  return;
                }
                console.log('Right-clicked row:', { rowId: row.id, originalKey: original.key });
                handleRowContextMenu(event, row.id);
              }}
              preventContextMenuDefault={false}
              getRowClassName={(row) => {
                const original = row.original;
                if ('_type' in original && original._type === 'folder-group') {
                  return 'bg-muted/30 font-semibold cursor-pointer';
                }
                // Sub-row styling
                if (row.depth > 0) {
                  return 'bg-muted/10';
                }
                return undefined;
              }}
              onRowClick={(row) => {
                const original = row.original;
                if ('_type' in original && original._type === 'folder-group') {
                  row.toggleExpanded();
                }
              }}
              onRowDoubleClick={(row) => {
                const original = row.original;
                if (isJobRow(original)) {
                  setValidationJobKey(original.key);
                  setValidationModalOpen(true);
                }
              }}
              toggleRowSelectionOnClick={true}
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem inset disabled className="cursor-default opacity-100">
            {selectedKeys.length === 1 ? '1 job selected' : `${selectedKeys.length} jobs selected`}
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => performLock(selectedKeys, 'lock')}
            disabled={actionBusy || !anyUnlocked}
          >Lock</ContextMenuItem>
          <ContextMenuItem
            onSelect={() => performLock(selectedKeys, 'unlock')}
            disabled={actionBusy || !anyLocked}
          >Unlock</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() => isSingleSelection && openHistoryModal(selectedKeys[0])}
            disabled={!isSingleSelection}
          >View History</ContextMenuItem>
          <ContextMenuItem
            onSelect={() => {
              if (selectedKeys.length === 1) {
                setValidationJobKey(selectedKeys[0]);
                setValidationJobKeys(null);
              } else {
                setValidationJobKey(null);
                setValidationJobKeys(selectedKeys);
              }
              setValidationModalOpen(true);
            }}
            disabled={selectedKeys.length === 0}
          >Show Stats</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger inset>Select Machine</ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-44">
              {machines.map((m) => (
                <ContextMenuItem key={m.machineId} onSelect={() => performWorklist(selectedKeys, m.machineId)}>
                  {m.name}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        </ContextMenuContent>
      </ContextMenu>

      <Sheet open={historyModalOpen} onOpenChange={setHistoryModalOpen}>
        <SheetContent side="right" className="w-[800px] sm:w-[900px] max-w-[90vw] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Job History</SheetTitle>
            <SheetDescription>
              {historyJobKey && `History for ${historyJobKey}`}
            </SheetDescription>
          </SheetHeader>
          <div className="mt-4 space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {historyLoading ? 'Loading...' : historyError ? historyError : `${historyEvents?.length || 0} event(s)`}
              </p>
              <Button variant="outline" size="sm" onClick={refreshHistory} disabled={historyLoading}>
                <RefreshCw className="h-4 w-4" />
                Refresh
              </Button>
            </div>
            <div className="border border-[var(--table-border)] rounded bg-table overflow-auto max-h-[calc(100vh-200px)]">
              <table className="w-full text-sm text-[var(--table-text)] table-text">
                <thead className="bg-[var(--table-header-bg)] text-[var(--table-text)] sticky top-0 z-10">
                  <tr className="border-b-0">
                    <th className="text-left px-3 py-2 font-medium w-[160px]">Time</th>
                    <th className="text-left px-3 py-2 font-medium w-[200px]">Event</th>
                    <th className="text-left px-3 py-2 font-medium w-[120px]">Machine</th>
                    <th className="text-left px-3 py-2 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {historyEvents
                    .filter(event => !event.eventType.startsWith('status:'))
                    .map((event) => (
                      <tr key={event.id} className="border-b border-[var(--table-row-border)]">
                        <td className="px-3 py-2 whitespace-nowrap align-top">{formatTimestamp(event.createdAt)}</td>
                        <td className="px-3 py-2 align-top">{formatEventName(event.eventType)}</td>
                        <td className="px-3 py-2 align-top">{event.machineId != null ? machineNameById.get(event.machineId) ?? event.machineId : ''}</td>
                        <td className="px-3 py-2 align-top">
                          {formatPayload(event.payload)}
                        </td>
                      </tr>
                    ))
                  }
                  {!(historyEvents.filter(e => !e.eventType.startsWith('status:')).length) && !historyLoading && !historyError && (
                    <tr>
                      <td colSpan={4} className="px-3 py-3 text-center text-muted-foreground">No history events.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <ValidationDataModal
        open={validationModalOpen}
        onOpenChange={(next) => {
          setValidationModalOpen(next);
          if (!next) {
            setValidationJobKey(null);
            setValidationJobKeys(null);
          }
        }}
        jobKey={validationJobKey}
        jobKeys={validationJobKeys}
      />

      {/* Context menu handled above */}
    </div>
  );
}




