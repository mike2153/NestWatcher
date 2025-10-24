import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getCoreRowModel,
  getSortedRowModel,
  useReactTable
} from '@tanstack/react-table';
import type { ColumnDef, SortingState } from '@tanstack/react-table';
import { GlobalTable } from '@/components/table/GlobalTable';
import type { AllocatedMaterialRow } from '../../../shared/src';

const numberFormatter = new Intl.NumberFormat();

function formatNumber(value: number | null | undefined) {
  if (value == null) return '—';
  return numberFormatter.format(value);
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function formatDimensions(row: AllocatedMaterialRow) {
  const parts = [
    row.lengthMm != null ? numberFormatter.format(row.lengthMm) : null,
    row.widthMm != null ? numberFormatter.format(row.widthMm) : null,
    row.thicknessMm != null ? numberFormatter.format(row.thicknessMm) : null
  ].filter((part): part is string => part != null);
  return parts.length ? parts.join(' × ') : '—';
}

export function AllocatedMaterialPage() {
  const [rows, setRows] = useState<AllocatedMaterialRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'status', desc: true }]);
  const lastRefreshRef = useRef(0);

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

  const columns = useMemo<ColumnDef<AllocatedMaterialRow>[]>(() => [
    {
      id: 'typeData',
      header: 'Type',
      accessorKey: 'typeData',
      cell: (info) => info.getValue<number | null>() ?? '—',
      sortingFn: 'basic'
    },
    {
      id: 'customerId',
      header: 'Customer ID',
      accessorKey: 'customerId',
      cell: (info) => info.getValue<string | null>() ?? '—',
      sortingFn: 'alphanumeric'
    },
    {
      id: 'dimensions',
      header: 'Dimensions (L×W×T)',
      accessorFn: (row) => formatDimensions(row),
      cell: (info) => info.getValue<string>(),
      sortingFn: 'alphanumeric'
    },
    {
      id: 'status',
      header: 'Status',
      accessorFn: (row) => (row.jobLocked ? 2 : 1),
      cell: ({ row }) => (row.original.jobLocked ? 'Locked' : 'Pre-Reserved'),
      sortingFn: 'basic'
    },
    {
      id: 'jobKey',
      header: 'Job Key',
      accessorKey: 'jobKey',
      cell: (info) => info.getValue<string>(),
      sortingFn: 'alphanumeric'
    },
    {
      id: 'ncfile',
      header: 'NC File',
      accessorKey: 'ncfile',
      cell: (info) => info.getValue<string | null>() ?? '—',
      sortingFn: 'alphanumeric'
    },
    {
      id: 'material',
      header: 'Material Key',
      accessorKey: 'material',
      cell: (info) => info.getValue<string | null>() ?? '—',
      sortingFn: 'alphanumeric'
    },
    {
      id: 'preReserved',
      header: 'Pre-Reserved',
      accessorKey: 'preReserved',
      cell: (info) => formatNumber(info.getValue<number | null>()),
      sortingFn: 'basic'
    },
    {
      id: 'reservedStock',
      header: 'Reserved',
      accessorKey: 'reservedStock',
      cell: (info) => formatNumber(info.getValue<number | null>()),
      sortingFn: 'basic'
    },
    {
      id: 'stockAvailable',
      header: 'Available',
      accessorKey: 'stockAvailable',
      cell: (info) => formatNumber(info.getValue<number | null>()),
      sortingFn: 'basic'
    },
    {
      id: 'stock',
      header: 'Stock',
      accessorKey: 'stock',
      cell: (info) => formatNumber(info.getValue<number | null>()),
      sortingFn: 'basic'
    },
    {
      id: 'updatedAt',
      header: 'Last Updated',
      accessorKey: 'updatedAt',
      cell: (info) => formatTimestamp(info.getValue<string | null>()),
      sortingFn: 'datetime'
    }
  ], []);

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel()
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Allocated Material</h1>
          <p className="text-muted-foreground">
            Materials currently reserved or locked by jobs, with live Grundner stock data.
          </p>
        </div>
        <button
          type="button"
          className="border rounded px-3 py-1 text-sm"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-[var(--table-border)] bg-table px-6 py-10 text-center text-muted-foreground">
          {loading ? 'Loading allocated material…' : 'No allocated material found.'}
        </div>
      ) : (
        <GlobalTable
          table={table}
          className="bg-table"
        />
      )}
    </div>
  );
}
