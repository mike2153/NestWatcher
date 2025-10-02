import { useEffect, useMemo, useState } from 'react';
import type {
  DiagnosticsSnapshot,
  JobRow,
  JobsListReq,
  Machine,
  MachineHealthEntry,
  MachineHealthCode
} from '../../../shared/src';
import { cn } from '../utils/cn';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const ACTIVE_STATUSES: NonNullable<JobsListReq['filter']['statusIn']> = [
  'STAGED',
  'LOAD_FINISH',
  'LABEL_FINISH',
  'CNC_FINISH',
  'FORWARDED_TO_NESTPICK'
];

export function DashboardPage() {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setError(null);
      setLoading(true);
      const res = await window.api.jobs.list({
        sortBy: 'dateadded',
        sortDir: 'desc',
        limit: 100,
        filter: { statusIn: ACTIVE_STATUSES }
      });
      if (cancelled) return;
      if (!res.ok) {
        setError(res.error.message);
        setLoading(false);
        return;
      }
      setJobs(res.value.items);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await window.api.machines.list();
      if (cancelled) return;
      if (res.ok) setMachines(res.value.items);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.api.diagnostics
      .get()
      .then((res) => {
        if (cancelled) return;
        if (res.ok) setDiagnostics(res.value);
      })
      .catch(() => {});
    const unsubscribe = window.api.diagnostics.subscribe((snapshot) => {
      if (!cancelled) setDiagnostics(snapshot);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const machineNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const m of machines) map.set(m.machineId, m.name);
    return map;
  }, [machines]);

  const machineIssuesById = useMemo(() => {
    const entries: MachineHealthEntry[] = diagnostics?.machineHealth ?? [];
    const byId = new Map<number | 'global', MachineHealthEntry[]>();
    for (const issue of entries) {
      const key = issue.machineId ?? 'global';
      const list = byId.get(key) ?? [];
      list.push(issue);
      byId.set(key, list);
    }
    return byId;
  }, [diagnostics]);

  function healthLabel(code: MachineHealthCode): string {
    switch (code) {
      case 'NO_PARTS_CSV':
        return 'Parts CSV missing';
      case 'NESTPICK_SHARE_UNREACHABLE':
        return 'Nestpick share unreachable';
      case 'COPY_FAILURE':
        return 'Copy failures';
    }
    return (code as string).replace(/_/g, ' ');
  }

  function severityDotClass(severity: MachineHealthEntry['severity']): string {
    switch (severity) {
      case 'critical':
        return 'bg-red-500';
      case 'warning':
        return 'bg-amber-500';
      default:
        return 'bg-slate-400';
    }
  }

  return (
    <div className="space-y-4 w-full">
      <h1 className="text-xl font-semibold">Dashboard</h1>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="border rounded p-4 flex flex-col">
          <div className="font-medium mb-2">Jobs Pending</div>
          {loading ? (
            <div className="text-sm text-muted-foreground flex items-center gap-2">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current"></div>
              Loading...
            </div>
          ) : error ? (
            <div className="text-sm text-destructive">Failed to load jobs: {error}</div>
          ) : jobs.length === 0 ? (
            <div className="text-sm text-muted-foreground">No active jobs found.</div>
          ) : (
            <Card className="overflow-hidden">
              <CardContent className="px-6 py-2">
                <Table aria-label="Active jobs pending processing">
                  <caption className="sr-only">Table showing active jobs with their key, machine, material, and status</caption>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Key</TableHead>
                      <TableHead scope="col">Machine</TableHead>
                      <TableHead scope="col">Material</TableHead>
                      <TableHead scope="col">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {jobs.map((job) => (
                      <TableRow key={job.key}>
                        <TableCell className="py-1 pr-2">{job.key}</TableCell>
                        <TableCell className="py-1 pr-2">
                        {job.machineId != null ? (
                          (() => {
                            const id = job.machineId!;
                            const name = machineNameById.get(id) ?? id;
                            const issues: MachineHealthEntry[] = [
                              ...(machineIssuesById.get(id) ?? []),
                              ...(machineIssuesById.get('global') ?? [])
                            ]
                              .slice()
                              .sort((a, b) => {
                                const sev = (s: MachineHealthEntry['severity']) => (s === 'critical' ? 2 : s === 'warning' ? 1 : 0);
                                const d = sev(b.severity) - sev(a.severity);
                                if (d) return d;
                                return b.lastUpdatedAt.localeCompare(a.lastUpdatedAt);
                              });
                            return (
                              <div className="flex items-center gap-2">
                                <span>{String(name)}</span>
                                {issues.length > 0 && (
                                  <div className="flex flex-wrap items-center gap-1">
                                    {issues.slice(0, 2).map((issue) => (
                                      <span
                                        key={issue.id}
                                        className={cn(
                                          'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-white',
                                          issue.severity === 'critical'
                                            ? 'bg-red-600'
                                            : issue.severity === 'warning'
                                            ? 'bg-amber-600'
                                            : 'bg-slate-500'
                                        )}
                                        title={`${healthLabel(issue.code)} GÇö ${issue.message}`}
                                      >
                                        <span className={cn('h-1.5 w-1.5 rounded-full', severityDotClass(issue.severity))} />
                                        <span>{healthLabel(issue.code)}</span>
                                      </span>
                                    ))}
                                    {issues.length > 2 && (
                                      <span className="text-[10px] text-muted-foreground">+{issues.length - 2} more</span>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })()
                        ) : (
                          '-'
                        )}
                        </TableCell>
                        <TableCell className="py-1 pr-2">{job.material ?? '-'}</TableCell>
                        <TableCell className="py-1">{job.status}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </div>
        <div className="border rounded p-4">Jobs In Progress</div>
        <div className="border rounded p-4">Completed Today</div>
      </div>
    </div>
  );
}

