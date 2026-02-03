import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getCoreRowModel,
  getExpandedRowModel,
  getSortedRowModel,
  useReactTable
} from '@tanstack/react-table';
import type { ColumnDef, SortingState, ExpandedState } from '@tanstack/react-table';
import { GlobalTable } from '@/components/table/GlobalTable';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';


// Percent widths for Grundner table columns
const GRUNDNER_COL_PCT = {
  typeData: 8,
  materialName: 16,
  materialNumber: 12,
  customerId: 16,
  lengthMm: 8,
  widthMm: 8,
  thicknessMm: 8,
  stock: 10,
  reservedStock: 10,
  stockAvailable: 10,
  lastUpdated: 12,
} as const;
import type { GrundnerJobRow, GrundnerListReq, GrundnerRow } from '../../../shared/src';
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

type MaterialRow = {
  _type: 'material';
  row: GrundnerRow;
  typeData: number;
  subRows: Array<FolderRow | InfoRow>;
};

type FolderRow = {
  _type: 'folder';
  typeData: number;
  folder: string;
  subRows: JobRow[];
};

type JobRow = {
  _type: 'job';
  typeData: number;
  key: string;
  folder: string | null;
  ncfile: string | null;
  reserved: boolean;
};

type InfoRow = {
  _type: 'info';
  typeData: number;
  message: string;
};

type TableRow = MaterialRow | FolderRow | JobRow | InfoRow;

function isMaterialRow(row: TableRow): row is MaterialRow {
  return row._type === 'material';
}

function isFolderRow(row: TableRow): row is FolderRow {
  return row._type === 'folder';
}

function isJobRow(row: TableRow): row is JobRow {
  return row._type === 'job';
}

function isInfoRow(row: TableRow): row is InfoRow {
  return row._type === 'info';
}

