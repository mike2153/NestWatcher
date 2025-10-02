import { useEffect, useMemo, useState } from 'react';
import type { Machine, TelemetrySummaryRes } from '../../../shared/src';
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';

type Filters = {
  from: string;
  to: string;
  machineIds: number[] | 'all';
};

const COLORS = {
  BUSY: '#22c55e', // green
  READY: '#3b82f6', // blue
  'B-STOP': '#f97316', // orange
  ALARM_EMG: '#ef4444', // red
  OTHER: '#6b7280' // gray
};

function toIsoDateTimeBoundary(dateStr: string, endOfDay: boolean): string | undefined {
  if (!dateStr) return undefined;
  return endOfDay ? `${dateStr}T23:59:59.999Z` : `${dateStr}T00:00:00.000Z`;
}

function sumSeconds(item: TelemetrySummaryRes['items'][number]) {
  const s = item.seconds;
  return s.READY + s['B-STOP'] + s.BUSY + s.ALARM + s.EMG + s.OTHER;
}

function defaultDateRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setMonth(from.getMonth() - 1);
  const toStr = `${to.getFullYear()}-${String(to.getMonth() + 1).padStart(2, '0')}-${String(to.getDate()).padStart(2, '0')}`;
  const fromStr = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}`;
  return { from: fromStr, to: toStr };
}

export function TelemetryPage() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [filters, setFilters] = useState<Filters>({ ...defaultDateRange(), machineIds: 'all' });
  const [data, setData] = useState<TelemetrySummaryRes | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const res = await window.api.machines.list();
      if (res.ok) setMachines(res.value.items);
    })();
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const req: { from?: string; to?: string; machineIds?: number[] } = {};
    if (filters.from) req.from = toIsoDateTimeBoundary(filters.from, false);
    if (filters.to) req.to = toIsoDateTimeBoundary(filters.to, true);
    if (filters.machineIds !== 'all') req.machineIds = filters.machineIds;
    // eslint-disable-next-line no-console
    console.log('telemetry: subscribe', req);
    const unsubscribe = window.api.telemetry.subscribe(req, (payload) => {
      try {
        // Dev console visibility
        // eslint-disable-next-line no-console
        console.log('telemetry:update', payload);
      } catch {}
      setData(payload);
      setLoading(false);
    });
    return () => unsubscribe();
  }, [filters.from, filters.to, JSON.stringify(filters.machineIds)]);

  const selectedMachineIds = useMemo(() => {
    if (filters.machineIds === 'all') return new Set(machines.map((m) => m.machineId));
    return new Set(filters.machineIds);
  }, [filters.machineIds, machines]);

  const visibleItems = useMemo(() => {
    const items = data?.items ?? [];
    return items.filter((i) => i.machineId != null && selectedMachineIds.has(i.machineId));
  }, [data, selectedMachineIds]);

  const aggregate = useMemo(() => {
    const agg = { READY: 0, 'B-STOP': 0, BUSY: 0, ALARM: 0, EMG: 0, OTHER: 0 };
    for (const it of visibleItems) {
      const s = it.seconds;
      agg.READY += s.READY;
      agg['B-STOP'] += s['B-STOP'];
      agg.BUSY += s.BUSY;
      agg.ALARM += s.ALARM;
      agg.EMG += s.EMG;
      agg.OTHER += s.OTHER;
    }
    return agg;
  }, [visibleItems]);

  const onlyOne = visibleItems.length === 1;

  function buildChartData(seconds: { READY: number; 'B-STOP': number; BUSY: number; ALARM: number; EMG: number; OTHER: number }) {
    const red = seconds.ALARM + seconds.EMG;
    const items = [
      { name: 'Busy', key: 'BUSY', value: seconds.BUSY, color: COLORS.BUSY },
      { name: 'Ready', key: 'READY', value: seconds.READY, color: COLORS.READY },
      { name: 'B-Stop', key: 'B-STOP', value: seconds['B-STOP'], color: COLORS['B-STOP'] },
      { name: 'Alarm/EMG', key: 'ALARM_EMG', value: red, color: COLORS.ALARM_EMG },
      { name: 'Other', key: 'OTHER', value: seconds.OTHER, color: COLORS.OTHER }
    ];
    return items.filter((d) => d.value > 0);
  }

  function formatPct(value: number, total: number) {
    if (total <= 0) return '0%';
    return `${Math.round((value / total) * 100)}%`;
  }

  function MachinePie({ name, seconds }: { name: string; seconds: { READY: number; 'B-STOP': number; BUSY: number; ALARM: number; EMG: number; OTHER: number } }) {
    const dataset = buildChartData(seconds);
    const total = dataset.reduce((acc, d) => acc + d.value, 0);
    return (
      <div className="border rounded p-3">
        <div className="text-sm font-medium mb-2">{name}</div>
        <div className="w-full h-48">
          <ResponsiveContainer>
            <PieChart>
              <Pie dataKey="value" data={dataset} outerRadius={80}>
                {dataset.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip formatter={(v: any) => `${v} sec`} />
              <Legend formatter={(value, entry) => {
                const item = dataset.find((d) => d.key === (entry && (entry as any).payload?.key));
                return `${value} ${item ? formatPct(item.value, total) : ''}`;
              }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3">
      <h1 className="text-xl font-semibold">CNC Telemetry</h1>

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
                checked={filters.machineIds === 'all'}
                onChange={(e) => setFilters((prev) => ({ ...prev, machineIds: e.target.checked ? 'all' : [] }))}
              />
              All
            </label>
            {machines.map((m) => {
              const checked = filters.machineIds === 'all' ? true : (filters.machineIds as number[]).includes(m.machineId);
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
      {!loading && data && data.items.length > 0 && visibleItems.length === 0 && (
        <div className="border border-amber-300 bg-amber-50 text-amber-700 text-sm px-3 py-2 rounded">
          No machine mapping found for the selected filters. Ensure machine PC IP matches cncstats API IP.
        </div>
      )}

      {!onlyOne && (
        <div className="border rounded p-4">
          <div className="text-sm font-medium mb-2">Aggregated</div>
          <div className="w-full h-64">
            <ResponsiveContainer>
              <PieChart>
                <Pie dataKey="value" data={buildChartData(aggregate)} outerRadius={110}>
                  {buildChartData(aggregate).map((entry, index) => (
                    <Cell key={`agg-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip formatter={(v: any) => `${v} sec`} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
        {visibleItems
          .sort((a, b) => sumSeconds(b) - sumSeconds(a))
          .map((it) => (
            <MachinePie key={it.machineId ?? -1} name={it.machineName ?? `Machine ${it.machineId}`} seconds={it.seconds} />
          ))}
      </div>
    </div>
  );
}

export default TelemetryPage;
