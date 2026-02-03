import { useEffect, useMemo, useState } from 'react';
import type {
  DiagnosticsSnapshot,
  Machine,
  MachineHealthEntry,
  MachineHealthCode,
  SaveMachineReq
} from '../../../shared/src';
import { cn } from '../utils/cn';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';


export function MachinesPage() {
  const [items, setItems] = useState<Machine[]>([]);
  const [editing, setEditing] = useState<Machine | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null);

  async function load() {
    const res = await window.api.machines.list();
    if (!res.ok) {
      alert(`Failed to load machines: ${res.error.message}`);
      setItems([]);
      return;
    }
    setItems(res.value.items);
  }
  useEffect(() => { load(); }, []);

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

  const onSave = async () => {
    if (!editing) return;
    const req: SaveMachineReq = {
      machineId: editing.machineId,
      name: editing.name,
      pcIp: (editing as { pcIp?: string | null; cncIp?: string | null }).pcIp ?? (editing as { pcIp?: string | null; cncIp?: string | null }).cncIp ?? undefined,
      apJobfolder: editing.apJobfolder,
      nestpickFolder: editing.nestpickFolder,
      nestpickEnabled: editing.nestpickEnabled
    };
    const res = await window.api.machines.save(req);
    if (!res.ok) {
      alert(`Failed to save machine: ${res.error.message}`);
      return;
    }
    setEditing(null);
    await load();
  };

  return (
    <div className="space-y-4 w-full">
      <div className="border rounded bg-[var(--table-bg)] text-[var(--table-text)]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-2 py-2">ID</TableHead>
              <TableHead className="px-2 py-2">Name</TableHead>
              <TableHead className="px-2 py-2">Health</TableHead>
              <TableHead className="px-2 py-2">PC IP</TableHead>
              <TableHead className="px-2 py-2">AP Job Folder</TableHead>
              <TableHead className="px-2 py-2">Nestpick Folder</TableHead>
              <TableHead className="px-2 py-2">Enabled</TableHead>
              <TableHead className="px-2 py-2"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map(m => {
              const issues: MachineHealthEntry[] = [
                ...(machineIssuesById.get(m.machineId) ?? []),
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
                <TableRow key={m.machineId}>
                  <TableCell className="px-2 py-1">{m.machineId}</TableCell>
                  <TableCell className="px-2 py-1">{m.name}</TableCell>
                  <TableCell className="px-2 py-1">
                    {issues.length === 0 ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : (
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
                  </TableCell>
                  <TableCell className="px-2 py-1">{(m as { pcIp?: string | null; cncIp?: string | null }).pcIp ?? (m as { pcIp?: string | null; cncIp?: string | null }).cncIp ?? '—'}</TableCell>
                  <TableCell className="px-2 py-1">{m.apJobfolder}</TableCell>
                  <TableCell className="px-2 py-1">{m.nestpickFolder}</TableCell>
                  <TableCell className="px-2 py-1">{m.nestpickEnabled ? 'Yes' : 'No'}</TableCell>
                  <TableCell className="px-2 py-1"><Button size="sm" onClick={() => setEditing(m)}>Edit</Button></TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {editing && (
        <div className="border rounded bg-card text-card-foreground p-3 space-y-2">
          <div className="font-medium">Edit Machine {editing.machineId}</div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-sm">Name<input className="border rounded w-full px-2 py-1" value={editing.name} onChange={e=>setEditing({...editing, name: e.target.value})} /></label>
            <label className="text-sm">PC IP<input className="border rounded w-full px-2 py-1" value={(editing as { pcIp?: string | null; cncIp?: string | null }).pcIp ?? (editing as { pcIp?: string | null; cncIp?: string | null }).cncIp ?? ''} onChange={e=>setEditing({...editing, pcIp: e.target.value})} /></label>
            <label className="text-sm">AP Job Folder<div className="flex gap-2"><input className="border rounded w-full px-2 py-1" value={editing.apJobfolder} onChange={e=>setEditing({...editing, apJobfolder: e.target.value})} /><Button size="sm" onClick={async()=>{ const picked = await window.api.dialog.pickFolder(); if (picked.ok && picked.value) setEditing({...editing, apJobfolder: picked.value}); }}>Browse</Button></div></label>
            <label className="text-sm">Nestpick Folder<div className="flex gap-2"><input className="border rounded w-full px-2 py-1" value={editing.nestpickFolder} onChange={e=>setEditing({...editing, nestpickFolder: e.target.value})} /><Button size="sm" onClick={async()=>{ const picked = await window.api.dialog.pickFolder(); if (picked.ok && picked.value) setEditing({...editing, nestpickFolder: picked.value}); }}>Browse</Button></div></label>
            <div className="text-sm">Enabled<Select value={editing.nestpickEnabled ? 'true':'false'} onValueChange={v=>setEditing({...editing, nestpickEnabled: v==='true'})}><SelectTrigger className="w-full mt-1"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="true">Yes</SelectItem><SelectItem value="false">No</SelectItem></SelectContent></Select></div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={onSave}>Save</Button>
            <Button size="sm" variant="destructive" onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}
