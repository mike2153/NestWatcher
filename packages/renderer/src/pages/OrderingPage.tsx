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
  typeData: 10,
  materialName: 20,
  customerId: 18,
  shortfall: 12,
  ordered: 18,
  comments: 22
} as const;

type CommentDrafts = Record<string, string>;

function formatOrderedAt(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return formatAuDateTime(date);
}

function rowKey(row: OrderingRow): string {
  if (row.id != null) return String(row.id);
  if (row.typeData != null) return String(row.typeData);
  return 'unknown';
}

export function OrderingPage() {
  const [rows, setRows] = useState<OrderingRow[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'shortfall', desc: true }]);
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
      setGeneratedAt(res.value.generatedAt);
      const drafts: CommentDrafts = {};
      for (const row of res.value.items) {
        drafts[rowKey(row)] = row.comments ?? '';
      }
      setCommentDrafts(drafts);
      setError(null);
    } else {
      setRows([]);
      setGeneratedAt(null);
      setError(res.error.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredRows = useMemo(() => {
    if (!search.trim()) return rows;
    const term = search.trim().toLowerCase();
    return rows.filter((row) => {
      const values = [
        row.typeData != null ? String(row.typeData) : '',
        row.materialName ?? '',
        row.customerId ?? ''
      ];
      return values.some((value) => value.toLowerCase().includes(term));
    });
  }, [rows, search]);

  const totalShortfall = useMemo(
    () => filteredRows.reduce((sum, row) => sum + row.shortfall, 0),
    [filteredRows]
  );

  const handleToggleOrdered = useCallback(async (row: OrderingRow) => {
    if (row.id == null) return;
    const key = rowKey(row);
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
    if (row.id == null) return;
    const trimmed = next.trim();
    const current = row.comments ?? '';
    if (trimmed === current.trim()) return;
    const key = rowKey(row);
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

  const columns = useMemo<ColumnDef<OrderingRow>[]>(() => [
    {
      id: 'typeData',
      header: 'Type',
      accessorFn: (row) => row.typeData ?? '',
      cell: ({ row }) => row.original.typeData ?? '',
      sortingFn: 'alphanumeric',
      meta: { widthPercent: ORDERING_COL_WIDTH.typeData, minWidthPx: 80 }
    },
    {
      id: 'materialName',
      header: 'Material Name',
      accessorFn: (row) => row.materialName ?? '',
      cell: ({ row }) => row.original.materialName ?? '',
      sortingFn: 'alphanumeric',
      meta: { widthPercent: ORDERING_COL_WIDTH.materialName, minWidthPx: 160 }
    },
    {
      id: 'customerId',
      header: 'Customer ID',
      accessorFn: (row) => row.customerId ?? '',
      cell: ({ row }) => row.original.customerId ?? '',
      sortingFn: 'alphanumeric',
      meta: { widthPercent: ORDERING_COL_WIDTH.customerId, minWidthPx: 140 }
    },
    {
      id: 'shortfall',
      header: 'Shortfall',
      accessorKey: 'shortfall',
      cell: ({ row }) => row.original.shortfall,
      sortingFn: 'basic',
      meta: { widthPercent: ORDERING_COL_WIDTH.shortfall, minWidthPx: 100 }
    },
    {
      id: 'ordered',
      header: 'Ordered',
      accessorFn: (row) => (row.ordered ? 1 : 0),
      cell: ({ row }) => {
        const item = row.original;
        const key = rowKey(item);
        const disabled = item.id == null || busyOrderedKey === key || busyCommentKey === key;
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
                {item.orderedBy}{orderedAt ? ` - ${orderedAt}` : ''}
                </span>
              ) : null}
          </div>
        );
      },
      sortingFn: 'basic',
      meta: { widthPercent: ORDERING_COL_WIDTH.ordered, minWidthPx: 160 }
    },
    {
      id: 'comments',
      header: 'Comments',
      cell: ({ row }) => {
        const item = row.original;
        const key = rowKey(item);
        const value = commentDraftsRef.current[key] ?? '';
        const disabled = item.id == null || busyCommentKey === key || busyOrderedKey === key;
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
      meta: { widthPercent: ORDERING_COL_WIDTH.comments, minWidthPx: 180 }
    }
  ], [busyCommentKey, busyOrderedKey, handleSaveComment, handleToggleOrdered]);

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
    if (!res.value.savedPath) return;
    alert(`Saved CSV to ${res.value.savedPath}`);
  }, []);

  const exportPdf = useCallback(async () => {
    const res = await window.api.ordering.exportPdf();
    if (!res.ok) {
      alert(`Failed to export PDF: ${res.error.message}`);
      return;
    }
    if (!res.value.savedPath) return;
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
              ? 'Loading...'
              : `${filteredRows.length} material${filteredRows.length === 1 ? '' : 's'} - total shortfall ${totalShortfall}`}
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
