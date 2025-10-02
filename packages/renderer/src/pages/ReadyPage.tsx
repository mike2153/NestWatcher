import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  DiagnosticsSnapshot,
  JobStatus,
  Machine,
  MachineHealthEntry,
  MachineHealthCode,
  ReadyFile
} from '../../../shared/src';
import { cn } from '../utils/cn';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function formatDateTime(value: string | number | null | undefined) {
  if (value == null) return '-';
  const d = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
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

function statusLabel(status: JobStatus | null) {
  if (!status) return 'Not in DB';
  const upper = status.toUpperCase();
  if (upper === 'FORWARDED_TO_NESTPICK') return 'Nestpick Processing';
  const parts = status.split(/[_\s]+/).filter(Boolean).map((p) => p.toLowerCase());
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

export function ReadyPage() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [files, setFiles] = useState<ReadyFile[]>([]);
  const [importing, setImporting] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null);

  const missingCount = useMemo(() => files.filter((file) => !file.inDatabase).length, [files]);

  const loadMachines = useCallback(async () => {
    const res = await window.api.machines.list();
    if (!res.ok) {
      alert('Failed to load machines: ' + res.error.message);
      setMachines([]);
      return;
    }
    const items = res.value.items;
    setMachines(items);
    if (items.length && selected == null) {
      setSelected(items[0].machineId);
    }
  }, [selected]);

  useEffect(() => {
    void loadMachines();
  }, [loadMachines]);

  const loadFiles = useCallback(async () => {
    if (selected == null) return;
    const res = await window.api.files.listReady(selected);
    if (!res.ok) {
      alert('Failed to load files: ' + res.error.message);
      setFiles([]);
      return;
    }
    setFiles(res.value.files);
  }, [selected]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

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
        return 'bg-muted-foreground';
    }
  }

  const handleImport = useCallback(
    async (file: ReadyFile) => {
      if (selected == null) return;
      setFeedback(null);
      setImporting(file.relativePath);
      try {
        const res = await window.api.files.importReady({ machineId: selected, relativePath: file.relativePath });
        if (!res.ok) {
          setFeedback({ type: 'error', message: 'Import failed: ' + res.error.message });
          return;
        }
        const { jobKey, created } = res.value;
        setFeedback({
          type: 'success',
          message: (created ? 'Created job ' : 'Updated job ') + jobKey
        });
        await loadFiles();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setFeedback({ type: 'error', message: 'Import failed: ' + message });
      } finally {
        setImporting(null);
      }
    },
    [selected, loadFiles]
  );

  return (
    <div className="grid h-full grid-cols-[280px_1fr] gap-4 w-full">
      <div className="overflow-auto rounded border bg-table text-[var(--table-text)] p-2">
        <div className="mb-2 font-medium">Machines</div>
        <ul className="space-y-1">
          {machines.map((machine) => {
            const issues: MachineHealthEntry[] = [
              ...(machineIssuesById.get(machine.machineId) ?? []),
              ...(machineIssuesById.get('global') ?? [])
            ];
            // Sort by severity (critical -> warning -> info) then recent first
            issues.sort((a, b) => {
              const sev = (s: MachineHealthEntry['severity']) => (s === 'critical' ? 2 : s === 'warning' ? 1 : 0);
              const d = sev(b.severity) - sev(a.severity);
              if (d) return d;
              return b.lastUpdatedAt.localeCompare(a.lastUpdatedAt);
            });
            return (
              <li key={machine.machineId}>
                <button
                  className={cn(
                    'w-full rounded px-2 py-1 text-left',
                    selected === machine.machineId && 'bg-accent'
                  )}
                  onClick={() => setSelected(machine.machineId)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span>{machine.name}</span>
                    {issues.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1">
                        {issues.slice(0, 3).map((issue) => (
                          <span
                            key={issue.id}
                            className={cn(
                              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-white',
                              issue.severity === 'critical'
                                ? 'bg-red-600'
                                : issue.severity === 'warning'
                                ? 'bg-amber-600'
                                : 'bg-muted-foreground'
                            )}
                            title={`${healthLabel(issue.code)} — ${issue.message}`}
                          >
                            <span className={cn('h-1.5 w-1.5 rounded-full', severityDotClass(issue.severity))} />
                            <span>{healthLabel(issue.code)}</span>
                          </span>
                        ))}
                        {issues.length > 3 && (
                          <span className="text-[10px] text-muted-foreground">+{issues.length - 3} more</span>
                        )}
                      </div>
                    )}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="overflow-auto rounded border bg-table text-[var(--table-text)] p-2">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="font-medium">Ready-To-Run Files (.nc)</div>
            <div className="text-xs text-muted-foreground">
              {files.length} item{files.length === 1 ? '' : 's'} - {missingCount} not in database
            </div>
            {feedback && (
              <div
                className={cn(
                  'mt-1 text-xs',
                  feedback.type === 'success' ? 'text-emerald-600' : 'text-red-600'
                )}
              >
                {feedback.message}
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <button className="rounded border px-2 py-1" onClick={() => void loadFiles()}>
              Refresh
            </button>
            <a className="rounded border px-2 py-1" href="#/settings/machines">
              Edit Folders
            </a>
          </div>
        </div>
        <div className="overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-2 py-1">Relative Path</TableHead>
                <TableHead className="px-2 py-1">Material</TableHead>
                <TableHead className="px-2 py-1">Size</TableHead>
                <TableHead className="px-2 py-1">Parts</TableHead>
                <TableHead className="px-2 py-1">Thickness</TableHead>
                <TableHead className="px-2 py-1">Date Added (R2R)</TableHead>
                <TableHead className="px-2 py-1">Status</TableHead>
                <TableHead className="px-2 py-1">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {files.map((file) => (
                <TableRow
                  key={file.relativePath}
                  className={cn('border-t', !file.inDatabase && 'bg-red-50 text-red-700')}
                >
                  <TableCell className="px-2 py-1 font-mono text-xs">{file.relativePath}</TableCell>
                  <TableCell className="px-2 py-1">{file.jobMaterial ?? '-'}</TableCell>
                  <TableCell className="px-2 py-1">{file.jobSize ?? '-'}</TableCell>
                  <TableCell className="px-2 py-1">{file.jobParts ?? '-'}</TableCell>
                  <TableCell className="px-2 py-1">{file.jobThickness ?? '-'}</TableCell>
                  <TableCell className="px-2 py-1">{formatDateTime(file.addedAtR2R ?? file.mtimeMs)}</TableCell>
                  <TableCell className="px-2 py-1">
                    <span
                      className={cn(
                        'inline-flex items-center rounded px-2 py-0.5 text-xs font-medium',
                        !file.inDatabase ? 'bg-red-100 text-red-800' : 'bg-accent text-accent-foreground'
                      )}
                    >
                      {statusLabel(file.status)}
                    </span>
                  </TableCell>
                  <TableCell className="px-2 py-1">
                    {file.inDatabase ? (
                      <span className="text-xs text-muted-foreground">In database</span>
                    ) : (
                      <button
                        className="rounded border px-2 py-1 text-xs"
                        onClick={() => handleImport(file)}
                        disabled={importing === file.relativePath || selected == null}
                      >
                        {importing === file.relativePath ? 'Importing...' : 'Import'}
                      </button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {!files.length && (
                <TableRow>
                  <TableCell className="px-2 py-4 text-center text-sm text-muted-foreground" colSpan={7}>
                    No files found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
