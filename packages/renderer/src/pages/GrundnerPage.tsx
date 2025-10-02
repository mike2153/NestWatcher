import { useCallback, useEffect, useMemo, useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { GrundnerListReq, GrundnerRow } from '../../../shared/src';

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

  const updateRow = async (row: GrundnerRow) => {
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
  };

  const resyncReserved = async (id?: number) => {
    const res = await window.api.grundner.resync(id ? { id } : undefined);
    if (!res.ok) {
      alert(`Resync failed: ${res.error.message}`);
      return;
    }
    await load();
  };

  return (
    <div className="space-y-4 w-full">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Grundner Inventory</h1>
          <p className="text-sm text-muted-foreground">
            {rows.length} rows - stock {totalStock} - available {totalAvailable} - reserved {totalReserved}
          </p>
        </div>
        <div className="flex gap-2">
          <button className="border rounded px-3 py-1" onClick={() => resyncReserved()}>Resync All</button>
          <button className="border rounded px-3 py-1" onClick={load} disabled={loading}>{loading ? 'Loading???' : 'Refresh'}</button>
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

      <div className="border rounded overflow-auto bg-table text-[var(--table-text)]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-2 py-2">Type</TableHead>
              <TableHead className="px-2 py-2">Customer</TableHead>
              <TableHead className="px-2 py-2">Thickness</TableHead>
              <TableHead className="px-2 py-2">Stock</TableHead>
              <TableHead className="px-2 py-2">Available</TableHead>
              <TableHead className="px-2 py-2">Reserved</TableHead>
              <TableHead className="px-2 py-2">Last Updated</TableHead>
              <TableHead className="px-2 py-2">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const edit = editing[row.id] ?? {};
              const stockAvailableValue = edit.stockAvailable ?? (row.stockAvailable != null ? String(row.stockAvailable) : '');
              const reservedValue = edit.reservedStock ?? (row.reservedStock != null ? String(row.reservedStock) : '');
              return (
                <TableRow key={row.id}>
                  <TableCell className="px-2 py-1 font-mono text-xs">{row.typeData ?? ''}</TableCell>
                  <TableCell className="px-2 py-1">{row.customerId ?? ''}</TableCell>
                  <TableCell className="px-2 py-1">{row.thicknessMm ?? ''}</TableCell>
                  <TableCell className="px-2 py-1">{row.stock ?? ''}</TableCell>
                  <TableCell className="px-2 py-1">
                    <input
                      className="border rounded px-2 py-1 w-24 text-right"
                      type="number"
                      value={stockAvailableValue}
                      onChange={(e) => setEditing((prev) => ({ ...prev, [row.id]: { ...prev[row.id], stockAvailable: e.target.value } }))}
                    />
                  </TableCell>
                  <TableCell className="px-2 py-1">
                    <input
                      className="border rounded px-2 py-1 w-24 text-right"
                      type="number"
                      value={reservedValue}
                      onChange={(e) => setEditing((prev) => ({ ...prev, [row.id]: { ...prev[row.id], reservedStock: e.target.value } }))}
                    />
                  </TableCell>
                  <TableCell className="px-2 py-1 text-xs text-muted-foreground">{row.lastUpdated ?? ''}</TableCell>
                  <TableCell className="px-2 py-1">
                    <div className="flex gap-2">
                      <button className="border rounded px-2 py-1 text-sm" onClick={() => updateRow(row)}>Save</button>
                      <button className="border rounded px-2 py-1 text-sm" onClick={() => resyncReserved(row.id)}>Resync</button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {!rows.length && (
              <TableRow>
                <TableCell colSpan={8} className="px-2 py-6 text-center text-sm text-muted-foreground">No Grundner rows found.</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
