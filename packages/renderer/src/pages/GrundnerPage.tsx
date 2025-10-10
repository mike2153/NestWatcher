import { useCallback, useEffect, useMemo, useState } from 'react';
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
  reservedStock?: string;
};

export function GrundnerPage() {
  const [rows, setRows] = useState<GrundnerRow[]>([]);
  const [filters, setFilters] = useState<Filters>({ search: '', onlyAvailable: false, onlyReserved: false });
  const [limit, setLimit] = useState(200);
  const [editing, setEditing] = useState<Record<number, EditState>>({});
  const [loading, setLoading] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'typeData', desc: false }]);

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
    const payload: { stockAvailable?: number | null; reservedStock?: number | null } = {};
    let dirty = false;

    if (Object.prototype.hasOwnProperty.call(edit, 'stockAvailable')) {
      payload.stockAvailable = parseField(edit.stockAvailable);
      dirty = true;
    }
    if (Object.prototype.hasOwnProperty.call(edit, 'reservedStock')) {
      payload.reservedStock = parseField(edit.reservedStock);
      dirty = true;
    }

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
  const columns = useMemo<ColumnDef<GrundnerRow>[]>(() => [
    {
      id: 'typeData',
      accessorKey: 'typeData',
      header: 'Type',
      cell: (ctx) => <span className="font-mono text-xs">{ctx.getValue<number | null>() ?? ''}</span>,
      size: 120
    },
    {
      id: 'customerId',
      accessorKey: 'customerId',
      header: 'Customer',
      cell: (ctx) => ctx.getValue<string | null>() ?? '',
      size: 200
    },
    {
      id: 'thicknessMm',
      accessorKey: 'thicknessMm',
      header: 'Thickness',
      cell: (ctx) => ctx.getValue<number | null>() ?? '',
      size: 110
    },
    {
      id: 'stock',
      accessorKey: 'stock',
      header: 'Stock',
      cell: (ctx) => ctx.getValue<number | null>() ?? '',
      size: 90
    },
    {
      id: 'stockAvailable',
      accessorKey: 'stockAvailable',
      header: 'Available',
      size: 120,
      cell: (ctx) => ctx.getValue<number | null>() ?? ''
    },
    {
      id: 'reservedStock',
      accessorKey: 'reservedStock',
      header: 'Reserved',
      size: 120,
      cell: (ctx) => {
        const row = ctx.row.original;
        const edit = editing[row.id] ?? {};
        const val = edit.reservedStock ?? (row.reservedStock != null ? String(row.reservedStock) : '');
        return (
          <input
            className="border rounded px-1 py-0.5 w-16 text-right text-xs h-7"
            type="number"
            value={val}
            onChange={(e) => setEditing((prev) => ({ ...prev, [row.id]: { ...prev[row.id], reservedStock: e.target.value } }))}
          />
        );
      }
    },
    {
      id: 'lastUpdated',
      accessorKey: 'lastUpdated',
      header: 'Last Updated',
      cell: (ctx) => {
        const v = ctx.getValue<string | null>();
        return v ? formatTimestamp(v) : '';
      },
      size: 180
    },
    {
      id: 'actions',
      header: 'Actions',
      size: 200,
      cell: (ctx) => {
        const row = ctx.row.original;
        return (
          <div className="flex gap-2">
            <button className="border rounded px-2 py-1 text-sm" onClick={() => { /* TODO: implement Reserve */ }}>
              Reserve
            </button>
            <button className="border rounded px-2 py-1 text-sm" onClick={() => { /* TODO: implement Lock */ }}>
              Lock
            </button>
            <button className="border rounded px-2 py-1 text-sm" onClick={() => updateRow(row)}>
              Apply
            </button>
          </div>
        );
      }
    }
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
          <p className="text-sm text-muted-foreground">stock {totalStock} • available {totalAvailable} • reserved {totalReserved}</p>
        </div>
        <div className="flex gap-2">
          <button className="border rounded px-3 py-1" onClick={() => resyncReserved()}>Resync All</button>
          <button className="border rounded px-3 py-1" onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
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