export function GrundnerPage() {
  const [rows, setRows] = useState<GrundnerRow[]>([]);
  const [filters, setFilters] = useState<Filters>({ search: '', onlyAvailable: false, onlyReserved: false });
  const [limit, setLimit] = useState(200);
  const [editing, setEditing] = useState<Record<number, EditState>>({});
  const [loading, setLoading] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'typeData', desc: false }]);
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const [jobsByType, setJobsByType] = useState<Record<number, { items: GrundnerJobRow[]; total: number }>>({});
  const [loadingTypes, setLoadingTypes] = useState<Set<number>>(new Set());
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
    stock: { visible: true, order: 8 },
    reservedStock: { visible: true, order: 9 },
    stockAvailable: { visible: true, order: 10 },
    lastUpdated: { visible: true, order: 11 }
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

  const displayRows = useMemo<GrundnerRow[]>(() => {
    const keyFor = (row: GrundnerRow): string => `${row.typeData ?? 'null'}`;

    const groups = new Map<
      string,
      {
        row: GrundnerRow;
        ids: number[];
        materialNameSet: Set<string>;
        materialNumberSet: Set<number>;
        lengthSet: Set<number>;
        widthSet: Set<number>;
        thicknessSet: Set<number>;
        lastUpdatedMax: string | null;
      }
    >();

    const addNullableNumber = (set: Set<number>, value: number | null) => {
      if (typeof value === 'number' && Number.isFinite(value)) set.add(value);
    };

    for (const r of rows) {
      const key = keyFor(r);
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, {
          row: {
            ...r,
            customerId: (r.customerId ?? '').trim() || null,
            stock: r.stock ?? 0,
            stockAvailable: r.stockAvailable ?? 0,
            reservedStock: r.reservedStock ?? 0
          },
          ids: [r.id],
          materialNameSet: new Set(r.materialName ? [r.materialName] : []),
          materialNumberSet: new Set(typeof r.materialNumber === 'number' ? [r.materialNumber] : []),
          lengthSet: new Set(typeof r.lengthMm === 'number' ? [r.lengthMm] : []),
          widthSet: new Set(typeof r.widthMm === 'number' ? [r.widthMm] : []),
          thicknessSet: new Set(typeof r.thicknessMm === 'number' ? [r.thicknessMm] : []),
          lastUpdatedMax: r.lastUpdated
        });
        continue;
      }

      existing.ids.push(r.id);
      existing.row.stock = (existing.row.stock ?? 0) + (r.stock ?? 0);
      existing.row.stockAvailable = (existing.row.stockAvailable ?? 0) + (r.stockAvailable ?? 0);
      existing.row.reservedStock = (existing.row.reservedStock ?? 0) + (r.reservedStock ?? 0);

      if (r.materialName) existing.materialNameSet.add(r.materialName);
      addNullableNumber(existing.materialNumberSet, r.materialNumber);
      addNullableNumber(existing.lengthSet, r.lengthMm);
      addNullableNumber(existing.widthSet, r.widthMm);
      addNullableNumber(existing.thicknessSet, r.thicknessMm);

      if (!existing.lastUpdatedMax) {
        existing.lastUpdatedMax = r.lastUpdated;
      } else if (r.lastUpdated) {
        existing.lastUpdatedMax = r.lastUpdated > existing.lastUpdatedMax ? r.lastUpdated : existing.lastUpdatedMax;
      }
    }

    const pickSingle = <T,>(set: Set<T>): T | null => (set.size === 1 ? [...set][0] : null);

    const result: GrundnerRow[] = [];
    for (const { row, ids, materialNameSet, materialNumberSet, lengthSet, widthSet, thicknessSet, lastUpdatedMax } of groups.values()) {
      result.push({
        ...row,
        id: Math.min(...ids),
        materialName: materialNameSet.size <= 1 ? (pickSingle(materialNameSet) as string | null) : 'Mixed',
        materialNumber: pickSingle(materialNumberSet),
        lengthMm: pickSingle(lengthSet),
        widthMm: pickSingle(widthSet),
        thicknessMm: pickSingle(thicknessSet),
        lastUpdated: lastUpdatedMax
      });
    }
    return result;
  }, [rows]);

  const tableData = useMemo<TableRow[]>(() => {
    const out: TableRow[] = [];

    for (const r of displayRows) {
      const typeData = r.typeData;
      if (typeData == null) {
        continue;
      }

      const cached = jobsByType[typeData];
      const isLoading = loadingTypes.has(typeData);
      const isExpanded = Boolean((expanded as Record<string, boolean>)[`m:${typeData}`]);

      const subRows: Array<FolderRow | InfoRow> = [];
      if (isExpanded) {
        if (isLoading && !cached) {
          subRows.push({ _type: 'info', typeData, message: 'Loading jobs...' });
        } else {
          const items = cached?.items ?? [];
          const total = cached?.total ?? 0;
          if (total > 200) {
            subRows.push({ _type: 'info', typeData, message: `Showing first 200 of ${total} jobs` });
          }
          if (!items.length) {
            subRows.push({ _type: 'info', typeData, message: 'No pending jobs for this type.' });
          } else {
            const byFolder = new Map<string, GrundnerJobRow[]>();
            for (const job of items) {
              const folder = (job.folder ?? '').trim() || '(no folder)';
              const list = byFolder.get(folder);
              if (list) list.push(job);
              else byFolder.set(folder, [job]);
            }

            const folderNames = Array.from(byFolder.keys()).sort((a, b) => a.localeCompare(b));
            for (const folder of folderNames) {
              const jobs = byFolder.get(folder) ?? [];
              subRows.push({
                _type: 'folder',
                typeData,
                folder,
                subRows: jobs.map((j) => ({
                  _type: 'job',
                  typeData,
                  key: j.key,
                  folder: j.folder,
                  ncfile: j.ncfile,
                  reserved: j.reserved
                }))
              });
            }
          }
        }
      }

      out.push({
        _type: 'material',
        row: r,
        typeData,
        subRows
      });
    }

    return out;
  }, [displayRows, expanded, jobsByType, loadingTypes]);

  const totalStock = useMemo(() => displayRows.reduce((sum, row) => sum + (row.stock ?? 0), 0), [displayRows]);
  const totalAvailable = useMemo(() => displayRows.reduce((sum, row) => sum + (row.stockAvailable ?? 0), 0), [displayRows]);
  const totalReserved = useMemo(() => displayRows.reduce((sum, row) => sum + (row.reservedStock ?? 0), 0), [displayRows]);

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

  const loadPendingJobsForType = useCallback(async (typeData: number) => {
    if (!Number.isFinite(typeData)) return;
    if (loadingTypes.has(typeData)) return;
    setLoadingTypes((prev) => new Set(prev).add(typeData));
    try {
      const res = await window.api.grundner.jobs({ typeData, limit: 200 });
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.error('Failed to load pending jobs for type', typeData, res.error.message);
        setJobsByType((prev) => ({ ...prev, [typeData]: { items: [], total: 0 } }));
        return;
      }
      setJobsByType((prev) => ({ ...prev, [typeData]: { items: res.value.items, total: res.value.total } }));
    } finally {
      setLoadingTypes((prev) => {
        const next = new Set(prev);
        next.delete(typeData);
        return next;
      });
    }
  }, [loadingTypes]);

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

  const columns = useMemo<ColumnDef<TableRow>[]>(() => {
    const all: ColumnDef<TableRow>[] = [
      {
        id: 'typeData',
        header: 'Type Data',
        accessorFn: (row) => (isMaterialRow(row) ? row.typeData : ''),
        cell: ({ row }) => {
          const original = row.original;
          const depth = row.depth;
          const indent = depth * 24;

          if (isMaterialRow(original)) {
            return (
              <div style={{ paddingLeft: `${indent}px` }} className="flex items-center gap-2">
                <span className="font-semibold">{original.typeData}</span>
              </div>
            );
          }

          if (isFolderRow(original)) {
            return (
              <div style={{ paddingLeft: `${indent}px` }} className="flex items-center gap-2">
                <span className="font-medium">{original.folder}</span>
              </div>
            );
          }

          if (isJobRow(original)) {
            return (
              <div style={{ paddingLeft: `${indent}px` }} className="flex items-center">
                <span className="ml-6">{original.ncfile ?? original.key}</span>
              </div>
            );
          }

          if (isInfoRow(original)) {
            return (
              <div style={{ paddingLeft: `${indent}px` }} className="text-muted-foreground italic">
                {original.message}
              </div>
            );
          }

          return '';
        },
        meta: { widthPercent: GRUNDNER_COL_PCT.typeData, minWidthPx: 220 }
      },
      {
        id: 'materialName',
        header: 'Material Name',
        accessorFn: (row) => (isMaterialRow(row) ? row.row.materialName : ''),
        cell: ({ row }) => (isMaterialRow(row.original) ? row.original.row.materialName ?? '' : ''),
        meta: { widthPercent: GRUNDNER_COL_PCT.materialName, minWidthPx: 120 }
      },
      {
        id: 'materialNumber',
        header: 'Material #',
        accessorFn: (row) => (isMaterialRow(row) ? row.row.materialNumber : null),
        cell: ({ row }) => (isMaterialRow(row.original) ? row.original.row.materialNumber ?? '' : ''),
        meta: { widthPercent: GRUNDNER_COL_PCT.materialNumber, minWidthPx: 80 }
      },
      {
        id: 'customerId',
        header: 'Customer ID',
        accessorFn: (row) => (isMaterialRow(row) ? row.row.customerId : ''),
        cell: ({ row }) => (isMaterialRow(row.original) ? row.original.row.customerId ?? '' : ''),
        meta: { widthPercent: GRUNDNER_COL_PCT.customerId, minWidthPx: 160 }
      },
      {
        id: 'lengthMm',
        header: 'Length',
        accessorFn: (row) => (isMaterialRow(row) ? row.row.lengthMm : null),
        cell: ({ row }) => (isMaterialRow(row.original) ? row.original.row.lengthMm ?? '' : ''),
        meta: { widthPercent: GRUNDNER_COL_PCT.lengthMm, minWidthPx: 60 }
      },
      {
        id: 'widthMm',
        header: 'Width',
        accessorFn: (row) => (isMaterialRow(row) ? row.row.widthMm : null),
        cell: ({ row }) => (isMaterialRow(row.original) ? row.original.row.widthMm ?? '' : ''),
        meta: { widthPercent: GRUNDNER_COL_PCT.widthMm, minWidthPx: 80 }
      },
      {
        id: 'thicknessMm',
        header: 'Thickness',
        accessorFn: (row) => (isMaterialRow(row) ? row.row.thicknessMm : null),
        cell: ({ row }) => (isMaterialRow(row.original) ? row.original.row.thicknessMm ?? '' : ''),
        meta: { widthPercent: GRUNDNER_COL_PCT.thicknessMm, minWidthPx: 80 }
      },
      {
        id: 'stock',
        header: 'Stock',
        accessorFn: (row) => (isMaterialRow(row) ? row.row.stock : null),
        cell: ({ row }) => (isMaterialRow(row.original) ? row.original.row.stock ?? '' : ''),
        meta: { widthPercent: GRUNDNER_COL_PCT.stock, minWidthPx: 80 }
      },
      {
        id: 'reservedStock',
        header: 'Reserved Stock',
        accessorFn: (row) => (isMaterialRow(row) ? row.row.reservedStock : null),
        cell: ({ row }) => (isMaterialRow(row.original) ? row.original.row.reservedStock ?? '' : ''),
        meta: { widthPercent: GRUNDNER_COL_PCT.reservedStock, minWidthPx: 100 }
      },
      {
        id: 'stockAvailable',
        header: 'Available',
        accessorFn: (row) => (isMaterialRow(row) ? row.row.stockAvailable : null),
        cell: ({ row }) => (isMaterialRow(row.original) ? row.original.row.stockAvailable ?? '' : ''),
        meta: { widthPercent: GRUNDNER_COL_PCT.stockAvailable, minWidthPx: 100 }
      },
      {
        id: 'lastUpdated',
        header: 'Last Updated',
        accessorFn: (row) => (isMaterialRow(row) ? row.row.lastUpdated : null),
        cell: ({ row }) => {
          if (!isMaterialRow(row.original)) return '';
          const v = row.original.row.lastUpdated;
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
      if (id === 'stock') return tableColumns.stock.order;
      if (id === 'reservedStock') return tableColumns.reservedStock.order;
      if (id === 'stockAvailable') return tableColumns.stockAvailable.order;
      if (id === 'lastUpdated') return tableColumns.lastUpdated.order;
      return Number.MAX_SAFE_INTEGER;
    };

    return visible.sort((a, b) => orderFor(String(a.id ?? '')) - orderFor(String(b.id ?? '')));
  }, [tableColumns]);

  const table = useReactTable({
    data: tableData,
    columns,
    state: { sorting, expanded },
    onSortingChange: setSorting,
    onExpandedChange: setExpanded,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getSubRows: (row) => {
      if (isMaterialRow(row)) return row.subRows;
      if (isFolderRow(row)) return row.subRows;
      return undefined;
    },
    getRowCanExpand: (row) => {
      return row.original._type === 'material' || row.original._type === 'folder';
    },
    getRowId: (row, _index, parent) => {
      if (row._type === 'material') return `m:${row.typeData}`;
      if (row._type === 'folder') return `f:${row.typeData}:${row.folder}`;
      if (row._type === 'job') return `j:${row.key}`;
      if (row._type === 'info') return `i:${row.typeData}:${parent?.id ?? 'root'}:${row.message}`;
      return `${_index}`;
    },
    enableColumnResizing: false,
    enableRowSelection: false
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
          <div className="flex flex-col gap-1 text-sm">
            <span>Limit</span>
            <Select value={String(limit)} onValueChange={(v) => setLimit(Number(v))}>
              <SelectTrigger className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[100, 200, 300, 500].map((value) => (
                  <SelectItem key={value} value={String(value)}>{value}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={exportStandardCsv}>Export to CSV</Button>
            <Button size="sm" onClick={exportCustomCsv}>Export Custom CSV</Button>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">Stock {totalStock} • Available {totalAvailable} • Reserved Stock {totalReserved}</p>
        </div>
      </div>

      <GlobalTable
        table={table}
        stickyHeader
        fillEmptyRows
        maxHeight="calc(100vh - 160px)"
        toggleRowSelectionOnClick={false}
        onRowClick={(row) => {
          const original = row.original;
          if (original._type !== 'material') {
            if (row.getCanExpand()) {
              row.toggleExpanded();
            }
            return;
          }

          const typeData = original.typeData;
          if (typeData == null) return;

          const wasExpanded = row.getIsExpanded();
          row.toggleExpanded();
          const willExpand = !wasExpanded;
          if (willExpand && jobsByType[typeData] == null) {
            void loadPendingJobsForType(typeData);
          }
        }}
        getRowClassName={(row) => {
          const original = row.original;
          if (original._type !== 'job') return undefined;
          return original.reserved ? 'bg-emerald-50' : 'bg-red-50';
        }}
      />
    </div>
  );
}
