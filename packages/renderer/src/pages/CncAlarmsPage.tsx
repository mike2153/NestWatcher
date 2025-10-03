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
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const DD = String(d.getDate()).padStart(2, '0');
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const YYYY = d.getFullYear();
  return `${hh}:${mm}:${ss} ${DD}:${MM}:${YYYY}`;
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

  const columnHelper = createColumnHelper<AlarmsHistoryRes['items'][number]>();
  const columns = useMemo(() => [
    columnHelper.accessor('startAt', {
      header: 'DateTime',
      cell: (ctx) => formatTime(ctx.getValue())
    }),
    columnHelper.accessor('alarmId', { header: 'Alarm ID', cell: (ctx) => ctx.getValue() ?? '' }),
    columnHelper.accessor('description', { header: 'Description' }),
    columnHelper.accessor('machineName', {
      header: 'Machine',
      cell: (ctx) => ctx.getValue() ?? (ctx.row.original.machineId != null ? `Machine ${ctx.row.original.machineId}` : 'Unknown')
    }),
    columnHelper.accessor('durationMinutes', { header: 'Duration (min)', cell: (ctx) => ctx.getValue() })
  ], [columnHelper]);

  const table = useReactTable({
    data: data?.items ?? [],
    columns,
    getCoreRowModel: getCoreRowModel()
  });

  return (
    <div className="p-4 space-y-3">
      <h1 className="text-xl font-semibold">CNC Alarms</h1>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
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

      {error && <div className="border border-red-300 bg-red-50 text-red-700 text-sm px-3 py-2 rounded">{error}</div>}
      {loading && <div className="text-sm text-muted-foreground">Loading...</div>}

      <GlobalTable table={table} />
    </div>
  );
}

export default CncAlarmsPage;
