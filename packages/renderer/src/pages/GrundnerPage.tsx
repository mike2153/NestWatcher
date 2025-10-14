import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getCoreRowModel,
  getSortedRowModel,
  useReactTable
} from '@tanstack/react-table';
import type { ColumnDef, SortingState } from '@tanstack/react-table';
import { GlobalTable } from '@/components/table/GlobalTable';
import type { GrundnerListReq, GrundnerRow } from '../../../shared/src';
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
type Filters = {
  search: string;
  onlyAvailable: boolean;
  onlyReserved: boolean;
};

type EditState = {
  stockAvailable?: string;
};

export function GrundnerPage() {
  const [rows, setRows] = useState<GrundnerRow[]>([]);
  const [filters, setFilters] = useState<Filters>({ search: '', onlyAvailable: false, onlyReserved: false });
  const [limit, setLimit] = useState(200);
  const [editing, setEditing] = useState<Record<number, EditState>>({});
  const [loading, setLoading] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'typeData', desc: false }]);
  const lastLoadedAtRef = useRef<number>(0);
  const lastAutoRefreshAtRef = useRef<number>(0);
  const [pendingAutoRefresh, setPendingAutoRefresh] = useState(false);

  const totalStock = useMemo(() => rows.reduce((sum, row) => sum + (row.stock ?? 0), 0), [rows]);
  const totalAvailable = useMemo(() => rows.reduce((sum, row) => sum + (row.stockAvailable ?? 0), 0), [rows]);
  const totalReserved = useMemo(() => rows.reduce((sum, row) => sum + (row.reservedStock ?? 0), 0), [rows]);

  const load = useCallback(async () => {
    setLoading(true);
    const req: GrundnerListReq = {
      limit,
      filter: {
        search: filters.search || undefined,
        onlyAvailable: filters.onlyAvailable || undefined,
        onlyReserved: filters.onlyReserved || undefined
      }
    };
    const res = await window.api.grundner.list(req);
    if (!res.ok) {
      alert(`Failed to load Grundner inventory: ${res.error.message}`);
      setRows([]);
      setLoading(false);
      return;
    }
    setRows(res.value.items);
    lastLoadedAtRef.current = Date.now();
    setLoading(false);
  }, [filters, limit]);

  useEffect(() => { load(); }, [load]);

  const parseField = (value: string | undefined) => {
    if (!value || value.trim() === '') return null;
    const numeric = Number(value);
    if (Number.isNaN(numeric)) throw new Error('Please enter a valid number');
    return numeric;
  };

  const updateRow = useCallback(async (row: GrundnerRow) => {
    const edit = editing[row.id] ?? {};
    const payload: { stockAvailable?: number | null } = {};
    let dirty = false;

    if (Object.prototype.hasOwnProperty.call(edit, 'stockAvailable')) {
      payload.stockAvailable = parseField(edit.stockAvailable);
      dirty = true;
    }
    // reservedStock is read-only and sourced from CSV; no edits here

    if (!dirty) {
      alert('No changes to apply.');
      return;
    }

    const res = await window.api.grundner.update({ id: row.id, ...payload });
    if (!res.ok) {
      alert(`Failed to update row: ${res.error.message}`);
      return;
    }
    if (!res.value.ok) {
      alert('Failed to update row.');
      return;
    }
    setEditing((prev) => {
      const next = { ...prev };
      delete next[row.id];
      return next;
    });
    await load();
  }, [editing, load]);

  const resyncReserved = async (id?: number) => {
    const res = await window.api.grundner.resync(id ? { id } : undefined);
    if (!res.ok) {
      alert(`Resync failed: ${res.error.message}`);
      return;
    }
    await load();
  };

  const exportCsv = () => {
    try {
      const headers = [
        'Type',
        'Customer ID',
        'Length',
        'Width',
        'Thickness',
        'Pre-Reserved',
        'Stock',
        'Reserved',
        'Available',
        'Last Updated'
      ];
      const escape = (val: unknown) => {
        if (val == null) return '';
        const s = String(val);
        if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
      };
      const lines = rows.map((r) => [
        r.typeData ?? '',
        r.customerId ?? '',
        r.lengthMm ?? '',
        r.widthMm ?? '',
        r.thicknessMm ?? '',
        r.preReserved ?? '',
        r.stock ?? '',
        r.reservedStock ?? '',
        r.stockAvailable ?? '',
        r.lastUpdated ? formatTimestamp(r.lastUpdated) : ''
      ].map(escape).join(','));
      const csv = [headers.join(','), ...lines].join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const ts = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const fname = `grundner_export_${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.csv`;
      const link = document.createElement('a');
      link.href = url;
      link.download = fname;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export failed', err);
      alert('Failed to export CSV.');
    }
  };

  // Auto-refresh on Grundner watcher push events (throttled)
  useEffect(() => {
    const MIN_GAP_MS = 15_000; // throttle auto refresh

    const unsubscribe = window.api.diagnostics.subscribe((snapshot) => {
      try {
        const watcher = snapshot?.watchers?.find((w: any) => w?.label === 'Grundner Stock Poller');
        if (!watcher?.lastEventAt) return;
        const eventTs = Date.parse(watcher.lastEventAt);
        if (!Number.isFinite(eventTs)) return;
        // Only react to events after our last successful load
        if (eventTs <= lastLoadedAtRef.current) return;

        // Only refresh when we actually synced rows
        const msg: string = watcher.lastEvent ?? '';
        const m = msg.match(/Synced Grundner stock \(inserted\s+(\d+),\s*updated\s+(\d+)\)/i);
        if (!m) return;
        const inserted = Number(m[1] ?? 0) || 0;
        const updated = Number(m[2] ?? 0) || 0;
        if (inserted + updated <= 0) return;

        const now = Date.now();
        if (now - lastAutoRefreshAtRef.current < MIN_GAP_MS) return;

        // Avoid disrupting active edits or in-flight loads; defer if needed
        if (loading || Object.keys(editing).length > 0) {
          setPendingAutoRefresh(true);
          return;
        }
        lastAutoRefreshAtRef.current = now;
        void load();
      } catch {}
    });

    return () => {
      try { unsubscribe?.(); } catch {}
    };
  }, [editing, loading, load]);

  // When edits finish and a refresh is pending, run it (throttled)
  useEffect(() => {
    if (!pendingAutoRefresh) return;
    if (loading) return;
    if (Object.keys(editing).length > 0) return;
    const now = Date.now();
    const MIN_GAP_MS = 15_000;
    if (now - lastAutoRefreshAtRef.current < MIN_GAP_MS) return;
    setPendingAutoRefresh(false);
    lastAutoRefreshAtRef.current = now;
    void load();
  }, [pendingAutoRefresh, editing, loading, load]);
  const columns = useMemo<ColumnDef<GrundnerRow>[]>(() => [
    {
      id: 'typeData',
      accessorKey: 'typeData',
      header: 'Type',
      cell: (ctx) => ctx.getValue<number | null>() ?? '',
      size: 60,
      meta: { widthClass: 'w-[100px]' }
    },
    {
      id: 'customerId',
      accessorKey: 'customerId',
      header: 'Customer ID',
      cell: (ctx) => ctx.getValue<string | null>() ?? '',
      size: 260,
      meta: { widthClass: 'w-[220px]' }
    },
    {
      id: 'lengthMm',
      accessorKey: 'lengthMm',
      header: 'Length',
      cell: (ctx) => ctx.getValue<number | null>() ?? '',
      size: 60,
      meta: { widthClass: 'w-[60px]' }
    },
    {
      id: 'widthMm',
      accessorKey: 'widthMm',
      header: 'Width',
      cell: (ctx) => ctx.getValue<number | null>() ?? '',
      size: 110,
      meta: { widthClass: 'w-[110px]' }
    },
    {
      id: 'thicknessMm',
      accessorKey: 'thicknessMm',
      header: 'Thickness',
      cell: (ctx) => ctx.getValue<number | null>() ?? '',
      size: 110,
      meta: { widthClass: 'w-[110px]' }
    },
    {
      id: 'preReserved',
      accessorKey: 'preReserved',
      header: 'Pre-Reserved',
      size: 120,
      cell: (ctx) => ctx.getValue<number | null>() ?? '',
      meta: { widthClass: 'w-[120px]' }
    },
    {
      id: 'stock',
      accessorKey: 'stock',
      header: 'Stock',
      cell: (ctx) => ctx.getValue<number | null>() ?? '',
      size: 90,
      meta: { widthClass: 'w-[90px]' }
    },
    {
      id: 'reservedStock',
      accessorKey: 'reservedStock',
      header: 'Locked',
      size: 120,
      cell: (ctx) => ctx.getValue<number | null>() ?? '',
      meta: { widthClass: 'w-[120px]' }
    },
    {
      id: 'stockAvailable',
      accessorKey: 'stockAvailable',
      header: 'Available',
      size: 120,
      cell: (ctx) => ctx.getValue<number | null>() ?? '',
      meta: { widthClass: 'w-[120px]' }
    },
    {
      id: 'lastUpdated',
      accessorKey: 'lastUpdated',
      header: 'Last Updated',
      cell: (ctx) => {
        const v = ctx.getValue<string | null>();
        return v ? formatTimestamp(v) : '';
      },
      size: 180,
      meta: { widthClass: 'w-[180px]' }
    },
  ], [editing, updateRow]);

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    defaultColumn: { size: 120 }
  });

  return (
    <div className="space-y-4 w-full">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Grundner Inventory</h1>
          <p className="text-sm text-muted-foreground">Stock {totalStock} • Available {totalAvailable} • Locked {totalReserved}</p>
        </div>
        <div className="flex gap-2">
          <button className="border rounded px-3 py-1" onClick={exportCsv}>Export to CSV</button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <label className="flex flex-col gap-1 text-sm">
          <span>Search</span>
          <input className="border rounded px-2 py-1" value={filters.search} onChange={(e) => setFilters((prev) => ({ ...prev, search: e.target.value }))} placeholder="Type data or customer" />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={filters.onlyAvailable} onChange={(e) => setFilters((prev) => ({ ...prev, onlyAvailable: e.target.checked }))} />
          Only available
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={filters.onlyReserved} onChange={(e) => setFilters((prev) => ({ ...prev, onlyReserved: e.target.checked }))} />
          Only reserved
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>Limit</span>
          <select className="border rounded px-2 py-1" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {[100, 200, 300, 500].map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
      </div>

      <GlobalTable table={table} stickyHeader fillEmptyRows />
    </div>
  );
}



