import { useEffect, useMemo, useState } from 'react';
import type { AlarmsHistoryRes, Machine } from '../../../shared/src';
import { createColumnHelper, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { GlobalTable } from '@/components/table/GlobalTable';

type Filters = {
  from: string;
  to: string;
  machineIds: number[] | 'all';
};

function toIsoDateTimeBoundary(dateStr: string, endOfDay: boolean): string | undefined {
  if (!dateStr) return undefined;
  return endOfDay ? `${dateStr}T23:59:59.999Z` : `${dateStr}T00:00:00.000Z`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const DD = d.getDate();
  const MMM = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()] ?? '';
  const YY = String(d.getFullYear()).slice(-2);
  return `${DD} ${MMM} ${YY}`;
}

function formatTimeLong(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const DD = String(d.getDate()).padStart(2, '0');
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const YYYY = d.getFullYear();
  return `${hh}:${mm}:${ss} ${DD}/${MM}/${YYYY}`;
}

function defaultDateRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setMonth(from.getMonth() - 1);
  const toStr = `${to.getFullYear()}-${String(to.getMonth() + 1).padStart(2, '0')}-${String(to.getDate()).padStart(2, '0')}`;
  const fromStr = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}`;
  return { from: fromStr, to: toStr };
}

export function CncAlarmsPage() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [filters, setFilters] = useState<Filters>({ ...defaultDateRange(), machineIds: 'all' });
  const [search, setSearch] = useState('');
  const [data, setData] = useState<AlarmsHistoryRes | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { from: filterFrom, to: filterTo, machineIds } = filters;

  useEffect(() => {
    (async () => {
      const res = await window.api.machines.list();
      if (res.ok) setMachines(res.value.items);
    })();
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const req: { from?: string; to?: string; machineIds?: number[] } = {};
        if (filterFrom) req.from = toIsoDateTimeBoundary(filterFrom, false);
        if (filterTo) req.to = toIsoDateTimeBoundary(filterTo, true);
        if (machineIds !== 'all') req.machineIds = machineIds;
        const res = await window.api.alarms.history(req);
        if (!res.ok) {
          setError(res.error.message);
          setData(null);
        } else {
          setData(res.value);
        }
      } catch (e) {
        setError((e as Error).message);
        setData(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [filterFrom, filterTo, machineIds]);

  const filteredItems = useMemo(() => {
    const items = data?.items ?? [];
    const term = search.trim().toLowerCase();
    if (!term) return items;
    return items.filter((row) => {
      const parts = [
        row.machineName ?? '',
        row.machineId != null ? String(row.machineId) : '',
        row.alarmId ?? '',
        row.description ?? ''
      ];
      return parts.some((p) => p.toLowerCase().includes(term));
    });
  }, [data?.items, search]);

  const columnHelper = createColumnHelper<AlarmsHistoryRes['items'][number]>();
  // Percent widths for columns (normalized in GlobalTable)
  const columns = useMemo(() => [
    columnHelper.accessor('startAt', {
      header: 'DateTime',
      cell: (ctx) => {
        const iso = ctx.getValue();
        return <span title={formatTimeLong(iso)}>{formatTime(iso)}</span>;
      },
      meta: { widthPercent: 20, minWidthPx: 140 }
    }),
    columnHelper.accessor('alarmId', {
      header: 'Alarm ID',
      cell: (ctx) => ctx.getValue() ?? '',
      meta: { widthPercent: 12, minWidthPx: 90 }
    }),
    columnHelper.accessor('description', {
      header: 'Description',
      cell: (ctx) => ctx.getValue(),
      meta: { widthPercent: 40, minWidthPx: 200, wrap: true }
    }),
    columnHelper.accessor('machineName', {
      header: 'Machine',
      cell: (ctx) => ctx.getValue() ?? (ctx.row.original.machineId != null ? `Machine ${ctx.row.original.machineId}` : 'Unknown'),
      meta: { widthPercent: 16, minWidthPx: 120 }
    }),
    columnHelper.accessor('durationMinutes', {
      header: 'Duration (min)',
      cell: (ctx) => ctx.getValue(),
      meta: { widthPercent: 12, minWidthPx: 100 }
    })
  ], [columnHelper]);

  const table = useReactTable({
    data: filteredItems,
    columns,
    getCoreRowModel: getCoreRowModel(),
    enableColumnResizing: false
  });

  return (
    <div className="p-4 space-y-3">

      <div className="border rounded p-3 bg-[var(--card)]">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 flex-1">
            <label className="text-sm flex flex-col gap-1">
              <span>From</span>
              <input
                type="date"
                className="border rounded px-2 py-1"
                value={filters.from}
                onChange={(e) => setFilters((prev) => ({ ...prev, from: e.target.value }))}
              />
            </label>
            <label className="text-sm flex flex-col gap-1">
              <span>To</span>
              <input
                type="date"
                className="border rounded px-2 py-1"
                value={filters.to}
                onChange={(e) => setFilters((prev) => ({ ...prev, to: e.target.value }))}
              />
            </label>
            <div className="md:col-span-2">
              <div className="text-sm">Machines</div>
              <div className="flex flex-wrap gap-3 mt-1">
                <label className="inline-flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={machineIds === 'all'}
                    onChange={(e) => setFilters((prev) => ({ ...prev, machineIds: e.target.checked ? 'all' : [] }))}
                  />
                  All
                </label>
                {machines.map((m) => {
                  const isAll = machineIds === 'all';
                  const checked = isAll ? true : machineIds.includes(m.machineId);
                  return (
                    <label key={m.machineId} className="inline-flex items-center gap-1 text-sm">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) =>
                          setFilters((prev) => {
                            if (prev.machineIds === 'all') return { ...prev, machineIds: [m.machineId] };
                            const ids = new Set(prev.machineIds as number[]);
                            if (e.target.checked) ids.add(m.machineId);
                            else ids.delete(m.machineId);
                            return { ...prev, machineIds: Array.from(ids) };
                          })
                        }
                      />
                      {m.name}
                    </label>
                  );
                })}
              </div>
            </div>
          </div>

          <label className="text-sm flex flex-col gap-1 md:items-end">
            <span>Search</span>
            <input
              type="search"
              className="border rounded px-2 py-1 md:min-w-[16rem]"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Alarm, machine, ID"
            />
          </label>
        </div>
      </div>

      {error && <div className="border border-red-300 bg-red-50 text-red-700 text-sm px-3 py-2 rounded">{error}</div>}
      {loading && <div className="text-sm text-muted-foreground">Loading...</div>}

      <GlobalTable table={table} />
    </div>
  );
}

// Use named export only to reduce duplicate exports
