import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getCoreRowModel,
  getSortedRowModel,
  useReactTable
} from '@tanstack/react-table';
import type { ColumnDef, SortingState } from '@tanstack/react-table';
import { GlobalTable } from '@/components/table/GlobalTable';
import type { AllocatedMaterialRow, JobRow, JobsListReq, Machine } from '../../../shared/src';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, ContextMenuSeparator, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent } from '@/components/ui/context-menu';
import type { RowSelectionState } from '@tanstack/react-table';

const numberFormatter = new Intl.NumberFormat(undefined, { useGrouping: false });

// Percent widths normalized in GlobalTable
const ALLOCATED_COL_PCT = {
  typeData: 7,
  customerId: 14,
  folder: 18,
  ncfile: 16,
  dimensions: 14,
  status: 9,
  stock: 7,
  available: 7,
  allocatedAt: 8,
} as const;

function formatNumber(value: number | null | undefined): string {
  if (value == null) return 'N/A';
  return numberFormatter.format(value);
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return 'N/A';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function formatDimensions(row: AllocatedMaterialRow): string {
  const parts = [
    row.lengthMm != null ? numberFormatter.format(row.lengthMm) : null,
    row.widthMm != null ? numberFormatter.format(row.widthMm) : null,
    row.thicknessMm != null ? numberFormatter.format(row.thicknessMm) : null
  ].filter((part): part is string => part != null);
  return parts.length ? parts.join(' x ') : 'N/A';
}

export function AllocatedMaterialPage() {
  const [rows, setRows] = useState<AllocatedMaterialRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'status', desc: true }]);
  const lastRefreshRef = useRef(0);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [machines, setMachines] = useState<Machine[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await window.api.allocatedMaterial.list();
    if (!res.ok) {
      alert(`Failed to load allocated material: ${res.error.message}`);
      setRows([]);
      setLoading(false);
      return;
    }
    setRows(res.value.items);
    lastRefreshRef.current = Date.now();
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const MIN_GAP_MS = 2_000;
    const unsubscribe = window.api.allocatedMaterial.subscribe(() => {
      const now = Date.now();
      if (now - lastRefreshRef.current < MIN_GAP_MS) {
        return;
      }
      lastRefreshRef.current = now;
      void load();
    });
    return unsubscribe;
  }, [load]);

  useEffect(() => {
    (async () => {
      const res = await window.api.machines.list();
      if (res.ok) setMachines(res.value.items);
    })();
  }, []);

  const columns = useMemo<ColumnDef<AllocatedMaterialRow>[]>(() => [
    // 1) Type
    {
      id: 'typeData',
      header: 'Type',
      accessorKey: 'typeData',
      cell: (info) => {
        const value = info.getValue<number | null>();
        return value != null ? String(value) : 'N/A';
      },
      sortingFn: 'basic',
      meta: { widthPercent: ALLOCATED_COL_PCT.typeData, minWidthPx: 70 }
    },
    // 2) Customer ID
    {
      id: 'customerId',
      header: 'Customer ID',
      accessorKey: 'customerId',
      cell: (info) => info.getValue<string | null>() ?? 'N/A',
      sortingFn: 'alphanumeric',
      meta: { widthPercent: ALLOCATED_COL_PCT.customerId, minWidthPx: 140 }
    },
    // 3) Folder
    {
      id: 'folder',
      header: 'Folder',
      accessorKey: 'folder',
      cell: (info) => info.getValue<string | null>() ?? 'N/A',
      sortingFn: 'alphanumeric',
      meta: { widthPercent: ALLOCATED_COL_PCT.folder, minWidthPx: 180 }
    },
    // 4) NC File
    {
      id: 'ncfile',
      header: 'NC File',
      accessorKey: 'ncfile',
      cell: (info) => info.getValue<string | null>() ?? 'N/A',
      sortingFn: 'alphanumeric',
      meta: { widthPercent: ALLOCATED_COL_PCT.ncfile, minWidthPx: 160 }
    },
    // 5) Dimensions
    {
      id: 'dimensions',
      header: 'Dimensions (LxWxT)',
      accessorFn: (row) => formatDimensions(row),
      cell: (info) => info.getValue<string>(),
      sortingFn: 'alphanumeric',
      meta: { widthPercent: ALLOCATED_COL_PCT.dimensions, minWidthPx: 140 }
    },
    // 6) Status
    {
      id: 'status',
      header: 'Status',
      accessorFn: (row) => (row.jobLocked ? 2 : 1),
      cell: ({ row }) => (row.original.jobLocked ? 'Locked' : 'Pre-Reserved'),
      sortingFn: 'basic',
      meta: { widthPercent: ALLOCATED_COL_PCT.status, minWidthPx: 110 }
    },
    // 7) Stock
    {
      id: 'stock',
      header: 'Stock',
      accessorKey: 'stock',
      cell: (info) => formatNumber(info.getValue<number | null>()),
      sortingFn: 'basic',
      meta: { widthPercent: ALLOCATED_COL_PCT.stock, minWidthPx: 80 }
    },
    // 8) Available
    {
      id: 'stockAvailable',
      header: 'Available',
      accessorKey: 'stockAvailable',
      cell: (info) => formatNumber(info.getValue<number | null>()),
      sortingFn: 'basic',
      meta: { widthPercent: ALLOCATED_COL_PCT.available, minWidthPx: 80 }
    },
    // 9) Allocated Date
    {
      id: 'allocatedAt',
      header: 'Allocated Date',
      accessorKey: 'allocatedAt',
      cell: (info) => formatTimestamp(info.getValue<string | null>()),
      sortingFn: 'datetime',
      meta: { widthPercent: ALLOCATED_COL_PCT.allocatedAt, minWidthPx: 140 }
    }
  ], []);

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, rowSelection },
    onSortingChange: setSorting,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableRowSelection: true,
    enableColumnResizing: false
  });

  const selected = table.getSelectedRowModel().rows.map(r => r.original);
  const selectedKeys = selected.map(r => r.jobKey);
  const anyPreReserved = selected.some(r => r.jobPreReserved);
  const anyLocked = selected.some(r => r.jobLocked);

  const ensureRowSelectedOnContext = useCallback((rowKey: string) => {
    setRowSelection((prev) => {
      if (Object.keys(prev).length) return prev;
      const next: RowSelectionState = {};
      // find index of row with jobKey
      const idx = rows.findIndex(r => r.jobKey === rowKey);
      if (idx >= 0) {
        // table row ids are positional (default getRowId is index)
        next[String(idx)] = true;
      }
      return next;
    });
  }, [rows]);

  const performUnreserve = useCallback(async (keys: string[]) => {
    if (!keys.length) return;
    try {
      const failures: string[] = [];
      for (const key of keys) {
        const res = await window.api.jobs.unreserve(key);
        if (!res.ok) failures.push(`${key}: ${res.error.message}`);
      }
      if (failures.length) alert(`Failed to unreserve ${failures.length} job(s): ${failures.join(', ')}`);
    } finally {
      setRowSelection({});
      void load();
    }
  }, [load]);

  const performUnlock = useCallback(async (keys: string[]) => {
    if (!keys.length) return;
    try {
      const res = await window.api.jobs.unlockBatch(keys);
      if (!res.ok) alert(`Failed to unlock job(s): ${res.error.message}`);
    } finally {
      setRowSelection({});
      void load();
    }
  }, [load]);

  async function fetchJobByKey(key: string): Promise<JobRow | null> {
    const res = await window.api.jobs.list({ search: key, limit: 1, sortBy: 'dateadded', sortDir: 'desc', filter: {} as JobsListReq['filter'] });
    if (!res.ok) return null;
    return res.value.items[0] ?? null;
  }

  const performWorklist = useCallback(async (keys: string[], machineId: number) => {
    if (!keys.length) return;
    let stagedCount = 0;
    const failures: string[] = [];

    for (const key of keys) {
      let rerun = false;
      try {
        const job = await fetchJobByKey(key);
        if (job) {
          const notPending = job.status !== 'PENDING';
          const differentMachineWhileStaged = job.status === 'STAGED' && job.machineId != null && job.machineId !== machineId;
          rerun = notPending || differentMachineWhileStaged;
        }
      } catch {
        // ignore; will try normal path
      }

      if (rerun) {
        const res = await window.api.jobs.rerunAndStage(key, machineId);
        if (!res.ok || !res.value.ok) failures.push(`${key}: ${res.ok ? res.value.error : res.error.message}`);
        else stagedCount += 1;
      } else {
        const res = await window.api.jobs.addToWorklist(key, machineId);
        if (!res.ok || !res.value.ok) failures.push(`${key}: ${res.ok ? res.value.error : res.error.message}`);
        else stagedCount += 1;
      }
    }

    if (stagedCount) alert(`Staged ${stagedCount} job(s).`);
    if (failures.length) alert(`Failed to stage ${failures.length} job(s):\n\n${failures.join('\n')}`);
    setRowSelection({});
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end">
        <button
          type="button"
          className="border rounded px-3 py-1 text-sm"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-[var(--table-border)] bg-table px-6 py-10 text-center text-muted-foreground">
          {loading ? 'Loading allocated material...' : 'No allocated material found.'}
        </div>
      ) : (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div>
              <GlobalTable
                table={table}
                className="bg-table"
                onRowContextMenu={(row, event) => {
                  if (event) ensureRowSelectedOnContext(row.original.jobKey);
                }}
                preventContextMenuDefault={false}
              />
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-56">
            <ContextMenuItem inset disabled className="cursor-default opacity-100">
              {selectedKeys.length === 1 ? '1 job selected' : `${selectedKeys.length} jobs selected`}
            </ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger inset>Send to Machine</ContextMenuSubTrigger>
              <ContextMenuSubContent className="w-44">
                {machines.map((m) => (
                  <ContextMenuItem key={m.machineId} onSelect={() => performWorklist(selectedKeys, m.machineId)}>
                    {m.name}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => performUnreserve(selectedKeys)} disabled={!anyPreReserved}>Unreserve</ContextMenuItem>
            <ContextMenuItem onSelect={() => performUnlock(selectedKeys)} disabled={!anyLocked}>Unlock</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}
    </div>
  );
}
