import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getCoreRowModel,
  getSortedRowModel,
  useReactTable
} from '@tanstack/react-table';
import type { ColumnDef, SortingState } from '@tanstack/react-table';
import { GlobalTable } from '@/components/table/GlobalTable';
import { Button } from '@/components/ui/button';
import type { OrderingRow } from '../../../shared/src';
import { formatAuDate, formatAuDateTime } from '@/utils/datetime';

const ORDERING_COL_WIDTH = {
  typeData: 12,
  customerId: 16,
  material: 18,
  available: 10,
  required: 10,
  orderAmount: 12,
  reserved: 10,
  locked: 8,
  ordered: 14,
  jobs: 18,
  comments: 18
} as const;

type CommentDrafts = Record<string, string>;

function formatOrderedAt(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  // Keep it consistent with AU date formats.
  return formatAuDateTime(date);
}

export function OrderingPage() {
  const [rows, setRows] = useState<OrderingRow[]>([]);
  const [includeReserved, setIncludeReserved] = useState(false);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'orderAmount', desc: true }]);
  const [search, setSearch] = useState('');
  const [busyOrderedKey, setBusyOrderedKey] = useState<string | null>(null);
  const [busyCommentKey, setBusyCommentKey] = useState<string | null>(null);
  const [commentDrafts, setCommentDrafts] = useState<CommentDrafts>({});
  const commentDraftsRef = useRef<CommentDrafts>({});
  commentDraftsRef.current = commentDrafts;

  const load = useCallback(async () => {
    setLoading(true);
    const res = await window.api.ordering.list();
    if (res.ok) {
      setRows(res.value.items);
      setIncludeReserved(res.value.includeReserved);
      setGeneratedAt(res.value.generatedAt);
      const drafts: CommentDrafts = {};
      for (const row of res.value.items) {
        drafts[row.materialKey] = row.comments ?? '';
      }
      setCommentDrafts(drafts);
      setError(null);
    } else {
      setRows([]);
      setError(res.error.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filteredRows = useMemo(() => {
    if (!search.trim()) return rows;
    const term = search.trim().toLowerCase();
    return rows.filter((row) => {
      const values = [
        row.materialLabel,
        row.materialKey,
        row.customerId ?? '',
        row.typeData != null ? String(row.typeData) : ''
      ];
      return values.some((value) => value.toLowerCase().includes(term));
    });
  }, [rows, search]);

  const totalOrderAmount = useMemo(
    () => filteredRows.reduce((sum, row) => sum + row.orderAmount, 0),
    [filteredRows]
  );

  const handleToggleOrdered = useCallback(async (row: OrderingRow) => {
    if (!row.id) return;
    const key = row.materialKey;
    setBusyOrderedKey(key);
    try {
      const res = await window.api.ordering.update({ id: row.id, ordered: !row.ordered });
      if (!res.ok) {
        alert(`Failed to update ordered state: ${res.error.message}`);
        return;
      }
      await load();
    } finally {
      setBusyOrderedKey(null);
    }
  }, [load]);

  const handleSaveComment = useCallback(async (row: OrderingRow, next: string) => {
    if (!row.id) return;
    const trimmed = next.trim();
    const current = row.comments ?? '';
    if (trimmed === current.trim()) return;
    const key = row.materialKey;
    setBusyCommentKey(key);
    try {
      const res = await window.api.ordering.update({ id: row.id, comments: trimmed || null });
      if (!res.ok) {
        alert(`Failed to update comment: ${res.error.message}`);
        return;
      }
      await load();
    } finally {
      setBusyCommentKey(null);
    }
  }, [load]);

  const columns = useMemo<ColumnDef<OrderingRow>[]>(() => {
    const base: ColumnDef<OrderingRow>[] = [
      {
        id: 'typeData',
        header: 'Type Data',
        accessorFn: (row) => row.typeData ?? (row.materialKey === '__UNKNOWN__' ? 'Unknown' : ''),
        cell: ({ row }) => {
          const value = row.original.typeData;
          if (value != null) return value;
          return row.original.materialKey === '__UNKNOWN__' ? 'Unknown' : '';
        },
        sortingFn: 'alphanumeric',
        meta: { widthPercent: ORDERING_COL_WIDTH.typeData, minWidthPx: 100 }
      },
      {
        id: 'customerId',
        header: 'Customer ID',
        accessorFn: (row) => row.customerId ?? (row.materialKey === '__UNKNOWN__' ? 'Unknown' : ''),
        cell: ({ row }) => row.original.customerId ?? (row.original.materialKey === '__UNKNOWN__' ? 'Unknown' : ''),
        sortingFn: 'alphanumeric',
        meta: { widthPercent: ORDERING_COL_WIDTH.customerId, minWidthPx: 140 }
      },
      {
        id: 'material',
        header: 'Material',
        accessorFn: (row) => row.materialLabel,
        cell: ({ row }) => {
          const item = row.original;
          const raw = item.materialKey;
          const label = item.materialLabel;
          const hint = raw !== label ? `${label} (${raw})` : label;
          return (
            <span title={hint}>
              {label}
            </span>
          );
        },
        sortingFn: 'alphanumeric',
        meta: { widthPercent: ORDERING_COL_WIDTH.material, minWidthPx: 160 }
      },
      {
        id: 'effectiveAvailable',
        header: 'Available',
        accessorKey: 'effectiveAvailable',
        cell: ({ row }) => row.original.effectiveAvailable,
        sortingFn: 'basic',
        meta: { widthPercent: ORDERING_COL_WIDTH.available, minWidthPx: 90 }
      },
      {
        id: 'required',
        header: 'Required',
        accessorKey: 'required',
        cell: ({ row }) => row.original.required,
        sortingFn: 'basic',
        meta: { widthPercent: ORDERING_COL_WIDTH.required, minWidthPx: 90 }
      },
      {
        id: 'orderAmount',
        header: 'Order Amount',
        accessorKey: 'orderAmount',
        cell: ({ row }) => row.original.orderAmount,
        sortingFn: 'basic',
        meta: { widthPercent: ORDERING_COL_WIDTH.orderAmount, minWidthPx: 110 }
      },
      {
        id: 'locked',
        header: 'Locked',
        accessorKey: 'lockedCount',
        cell: ({ row }) => row.original.lockedCount,
        sortingFn: 'basic',
        meta: { widthPercent: ORDERING_COL_WIDTH.locked, minWidthPx: 70 }
      },
      {
        id: 'ordered',
        header: 'Ordered',
        accessorFn: (row) => (row.ordered ? 1 : 0),
        cell: ({ row }) => {
          const item = row.original;
          const key = item.materialKey;
          const disabled = !item.id || busyOrderedKey === key || busyCommentKey === key;
          const orderedAt = item.orderedAt ? formatOrderedAt(item.orderedAt) : null;
          return (
            <div className="flex flex-col gap-1 text-sm">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={item.ordered}
                  onChange={() => handleToggleOrdered(item)}
                  disabled={disabled}
                />
                <span>{item.ordered ? 'Ordered' : 'Mark ordered'}</span>
              </label>
              {item.orderedBy ? (
                <span className="text-xs text-muted-foreground">
                  {item.orderedBy}{orderedAt ? ` • ${orderedAt}` : ''}
                </span>
              ) : null}
            </div>
          );
        },
        sortingFn: 'basic',
        meta: { widthPercent: ORDERING_COL_WIDTH.ordered, minWidthPx: 160 }
      },
      {
        id: 'jobs',
        header: 'Jobs',
        accessorFn: (row) => row.pendingJobs?.length ?? 0,
        cell: ({ row }) => {
          const jobs = row.original.pendingJobs ?? [];
          if (!jobs.length) return '';
          const label = jobs.length === 1 ? 'job' : 'jobs';
          const preview = jobs.slice(0, 5).map((j) => j.folder || j.key).join(' | ');
          const more = jobs.length > 5 ? ` (+${jobs.length - 5})` : '';
          return (
            <span title={preview}>
              {jobs.length} {label}{more}
            </span>
          );
        },
        sortingFn: 'basic',
        meta: { widthPercent: ORDERING_COL_WIDTH.jobs, minWidthPx: 140 }
      },
      {
        id: 'comments',
        header: 'Comments',
        cell: ({ row }) => {
          const item = row.original;
          const key = item.materialKey;
          const value = commentDraftsRef.current[key] ?? '';
          const disabled = !item.id || busyCommentKey === key || busyOrderedKey === key;
          return (
            <input
              className="w-full rounded border px-2 py-1 text-sm"
              value={value}
              maxLength={20}
              disabled={disabled}
              placeholder="Add note"
              onChange={(e) => {
                const next = e.target.value;
                setCommentDrafts((prev) => ({ ...prev, [key]: next }));
              }}
              onBlur={(e) => {
                const next = e.target.value.trim();
                void handleSaveComment(item, next);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.stopPropagation();
                  e.currentTarget.blur();
                }
              }}
            />
          );
        },
        meta: { widthPercent: ORDERING_COL_WIDTH.comments, minWidthPx: 160 }
      }
    ];

    if (includeReserved) {
      // Insert after "Order Amount" column.
      base.splice(6, 0, {
        id: 'reserved',
        header: 'Reserved',
        accessorKey: 'reservedStock',
        cell: ({ row }) => row.original.reservedStock ?? '',
        sortingFn: 'basic',
        meta: { widthPercent: ORDERING_COL_WIDTH.reserved, minWidthPx: 90 }
      });
    }

    return base;
  }, [includeReserved, busyCommentKey, busyOrderedKey, handleSaveComment, handleToggleOrdered]);

  const table = useReactTable({
    data: filteredRows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableColumnResizing: false
  });

  const exportCsv = useCallback(async () => {
    const res = await window.api.ordering.exportCsv();
    if (!res.ok) {
      alert(`Failed to export CSV: ${res.error.message}`);
      return;
    }
    if (!res.value.savedPath) {
      return;
    }
    alert(`Saved CSV to ${res.value.savedPath}`);
  }, []);

  const exportPdf = useCallback(async () => {
    const res = await window.api.ordering.exportPdf();
    if (!res.ok) {
      alert(`Failed to export PDF: ${res.error.message}`);
      return;
    }
    if (!res.value.savedPath) {
      return;
    }
    alert(`Saved PDF to ${res.value.savedPath}`);
  }, []);

  return (
    <div className="space-y-4 w-full">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium">Search</span>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search type, customer, material"
              className="min-w-[14rem] rounded border px-2 py-1"
            />
          </label>
          <div className="text-sm text-muted-foreground">
            {loading
              ? 'Loading…'
              : `${filteredRows.length} material${filteredRows.length === 1 ? '' : 's'} • total order ${totalOrderAmount}`}
            {includeReserved ? ' • Reserved stock deducted' : ''}
          </div>
          {generatedAt ? (
            <div className="text-xs text-muted-foreground">
              Updated {formatAuDate(new Date(generatedAt))}
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={exportCsv}>
            Export CSV
          </Button>
          <Button variant="outline" size="sm" onClick={exportPdf}>
            Export PDF
          </Button>
          <Button variant="default" size="sm" onClick={() => { void load(); }} disabled={loading}>
            Refresh
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      <GlobalTable
        table={table}
        stickyHeader
        fillEmptyRows
        maxHeight="calc(100vh - 200px)"
      />
      {!loading && filteredRows.length === 0 ? (
        <div className="rounded border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No shortages requiring ordering
        </div>
      ) : null}
    </div>
  );
}
