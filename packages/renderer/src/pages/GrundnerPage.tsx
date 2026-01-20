import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getCoreRowModel,
  getSortedRowModel,
  useReactTable
} from '@tanstack/react-table';
import type { ColumnDef, SortingState } from '@tanstack/react-table';
import { GlobalTable } from '@/components/table/GlobalTable';
import { Button } from '@/components/ui/button';


// Percent widths for Grundner table columns
const GRUNDNER_COL_PCT = {
  typeData: 8,
  materialName: 16,
  materialNumber: 12,
  customerId: 16,
  lengthMm: 8,
  widthMm: 8,
  thicknessMm: 8,
  preReserved: 10,
  stock: 10,
  reservedStock: 10,
  stockAvailable: 10,
  lastUpdated: 12,
} as const;
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
  const [tableColumns, setTableColumns] = useState({
    typeData: { visible: true, order: 1 },
    materialName: { visible: false, order: 2 },
    materialNumber: { visible: false, order: 3 },
    customerId: { visible: true, order: 4 },
    lengthMm: { visible: true, order: 5 },
    widthMm: { visible: true, order: 6 },
    thicknessMm: { visible: true, order: 7 },
    preReserved: { visible: true, order: 8 },
    stock: { visible: true, order: 9 },
    reservedStock: { visible: true, order: 10 },
    stockAvailable: { visible: true, order: 11 },
    lastUpdated: { visible: true, order: 12 }
  });

  useEffect(() => {
    (async () => {
      const res = await window.api.settings.get();
      if (!res.ok) return;
      const next = res.value.grundner?.tableColumns;
      if (next) {
        setTableColumns((prev) => {
          const record = next && typeof next === 'object' && !Array.isArray(next) ? (next as Record<string, unknown>) : null;
          const out = { ...prev };
          for (const key of Object.keys(prev) as Array<keyof typeof prev>) {
            const value = record?.[key as string];
            if (typeof value === 'boolean') {
              out[key] = { ...out[key], visible: value };
              continue;
            }
            if (value && typeof value === 'object' && !Array.isArray(value)) {
              const col = value as Record<string, unknown>;
              const visible = typeof col.visible === 'boolean' ? col.visible : out[key].visible;
              const order = typeof col.order === 'number' && Number.isInteger(col.order) && col.order >= 1 ? col.order : out[key].order;
              out[key] = { visible, order };
            }
          }
          return out;
        });
      }
    })();
  }, []);

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

  const _updateRow = useCallback(async (row: GrundnerRow) => {
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

  // Resync action handler is currently unused; remove to satisfy linter

  const exportStandardCsv = useCallback(async () => {
    const res = await window.api.grundner.exportCsv();
    if (!res.ok) {
      alert(`Failed to export CSV: ${res.error.message}`);
      return;
    }
    if (!res.value.savedPath) {
      return;
    }
    alert(`Saved CSV to ${res.value.savedPath}`);
  }, []);

  const exportCustomCsv = useCallback(async () => {
    const res = await window.api.grundner.exportCustomCsv();
    if (!res.ok) {
      alert(`Failed to export custom CSV: ${res.error.message}`);
      return;
    }
    if (!res.value.savedPath) {
      return;
    }
    alert(`Saved custom CSV to ${res.value.savedPath}`);
  }, []);

  // Auto-refresh on backend notifications (throttled)
  useEffect(() => {
    const MIN_GAP_MS = 5_000;
    const unsubscribe = window.api.grundner.subscribeRefresh(() => {
      const now = Date.now();
      if (now - lastAutoRefreshAtRef.current < MIN_GAP_MS) {
        return;
      }
      if (loading || Object.keys(editing).length > 0) {
        setPendingAutoRefresh(true);
        return;
      }
      lastAutoRefreshAtRef.current = now;
      void load();
    });
    return unsubscribe;
  }, [editing, load, loading]);

  // When edits finish and a refresh is pending, run it (throttled)
  useEffect(() => {
    if (!pendingAutoRefresh) return;
    if (loading) return;
    if (Object.keys(editing).length > 0) return;
    const now = Date.now();
    const MIN_GAP_MS = 5_000;
    if (now - lastAutoRefreshAtRef.current < MIN_GAP_MS) return;
    setPendingAutoRefresh(false);
    lastAutoRefreshAtRef.current = now;
    void load();
  }, [pendingAutoRefresh, editing, loading, load]);
  // Percentage-based column widths; normalized automatically by GlobalTable

  const columns = useMemo<ColumnDef<GrundnerRow>[]>(() => {
    const all: ColumnDef<GrundnerRow>[] = [
      {
        id: 'typeData',
        accessorKey: 'typeData',
        header: 'Type',
        cell: (ctx) => ctx.getValue<number | null>() ?? '',
        meta: { widthPercent: GRUNDNER_COL_PCT.typeData, minWidthPx: 80 }
      },
      {
        id: 'materialName',
        accessorKey: 'materialName',
        header: 'Material Name',
        cell: (ctx) => ctx.getValue<string | null>() ?? '',
        meta: { widthPercent: GRUNDNER_COL_PCT.materialName, minWidthPx: 120 }
      },
      {
        id: 'materialNumber',
        accessorKey: 'materialNumber',
        header: 'Material #',
        cell: (ctx) => ctx.getValue<number | null>() ?? '',
        meta: { widthPercent: GRUNDNER_COL_PCT.materialNumber, minWidthPx:80 }
      },
      {
        id: 'customerId',
        accessorKey: 'customerId',
        header: 'Customer ID',
        cell: (ctx) => ctx.getValue<string | null>() ?? '',
        meta: { widthPercent: GRUNDNER_COL_PCT.customerId, minWidthPx: 160 }
      },
      {
        id: 'lengthMm',
        accessorKey: 'lengthMm',
        header: 'Length',
        cell: (ctx) => ctx.getValue<number | null>() ?? '',
        meta: { widthPercent: GRUNDNER_COL_PCT.lengthMm, minWidthPx: 60 }
      },
      {
        id: 'widthMm',
        accessorKey: 'widthMm',
        header: 'Width',
        cell: (ctx) => ctx.getValue<number | null>() ?? '',
        meta: { widthPercent: GRUNDNER_COL_PCT.widthMm, minWidthPx: 80 }
      },
      {
        id: 'thicknessMm',
        accessorKey: 'thicknessMm',
        header: 'Thickness',
        cell: (ctx) => ctx.getValue<number | null>() ?? '',
        meta: { widthPercent: GRUNDNER_COL_PCT.thicknessMm, minWidthPx: 80 }
      },
      {
        id: 'preReserved',
        accessorKey: 'preReserved',
        header: 'Pre-Reserved',
        cell: (ctx) => ctx.getValue<number | null>() ?? '',
        meta: { widthPercent: GRUNDNER_COL_PCT.preReserved, minWidthPx: 100 }
      },
      {
        id: 'stock',
        accessorKey: 'stock',
        header: 'Stock',
        cell: (ctx) => ctx.getValue<number | null>() ?? '',
        meta: { widthPercent: GRUNDNER_COL_PCT.stock, minWidthPx: 80 }
      },
      {
        id: 'reservedStock',
        accessorKey: 'reservedStock',
        header: 'Locked',
        cell: (ctx) => ctx.getValue<number | null>() ?? '',
        meta: { widthPercent: GRUNDNER_COL_PCT.reservedStock, minWidthPx: 100 }
      },
      {
        id: 'stockAvailable',
        accessorKey: 'stockAvailable',
        header: 'Available',
        cell: (ctx) => ctx.getValue<number | null>() ?? '',
        meta: { widthPercent: GRUNDNER_COL_PCT.stockAvailable, minWidthPx: 100 }
      },
      {
        id: 'lastUpdated',
        accessorKey: 'lastUpdated',
        header: 'Last Updated',
        cell: (ctx) => {
          const v = ctx.getValue<string | null>();
          return v ? formatTimestamp(v) : '';
        },
        meta: { widthPercent: GRUNDNER_COL_PCT.lastUpdated, minWidthPx: 140 }
      }
    ];

    const visible = all.filter((col) => {
      const id = String(col.id ?? '');
      if (id === 'typeData') return tableColumns.typeData.visible;
      if (id === 'materialName') return tableColumns.materialName.visible;
      if (id === 'materialNumber') return tableColumns.materialNumber.visible;
      if (id === 'customerId') return tableColumns.customerId.visible;
      if (id === 'lengthMm') return tableColumns.lengthMm.visible;
      if (id === 'widthMm') return tableColumns.widthMm.visible;
      if (id === 'thicknessMm') return tableColumns.thicknessMm.visible;
      if (id === 'preReserved') return tableColumns.preReserved.visible;
      if (id === 'stock') return tableColumns.stock.visible;
      if (id === 'reservedStock') return tableColumns.reservedStock.visible;
      if (id === 'stockAvailable') return tableColumns.stockAvailable.visible;
      if (id === 'lastUpdated') return tableColumns.lastUpdated.visible;
      return true;
    });

    const orderFor = (id: string): number => {
      if (id === 'typeData') return tableColumns.typeData.order;
      if (id === 'materialName') return tableColumns.materialName.order;
      if (id === 'materialNumber') return tableColumns.materialNumber.order;
      if (id === 'customerId') return tableColumns.customerId.order;
      if (id === 'lengthMm') return tableColumns.lengthMm.order;
      if (id === 'widthMm') return tableColumns.widthMm.order;
      if (id === 'thicknessMm') return tableColumns.thicknessMm.order;
      if (id === 'preReserved') return tableColumns.preReserved.order;
      if (id === 'stock') return tableColumns.stock.order;
      if (id === 'reservedStock') return tableColumns.reservedStock.order;
      if (id === 'stockAvailable') return tableColumns.stockAvailable.order;
      if (id === 'lastUpdated') return tableColumns.lastUpdated.order;
      return Number.MAX_SAFE_INTEGER;
    };

    return visible.sort((a, b) => orderFor(String(a.id ?? '')) - orderFor(String(b.id ?? '')));
  }, [tableColumns]);

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableColumnResizing: false
  });

  return (
    <div className="space-y-2 w-full">
      <div className="flex flex-wrap items-end justify-between gap-3 border rounded p-3 bg-[var(--card)]">
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
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={exportStandardCsv}>Export to CSV</Button>
            <Button size="sm" onClick={exportCustomCsv}>Export Custom CSV</Button>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">Stock {totalStock} • Available {totalAvailable} • Locked {totalReserved}</p>
        </div>
      </div>

      <GlobalTable table={table} stickyHeader fillEmptyRows maxHeight="calc(100vh - 160px)" />
    </div>
  );
}
