import { useCallback, useEffect, useMemo, useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import type { HistoryListReq, HistoryRow, JobTimelineRes, Machine } from "../../../shared/src";

function formatDate(value: string | null | undefined) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = d.getDate();
  const mon = months[d.getMonth()];
  const year = d.getFullYear();
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12; if (h === 0) h = 12;
  return `${day} ${mon} ${year} ${h}:${m}${ampm}`;
}

function humanize(value: string) {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

type TimelineItem = {
  id: string;
  at: string | null;
  label: string;
  description?: string;
};

type HistoryFilters = {
  machine: "all" | number;
  search: string;
  from: string;
  to: string;
  limit: number;
};

function buildTimeline(data: JobTimelineRes): TimelineItem[] {
  const items: TimelineItem[] = [];
  const { job, events } = data;

  const addItem = (idSuffix: string, at: string | null, label: string, description?: string) => {
    items.push({
      id: `${job.key}:${idSuffix}`,
      at,
      label,
      description: description && description.trim().length ? description : undefined
    });
  };

  if (job.dateadded) addItem("imported", job.dateadded, "Imported", "Job detected in database");
  if (job.stagedAt) addItem("staged", job.stagedAt, "Staged", "Staged timestamp recorded");
  if (job.cutAt) addItem("cut", job.cutAt, "CNC Finish", "Cut completion timestamp recorded");
  if (job.nestpickCompletedAt) addItem("nestpick", job.nestpickCompletedAt, "Nestpick Complete", "Nestpick reported completion");
  if (job.finishAt) {
    const finishLabel = job.finishSource === "nestpick" ? "Finished (Nestpick)" : job.finishSource === "cut" ? "Finished (Cut)" : "Finished";
    const finishDesc = job.finishSource === "nestpick" ? "Finish derived from nestpick completion" : job.finishSource === "cut" ? "Finish derived from CNC completion" : undefined;
    addItem("finished", job.finishAt, finishLabel, finishDesc);
  }

  let lastMachineId: number | null | undefined = job.machineId ?? null;

  events.forEach((event, index) => {
    const [category, actionRaw] = event.eventType.split(":", 2);
    const action = actionRaw ?? "";
    const descriptionParts: string[] = [];
    const payload = event.payload as Record<string, unknown> | null | undefined;

    if (payload && typeof payload === "object") {
      if (typeof payload.source === "string") descriptionParts.push(`Source: ${payload.source}`);
      if (typeof payload.file === "string") descriptionParts.push(`File: ${payload.file}`);
      if (typeof payload.pallet === "string" && payload.pallet) descriptionParts.push(`Pallet: ${payload.pallet}`);
      if (typeof payload.from === "string" && typeof payload.to === "string") {
        descriptionParts.push(`Status ${payload.from} -> ${payload.to}`);
      }
      const machineCandidate = payload.machineId as unknown;
      const payloadMachine =
        typeof machineCandidate === "number"
          ? machineCandidate
          : typeof machineCandidate === "string"
            ? Number(machineCandidate)
            : undefined;
      if (payloadMachine != null && !Number.isNaN(payloadMachine) && payloadMachine !== lastMachineId) {
        const machineLabel = event.machineName ? `${event.machineName} (#${payloadMachine})` : `Machine #${payloadMachine}`;
        descriptionParts.push(`Machine -> ${machineLabel}`);
        lastMachineId = payloadMachine;
      }
    }

    if (event.machineId != null && event.machineId !== lastMachineId) {
      const machineLabel = event.machineName ? `${event.machineName} (#${event.machineId})` : `Machine #${event.machineId}`;
      descriptionParts.push(`Machine -> ${machineLabel}`);
      lastMachineId = event.machineId;
    }

    let label: string;
    switch (category) {
      case "status":
        label = `Status -> ${action}`;
        break;
      case "autopac":
        label = `AutoPAC ${humanize(action)}`;
        break;
      case "nestpick":
        label = `Nestpick ${humanize(action)}`;
        break;
      default:
        label = humanize(event.eventType);
        break;
    }

    addItem(`event-${index}`, event.createdAt ?? null, label, descriptionParts.join(" | "));
  });

  return items
    .sort((a, b) => {
      const aTime = a.at ? new Date(a.at).getTime() : Number.POSITIVE_INFINITY;
      const bTime = b.at ? new Date(b.at).getTime() : Number.POSITIVE_INFINITY;
      if (aTime === bTime) return a.id.localeCompare(b.id);
      return aTime - bTime;
    });
}

export function HistoryPage() {
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [filters, setFilters] = useState<HistoryFilters>({ machine: "all", search: "", from: "", to: "", limit: 100 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<JobTimelineRes | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);

  const selectedRow = useMemo(() => rows.find((row) => row.key === selectedKey) ?? null, [rows, selectedKey]);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    const req: HistoryListReq = {
      limit: filters.limit,
      ...(filters.machine !== "all" ? { machineId: filters.machine } : {}),
      ...(filters.search.trim() ? { search: filters.search.trim() } : {})
    };
    if (filters.from) req.from = new Date(`${filters.from}T00:00:00`).toISOString();
    if (filters.to) req.to = new Date(`${filters.to}T23:59:59.999`).toISOString();
    const res = await window.api.history.list(req);
    if (!res.ok) {
      setError(res.error.message);
      setRows([]);
      setLoading(false);
      return;
    }
    setRows(res.value.items);
    if (res.value.items.length && (!selectedKey || !res.value.items.some((item: HistoryRow) => item.key === selectedKey))) {
      setSelectedKey(res.value.items[0].key);
    }
    setLoading(false);
  }, [filters, selectedKey]);

  const fetchTimeline = useCallback(async (key: string) => {
    setTimelineLoading(true);
    const res = await window.api.history.timeline(key);
    if (!res.ok) {
      const message = res.error.message;
      setError((prev) => (prev ? `${prev}; Timeline: ${message}` : `Timeline: ${message}`));
      setTimeline(null);
      setTimelineLoading(false);
      return;
    }
    setTimeline(res.value ?? null);
    setTimelineLoading(false);
  }, []);

  useEffect(() => {
    (async () => {
      const res = await window.api.machines.list();
      if (!res.ok) {
        console.error('Failed to load machines', res.error);
        return;
      }
      setMachines(res.value.items);
    })();
  }, []);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  useEffect(() => {
    if (selectedKey) {
      fetchTimeline(selectedKey);
    } else {
      setTimeline(null);
    }
  }, [selectedKey, fetchTimeline]);

  const timelineItems = useMemo(() => (timeline ? buildTimeline(timeline) : []), [timeline]);

  return (
    <div className="space-y-4 w-full">
      <div className="flex items-center justify-end gap-3">
        <div className="text-sm text-muted-foreground">{loading ? "Loading..." : `${rows.length} completed jobs`}</div>
        <button className="border rounded px-3 py-1 text-sm" onClick={fetchHistory} disabled={loading}>
          Refresh
        </button>
      </div>

      <div className="flex flex-wrap gap-3 items-end border rounded p-3 bg-[var(--card)]">
        <label className="text-sm flex flex-col gap-1">
          <span>Search</span>
          <input
            className="border rounded px-2 py-1"
            placeholder="Key or material"
            value={filters.search}
            onChange={(e) => setFilters((prev) => ({ ...prev, search: e.target.value }))}
          />
        </label>
        <label className="text-sm flex flex-col gap-1">
          <span>Machine</span>
          <select
            className="border rounded px-2 py-1"
            value={filters.machine === "all" ? "" : String(filters.machine)}
            onChange={(e) => setFilters((prev) => ({ ...prev, machine: e.target.value ? Number(e.target.value) : "all" }))}
          >
            <option value="">All Machines</option>
            {machines.map((machine) => (
              <option key={machine.machineId} value={machine.machineId}>{machine.name}</option>
            ))}
          </select>
        </label>
        <label className="text-sm flex flex-col gap-1">
          <span>From</span>
          <input
            type="date"
            className="border rounded px-2 py-1 min-w-[12rem]"
            value={filters.from}
            onChange={(e) => setFilters((prev) => ({ ...prev, from: e.target.value }))}
          />
        </label>
        <label className="text-sm flex flex-col gap-1">
          <span>To</span>
          <input
            type="date"
            className="border rounded px-2 py-1 min-w-[12rem]"
            value={filters.to}
            onChange={(e) => setFilters((prev) => ({ ...prev, to: e.target.value }))}
          />
        </label>
        <label className="text-sm flex flex-col gap-1">
          <span>Limit</span>
          <select
            className="border rounded px-2 py-1"
            value={filters.limit}
            onChange={(e) => setFilters((prev) => ({ ...prev, limit: Number(e.target.value) }))}
          >
            {[50, 100, 150, 200].map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <div className="ml-auto">
          <Button variant="default" size="sm" disabled={!selectedKey} onClick={async () => {
            if (!selectedKey) return;
            const res = await window.api.jobs.rerun(selectedKey);
            if (!res.ok) {
              alert(`Re-run failed: ${res.error.message}`);
            } else {
              alert('Re-run created successfully. The new job will appear after ingest.');
            }
          }}>Re-run</Button>
        </div>
      </div>



      {error && (
        <div className="border border-red-300 bg-red-50 text-red-700 text-sm px-3 py-2 rounded">{error}</div>
      )}

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="bg-[var(--table-bg)] text-[var(--table-text)] h-[calc(100vh-250px)] overflow-y-auto">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="px-2 py-2 w-[35%]">Folder</TableHead>
                <TableHead className="px-2 py-2 w-[25%]">NC File</TableHead>
                <TableHead className="px-2 py-2 w-[20%]">Machine</TableHead>
                <TableHead className="px-2 py-2 w-[20%]">Finish</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const isActive = row.key === selectedKey;
                const machineLabel = row.machineName ?? (row.machineId != null ? `Machine #${row.machineId}` : "Unassigned");
                return (
                  <TableRow
                    key={row.key}
                    className={isActive ? '!bg-[var(--accent-blue-subtle)]' : ''}
                    onClick={() => setSelectedKey(row.key)}
                  >
                    <TableCell className="px-2 py-2 truncate">{row.folder ?? ''}</TableCell>
                    <TableCell className="px-2 py-2 truncate">{row.ncfile ?? ""}</TableCell>
                    <TableCell className="px-2 py-2 truncate">{machineLabel}</TableCell>
                    <TableCell className="px-2 py-2 text-xs truncate">{formatDate(row.finishAt)}</TableCell>
                  </TableRow>
                );
              })}
              {!rows.length && !loading && (
                <TableRow>
                  <TableCell colSpan={4} className="px-2 py-6 text-center text-sm text-muted-foreground">No completed jobs found.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        <div className="rounded border bg-card text-card-foreground shadow-lg p-4 space-y-3 h-[calc(100vh-250px)] overflow-y-auto">
          {!selectedRow && <div className="text-sm text-muted-foreground">Select a job to view its timeline.</div>}
          {selectedRow && (
            <>
              <div>
                <h2 className="text-lg font-semibold">{selectedRow.ncfile ?? selectedRow.key}</h2>
                <div className="text-xs text-muted-foreground space-y-1">
                  <p>Folder: {selectedRow.folder ?? "-"}</p>
                  <p>Machine: {selectedRow.machineName ?? (selectedRow.machineId != null ? `Machine #${selectedRow.machineId}` : "Unassigned")}</p>
                  <p>Finished: {formatDate(selectedRow.finishAt)} ({selectedRow.finishSource === "nestpick" ? "Nestpick completion" : "Cut completion"})</p>
                </div>
              </div>
              <div className="pt-2 border-t">
                {timelineLoading && <div className="text-sm text-muted-foreground">Loading timeline...</div>}
                {!timelineLoading && timelineItems.length === 0 && (
                  <div className="text-sm text-muted-foreground">No timeline events recorded.</div>
                )}
                {!timelineLoading && timelineItems.length > 0 && (
                  <ul className="space-y-3">
                    {timelineItems.map((item) => (
                      <li key={item.id} className="relative pl-5">
                        <span className="absolute left-0 top-2 h-2.5 w-2.5 rounded-full bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.5)]" />
                        <div className="text-xs text-muted-foreground">{item.at ? formatDate(item.at) : "No timestamp"}</div>
                        <div className="text-sm font-medium">{item.label}</div>
                        {item.description && <div className="text-xs text-muted-foreground">{item.description}</div>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}






