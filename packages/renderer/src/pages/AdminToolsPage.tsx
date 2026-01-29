import React, { type ReactNode, useCallback, useEffect, useState } from 'react';
import type { Machine, Settings } from '../../../shared/src';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/cn';
import { useAuth } from '@/contexts/AuthContext';

type WriteMode = 'atomic' | 'direct' | 'chunked';
type LineEnding = 'crlf' | 'lf';

type CorruptPreset =
  | 'valid'
  | 'incorrectDelimiter'
  | 'noDelimiter'
  | 'empty'
  | 'singleColumn'
  | 'missingMachine'
  | 'machineMismatch'
  | 'randomGarbage'
  | 'truncateHalf';

function normalizeBasesList(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function applyCorruption(content: string, preset: CorruptPreset, options?: { wrongMachineToken?: string }): string {
  switch (preset) {
    case 'valid':
      return content;
    case 'incorrectDelimiter':
      // Create a file that has delimiters, but NOT a delimiter we support (no ',' or ';').
      return content.replace(/[;,]/g, '|');
    case 'noDelimiter':
      return content.replace(/[;,|]/g, ' ');
    case 'empty':
      return '';
    case 'singleColumn': {
      const lines = content
        .split(/\r?\n/)
        .map((ln) => ln.trim())
        .filter(Boolean)
        .map((ln) => ln.split(/[;,|]/)[0] ?? '')
        .filter(Boolean);
      return lines.join('\r\n') + (lines.length ? '\r\n' : '');
    }
    case 'missingMachine': {
      // Drop the machine column if present: keep first token only.
      const lines = content
        .split(/\r?\n/)
        .map((ln) => ln.trim())
        .filter(Boolean)
        .map((ln) => {
          const delim = ln.includes(';') ? ';' : ln.includes(',') ? ',' : ln.includes('|') ? '|' : null;
          if (!delim) return ln;
          const parts = ln.split(delim);
          return parts[0] + delim;
        });
      return lines.join('\r\n') + (lines.length ? '\r\n' : '');
    }
    case 'machineMismatch':
      return options?.wrongMachineToken ? content.split(options.wrongMachineToken).join('WTX') : content + 'WTX';
    case 'randomGarbage':
      return '### CORRUPT FILE ###\r\n"\\u0000";"\\u0001";???\r\n';
    case 'truncateHalf':
      return content.slice(0, Math.floor(content.length / 2));
    default:
      return content;
  }
}

function applyLineEnding(content: string, lineEnding: LineEnding): string {
  const lf = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return lineEnding === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf;
}

function FieldLabel({ children }: { children: ReactNode }) {
  return <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</div>;
}

function ReadOnlyPath({ value }: { value: string }) {
  const ok = Boolean(value && value.trim());
  return (
    <input
      className={cn(
        'w-full rounded-md border bg-background px-3 py-2 text-sm font-mono',
        ok ? 'border-border' : 'border-destructive/50'
      )}
      value={value || ''}
      readOnly
      placeholder="Not configured"
    />
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function GenericFolderWriter(props: {
  title: string;
  folderPath: string;
  targetKind: 'jobsRoot' | 'archiveRoot' | 'quarantineRoot' | 'testDataFolderPath';
  writeFile: (input: Parameters<typeof window.api.adminTools.writeFile>[0]) => Promise<string>;
}) {
  const { title, folderPath, targetKind, writeFile } = props;
  const configured = Boolean(folderPath && folderPath.trim());

  const [fileName, setFileName] = useState('test.txt');
  const [relativeDir, setRelativeDir] = useState('');
  const [preset, setPreset] = useState<CorruptPreset>('valid');
  const [writeMode, setWriteMode] = useState<WriteMode>('atomic');
  const [lineEnding, setLineEnding] = useState<LineEnding>('crlf');
  const [content, setContent] = useState('Hello from Admin Tools\r\n');
  const [result, setResult] = useState<string | null>(null);

  const preview = applyLineEnding(applyCorruption(content, preset), lineEnding);

  return (
    <Card title={title}>
      <div className="space-y-3">
        <div>
          <FieldLabel>Target Folder</FieldLabel>
          <ReadOnlyPath value={folderPath} />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <FieldLabel>Relative Subfolder</FieldLabel>
            <input
              className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
              value={relativeDir}
              onChange={(e) => setRelativeDir(e.target.value)}
              placeholder="optional/subfolder"
              disabled={!configured}
            />
          </div>
          <div>
            <FieldLabel>File Name</FieldLabel>
            <input
              className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              disabled={!configured}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <FieldLabel>Corruption</FieldLabel>
            <select
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={preset}
              onChange={(e) => setPreset(e.target.value as CorruptPreset)}
              disabled={!configured}
            >
              <option value="valid">Valid</option>
              <option value="truncateHalf">Truncate half</option>
              <option value="empty">Empty file</option>
              <option value="randomGarbage">Random garbage</option>
            </select>
          </div>
          <div>
            <FieldLabel>Write Mode</FieldLabel>
            <select
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={writeMode}
              onChange={(e) => setWriteMode(e.target.value as WriteMode)}
              disabled={!configured}
            >
              <option value="atomic">Atomic (tmp+rename)</option>
              <option value="direct">Direct</option>
              <option value="chunked">Chunked</option>
            </select>
          </div>
          <div>
            <FieldLabel>Line Endings</FieldLabel>
            <select
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={lineEnding}
              onChange={(e) => setLineEnding(e.target.value as LineEnding)}
              disabled={!configured}
            >
              <option value="crlf">CRLF</option>
              <option value="lf">LF</option>
            </select>
          </div>
        </div>

        <div>
          <FieldLabel>File Contents</FieldLabel>
          <textarea
            className="min-h-28 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            disabled={!configured}
          />
        </div>

        <div>
          <FieldLabel>Preview</FieldLabel>
          <textarea
            className="min-h-28 w-full rounded-md border border-border bg-muted px-3 py-2 font-mono text-sm"
            value={preview}
            readOnly
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={async () => {
              try {
                setResult(null);
                const fullPath = await writeFile({
                  target: { kind: targetKind },
                  relativeDir: relativeDir.trim() || undefined,
                  fileName,
                  content: preview,
                  writeMode,
                  lineEnding,
                  overwrite: true
                });
                setResult(`Wrote: ${fullPath}`);
              } catch (e) {
                setResult(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
              }
            }}
            disabled={!configured}
          >
            Generate
          </Button>
          {result ? <div className="text-xs text-muted-foreground font-mono">{result}</div> : null}
        </div>
      </div>
    </Card>
  );
}

export function AdminToolsPage() {
  const { session } = useAuth();

  const allowed = Boolean(
    session?.role === 'admin' && typeof session?.username === 'string' && session.username.toLowerCase() === 'admin'
  );

  const [settings, setSettings] = useState<Settings | null>(null);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // AutoPAC panel state
  const [autoPacType, setAutoPacType] = useState<'load_finish' | 'label_finish' | 'cnc_finish'>('cnc_finish');
  const [autoPacMachineToken, setAutoPacMachineToken] = useState('WT1');
  const [autoPacBases, setAutoPacBases] = useState('TEST 001');
  const [autoPacPreset, setAutoPacPreset] = useState<CorruptPreset>('valid');
  const [autoPacWriteMode, setAutoPacWriteMode] = useState<WriteMode>('atomic');
  const [autoPacLineEnding, setAutoPacLineEnding] = useState<LineEnding>('crlf');
  const [autoPacFileName, setAutoPacFileName] = useState('');
  const [autoPacContent, setAutoPacContent] = useState('');
  const [autoPacDirty, setAutoPacDirty] = useState(false);
  const [autoPacResult, setAutoPacResult] = useState<string | null>(null);

  // Grundner panel state
  const [grundnerFileKind, setGrundnerFileKind] = useState<'order_saw.csv' | 'order_saw.erl' | 'ChangeMachNr.csv' | 'ChangeMachNr.erl'>(
    'order_saw.csv'
  );
  const [grundnerBases, setGrundnerBases] = useState('TEST 001');
  const [grundnerMachineId, setGrundnerMachineId] = useState('1');
  const [grundnerPreset, setGrundnerPreset] = useState<CorruptPreset>('valid');
  const [grundnerWriteMode, setGrundnerWriteMode] = useState<WriteMode>('atomic');
  const [grundnerLineEnding, setGrundnerLineEnding] = useState<LineEnding>('crlf');
  const [grundnerFileName, setGrundnerFileName] = useState('');
  const [grundnerContent, setGrundnerContent] = useState('');
  const [grundnerDirty, setGrundnerDirty] = useState(false);
  const [grundnerResult, setGrundnerResult] = useState<string | null>(null);

  // Per-machine Nestpick panel state
  const [nestpickMachineId, setNestpickMachineId] = useState<number | null>(null);
  const [nestpickFileKind, setNestpickFileKind] = useState<'Nestpick.erl' | 'Report_FullNestpickUnstack.csv'>('Nestpick.erl');
  const [nestpickBase, setNestpickBase] = useState('TEST 001');
  const [nestpickPallet, setNestpickPallet] = useState('12');
  const [nestpickPreset, setNestpickPreset] = useState<CorruptPreset>('valid');
  const [nestpickWriteMode, setNestpickWriteMode] = useState<WriteMode>('atomic');
  const [nestpickLineEnding, setNestpickLineEnding] = useState<LineEnding>('crlf');
  const [nestpickFileName, setNestpickFileName] = useState('');
  const [nestpickContent, setNestpickContent] = useState('');
  const [nestpickDirty, setNestpickDirty] = useState(false);
  const [nestpickResult, setNestpickResult] = useState<string | null>(null);

  // Per-machine Ready-To-Run panel state
  const [r2rMachineId, setR2rMachineId] = useState<number | null>(null);
  const [r2rFileKind, setR2rFileKind] = useState<'base.npt' | 'base.nc' | 'base.pts'>('base.npt');
  const [r2rBase, setR2rBase] = useState('TEST 001');
  const [r2rPreset, setR2rPreset] = useState<CorruptPreset>('valid');
  const [r2rWriteMode, setR2rWriteMode] = useState<WriteMode>('atomic');
  const [r2rLineEnding, setR2rLineEnding] = useState<LineEnding>('crlf');
  const [r2rFileName, setR2rFileName] = useState('');
  const [r2rContent, setR2rContent] = useState('');
  const [r2rDirty, setR2rDirty] = useState(false);
  const [r2rResult, setR2rResult] = useState<string | null>(null);

  // Processed jobs root "job folder builder" state
  const [jobFolderName, setJobFolderName] = useState('TEST_JOB_FOLDER');
  const [jobBase, setJobBase] = useState('TEST 001');
  const [jobIncludeNpt, setJobIncludeNpt] = useState(true);
  const [jobIncludePts, setJobIncludePts] = useState(false);
  const [jobPreset, setJobPreset] = useState<CorruptPreset>('valid');
  const [jobResult, setJobResult] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [settingsRes, machinesRes] = await Promise.all([window.api.settings.get(), window.api.machines.list()]);
        if (cancelled) return;
        if (!settingsRes.ok) throw new Error(settingsRes.error.message);
        if (!machinesRes.ok) throw new Error(machinesRes.error.message);
        setSettings(settingsRes.value);
        setMachines(machinesRes.value.items);
        if (machinesRes.value.items.length && nestpickMachineId == null) {
          setNestpickMachineId(machinesRes.value.items[0].machineId);
        }
        if (machinesRes.value.items.length && r2rMachineId == null) {
          setR2rMachineId(machinesRes.value.items[0].machineId);
        }
      } catch (e) {
        setSettings(null);
        setMachines([]);
        setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // AutoPAC preview generator
  useEffect(() => {
    const bases = normalizeBasesList(autoPacBases);
    const machine = autoPacMachineToken.trim() || 'WT1';
    const fileName = `${autoPacType}${machine}.csv`;
    const good = bases.length
      ? bases.map((b) => `${b};${machine};1;`).join('\r\n') + '\r\n'
      : `${jobBase};${machine};1;\r\n`;
    const corrupted = applyCorruption(good, autoPacPreset, { wrongMachineToken: machine });
    if (!autoPacDirty) {
      setAutoPacFileName(fileName);
      setAutoPacContent(applyLineEnding(corrupted, autoPacLineEnding));
    }
  }, [autoPacBases, autoPacMachineToken, autoPacPreset, autoPacType, autoPacLineEnding, autoPacDirty, jobBase]);

  // Grundner preview generator
  useEffect(() => {
    const bases = normalizeBasesList(grundnerBases);
    const machineIdNum = Number(grundnerMachineId);
    const machineId = Number.isFinite(machineIdNum) ? Math.trunc(machineIdNum) : 1;
    const good = (() => {
      switch (grundnerFileKind) {
        case 'order_saw.csv':
        case 'order_saw.erl': {
          return bases.map((b) => `${b};MATERIAL;1;0;0;0;0;0;0;0;`).join('\r\n') + (bases.length ? '\r\n' : '');
        }
        case 'ChangeMachNr.csv':
        case 'ChangeMachNr.erl': {
          return bases.map((b) => `${b};${machineId};`).join('\r\n') + (bases.length ? '\r\n' : '');
        }
      }
    })();
    const corrupted = applyCorruption(good ?? '', grundnerPreset);
    if (!grundnerDirty) {
      setGrundnerFileName(grundnerFileKind);
      setGrundnerContent(applyLineEnding(corrupted, grundnerLineEnding));
    }
  }, [grundnerBases, grundnerFileKind, grundnerLineEnding, grundnerMachineId, grundnerPreset, grundnerDirty]);

  // Nestpick preview generator
  useEffect(() => {
    const machineId = nestpickMachineId ?? machines[0]?.machineId ?? 1;
    const base = nestpickBase.trim() || 'TEST 001';
    const pallet = nestpickPallet.trim() || '12';

    const good =
      nestpickFileKind === 'Nestpick.erl'
        ? `Job;Destination;SourceMachine;\r\n${base};99;${machineId};\r\n`
        : `${base};${pallet};\r\n`;
    const corrupted = applyCorruption(good, nestpickPreset);
    if (!nestpickDirty) {
      setNestpickFileName(nestpickFileKind);
      setNestpickContent(applyLineEnding(corrupted, nestpickLineEnding));
    }
  }, [machines, nestpickBase, nestpickFileKind, nestpickLineEnding, nestpickMachineId, nestpickPallet, nestpickPreset, nestpickDirty]);

  // Ready-To-Run preview generator
  useEffect(() => {
    const machineId = r2rMachineId ?? machines[0]?.machineId ?? 1;
    const base = r2rBase.trim() || 'TEST 001';

    const good = (() => {
      switch (r2rFileKind) {
        case 'base.npt':
          return `Job;Destination;SourceMachine;\r\n${base};99;${machineId};\r\n`;
        case 'base.nc':
          return `; minimal test NC\r\nID=TEST\r\nG100 X2400 Y1200 Z18\r\n`;
        case 'base.pts':
          return `PART-001\r\nPART-002\r\n`;
      }
    })();
    const corrupted = applyCorruption(good ?? '', r2rPreset);
    const fileName = r2rFileKind.replace('base', base);
    if (!r2rDirty) {
      setR2rFileName(fileName);
      setR2rContent(applyLineEnding(corrupted, r2rLineEnding));
    }
  }, [machines, r2rBase, r2rFileKind, r2rLineEnding, r2rMachineId, r2rPreset, r2rDirty]);

  const paths = settings?.paths;

  const writeFile = useCallback(
    async (input: Parameters<typeof window.api.adminTools.writeFile>[0]) => {
      const res = await window.api.adminTools.writeFile(input);
      if (!res.ok) throw new Error(res.error.message);
      return res.value.fullPath;
    },
    []
  );

  if (!allowed) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold">Admin Tools</h1>
        <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          This page is only available when signed in as username <span className="font-mono">admin</span>.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Admin Tools: File Fuzzer</h1>
        <div className="rounded-md border border-warning/30 bg-warning/5 p-3 text-sm text-warning">
          Writes files into live watched folders. Use test shares only.
        </div>
      </header>

      {loading ? <div className="text-sm text-muted-foreground">Loading settings…</div> : null}
      {loadError ? <div className="text-sm text-destructive">Failed to load: {loadError}</div> : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card title="AutoPAC CSV Directory">
          <div className="space-y-3">
            <div>
              <FieldLabel>Target Folder</FieldLabel>
              <ReadOnlyPath value={paths?.autoPacCsvDir ?? ''} />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <FieldLabel>CSV Type</FieldLabel>
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={autoPacType}
                  onChange={(e) => setAutoPacType(e.target.value as typeof autoPacType)}
                >
                  <option value="load_finish">load_finish</option>
                  <option value="label_finish">label_finish</option>
                  <option value="cnc_finish">cnc_finish</option>
                </select>
              </div>
              <div>
                <FieldLabel>Machine Token</FieldLabel>
                <input
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={autoPacMachineToken}
                  onChange={(e) => setAutoPacMachineToken(e.target.value)}
                  placeholder="WT1"
                />
              </div>
            </div>

            <div>
              <FieldLabel>NC Bases (one per line)</FieldLabel>
              <textarea
                className="min-h-20 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
                value={autoPacBases}
                onChange={(e) => setAutoPacBases(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <FieldLabel>Corruption</FieldLabel>
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={autoPacPreset}
                  onChange={(e) => setAutoPacPreset(e.target.value as CorruptPreset)}
                >
                  <option value="valid">Valid</option>
                  <option value="incorrectDelimiter">Incorrect delimiter</option>
                  <option value="noDelimiter">No delimiter</option>
                  <option value="singleColumn">Single column</option>
                  <option value="missingMachine">Missing machine token</option>
                  <option value="machineMismatch">Machine mismatch</option>
                  <option value="truncateHalf">Truncate half</option>
                  <option value="empty">Empty file</option>
                  <option value="randomGarbage">Random garbage</option>
                </select>
              </div>
              <div>
                <FieldLabel>Write Mode</FieldLabel>
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={autoPacWriteMode}
                  onChange={(e) => setAutoPacWriteMode(e.target.value as WriteMode)}
                >
                  <option value="atomic">Atomic (tmp+rename)</option>
                  <option value="direct">Direct</option>
                  <option value="chunked">Chunked</option>
                </select>
              </div>
              <div>
                <FieldLabel>Line Endings</FieldLabel>
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={autoPacLineEnding}
                  onChange={(e) => setAutoPacLineEnding(e.target.value as LineEnding)}
                >
                  <option value="crlf">CRLF</option>
                  <option value="lf">LF</option>
                </select>
              </div>
            </div>

            <div>
              <FieldLabel>File Name</FieldLabel>
              <input
                className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
                value={autoPacFileName}
                onChange={(e) => {
                  setAutoPacDirty(true);
                  setAutoPacFileName(e.target.value);
                }}
              />
            </div>
            <div>
              <FieldLabel>File Contents</FieldLabel>
              <textarea
                className="min-h-36 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
                value={autoPacContent}
                onChange={(e) => {
                  setAutoPacDirty(true);
                  setAutoPacContent(e.target.value);
                }}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    setAutoPacResult(null);
                    const fullPath = await writeFile({
                      target: { kind: 'autoPacCsvDir' },
                      fileName: autoPacFileName,
                      content: autoPacContent,
                      writeMode: autoPacWriteMode,
                      lineEnding: autoPacLineEnding,
                      overwrite: true
                    });
                    setAutoPacResult(`Wrote: ${fullPath}`);
                  } catch (e) {
                    setAutoPacResult(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
                  }
                }}
                disabled={!paths?.autoPacCsvDir}
              >
                Generate
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setAutoPacDirty(false);
                  setAutoPacResult(null);
                }}
                disabled={!paths?.autoPacCsvDir}
              >
                Reset Preview
              </Button>
              {autoPacResult ? <div className="text-xs text-muted-foreground font-mono">{autoPacResult}</div> : null}
            </div>
          </div>
        </Card>

        <Card title="Grundner Folder">
          <div className="space-y-3">
            <div>
              <FieldLabel>Target Folder</FieldLabel>
              <ReadOnlyPath value={paths?.grundnerFolderPath ?? ''} />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <FieldLabel>File Type</FieldLabel>
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={grundnerFileKind}
                  onChange={(e) => setGrundnerFileKind(e.target.value as typeof grundnerFileKind)}
                >
                  <option value="order_saw.csv">order_saw.csv</option>
                  <option value="order_saw.erl">order_saw.erl</option>
                  <option value="ChangeMachNr.csv">ChangeMachNr.csv</option>
                  <option value="ChangeMachNr.erl">ChangeMachNr.erl</option>
                </select>
              </div>
              <div>
                <FieldLabel>Machine Id (for ChangeMachNr)</FieldLabel>
                <input
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={grundnerMachineId}
                  onChange={(e) => setGrundnerMachineId(e.target.value)}
                  placeholder="1"
                />
              </div>
            </div>

            <div>
              <FieldLabel>NC Bases (one per line)</FieldLabel>
              <textarea
                className="min-h-20 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
                value={grundnerBases}
                onChange={(e) => setGrundnerBases(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <FieldLabel>Corruption</FieldLabel>
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={grundnerPreset}
                  onChange={(e) => setGrundnerPreset(e.target.value as CorruptPreset)}
                >
                  <option value="valid">Valid</option>
                  <option value="incorrectDelimiter">Incorrect delimiter</option>
                  <option value="noDelimiter">No delimiter</option>
                  <option value="singleColumn">Single column</option>
                  <option value="truncateHalf">Truncate half</option>
                  <option value="empty">Empty file</option>
                  <option value="randomGarbage">Random garbage</option>
                </select>
              </div>
              <div>
                <FieldLabel>Write Mode</FieldLabel>
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={grundnerWriteMode}
                  onChange={(e) => setGrundnerWriteMode(e.target.value as WriteMode)}
                >
                  <option value="atomic">Atomic (tmp+rename)</option>
                  <option value="direct">Direct</option>
                  <option value="chunked">Chunked</option>
                </select>
              </div>
              <div>
                <FieldLabel>Line Endings</FieldLabel>
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={grundnerLineEnding}
                  onChange={(e) => setGrundnerLineEnding(e.target.value as LineEnding)}
                >
                  <option value="crlf">CRLF</option>
                  <option value="lf">LF</option>
                </select>
              </div>
            </div>

            <div>
              <FieldLabel>File Name</FieldLabel>
              <input
                className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
                value={grundnerFileName}
                onChange={(e) => {
                  setGrundnerDirty(true);
                  setGrundnerFileName(e.target.value);
                }}
              />
            </div>
            <div>
              <FieldLabel>File Contents</FieldLabel>
              <textarea
                className="min-h-36 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
                value={grundnerContent}
                onChange={(e) => {
                  setGrundnerDirty(true);
                  setGrundnerContent(e.target.value);
                }}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    setGrundnerResult(null);
                    const fullPath = await writeFile({
                      target: { kind: 'grundnerFolderPath' },
                      fileName: grundnerFileName,
                      content: grundnerContent,
                      writeMode: grundnerWriteMode,
                      lineEnding: grundnerLineEnding,
                      overwrite: true
                    });
                    setGrundnerResult(`Wrote: ${fullPath}`);
                  } catch (e) {
                    setGrundnerResult(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
                  }
                }}
                disabled={!paths?.grundnerFolderPath}
              >
                Generate
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setGrundnerDirty(false);
                  setGrundnerResult(null);
                }}
                disabled={!paths?.grundnerFolderPath}
              >
                Reset Preview
              </Button>
              {grundnerResult ? <div className="text-xs text-muted-foreground font-mono">{grundnerResult}</div> : null}
            </div>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card title="Machine Ready-To-Run (apJobfolder)">
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <FieldLabel>Machine</FieldLabel>
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={r2rMachineId ?? ''}
                  onChange={(e) => setR2rMachineId(Number(e.target.value))}
                >
                  {machines.map((m) => (
                    <option key={m.machineId} value={m.machineId}>
                      {m.name || `Machine ${m.machineId}`}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <FieldLabel>Target Folder</FieldLabel>
                <ReadOnlyPath value={machines.find((m) => m.machineId === r2rMachineId)?.apJobfolder ?? ''} />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <FieldLabel>Base</FieldLabel>
                <input
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={r2rBase}
                  onChange={(e) => setR2rBase(e.target.value)}
                />
              </div>
              <div>
                <FieldLabel>File Type</FieldLabel>
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={r2rFileKind}
                  onChange={(e) => setR2rFileKind(e.target.value as typeof r2rFileKind)}
                >
                  <option value="base.npt">base.npt</option>
                  <option value="base.nc">base.nc</option>
                  <option value="base.pts">base.pts</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <FieldLabel>Corruption</FieldLabel>
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={r2rPreset}
                  onChange={(e) => setR2rPreset(e.target.value as CorruptPreset)}
                >
                  <option value="valid">Valid</option>
                  <option value="incorrectDelimiter">Incorrect delimiter</option>
                  <option value="noDelimiter">No delimiter</option>
                  <option value="truncateHalf">Truncate half</option>
                  <option value="empty">Empty file</option>
                  <option value="randomGarbage">Random garbage</option>
                </select>
              </div>
              <div>
                <FieldLabel>Write Mode</FieldLabel>
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={r2rWriteMode}
                  onChange={(e) => setR2rWriteMode(e.target.value as WriteMode)}
                >
                  <option value="atomic">Atomic (tmp+rename)</option>
                  <option value="direct">Direct</option>
                  <option value="chunked">Chunked</option>
                </select>
              </div>
              <div>
                <FieldLabel>Line Endings</FieldLabel>
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={r2rLineEnding}
                  onChange={(e) => setR2rLineEnding(e.target.value as LineEnding)}
                >
                  <option value="crlf">CRLF</option>
                  <option value="lf">LF</option>
                </select>
              </div>
            </div>

            <div>
              <FieldLabel>File Name</FieldLabel>
              <input
                className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
                value={r2rFileName}
                onChange={(e) => {
                  setR2rDirty(true);
                  setR2rFileName(e.target.value);
                }}
              />
            </div>
            <div>
              <FieldLabel>File Contents</FieldLabel>
              <textarea
                className="min-h-36 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
                value={r2rContent}
                onChange={(e) => {
                  setR2rDirty(true);
                  setR2rContent(e.target.value);
                }}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    setR2rResult(null);
                    const machineId = r2rMachineId ?? machines[0]?.machineId;
                    if (!machineId) throw new Error('No machine selected');
                    const fullPath = await writeFile({
                      target: { kind: 'machineApJobfolder', machineId },
                      fileName: r2rFileName,
                      content: r2rContent,
                      writeMode: r2rWriteMode,
                      lineEnding: r2rLineEnding,
                      overwrite: true
                    });
                    setR2rResult(`Wrote: ${fullPath}`);
                  } catch (e) {
                    setR2rResult(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
                  }
                }}
                disabled={!machines.length}
              >
                Generate
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setR2rDirty(false);
                  setR2rResult(null);
                }}
                disabled={!machines.length}
              >
                Reset Preview
              </Button>
              {r2rResult ? <div className="text-xs text-muted-foreground font-mono">{r2rResult}</div> : null}
            </div>
          </div>
        </Card>

        <Card title="Machine Nestpick Folder">
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <FieldLabel>Machine</FieldLabel>
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={nestpickMachineId ?? ''}
                  onChange={(e) => setNestpickMachineId(Number(e.target.value))}
                >
                  {machines.map((m) => (
                    <option key={m.machineId} value={m.machineId}>
                      {m.name || `Machine ${m.machineId}`}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <FieldLabel>Target Folder</FieldLabel>
                <ReadOnlyPath value={machines.find((m) => m.machineId === nestpickMachineId)?.nestpickFolder ?? ''} />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <FieldLabel>File Type</FieldLabel>
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={nestpickFileKind}
                  onChange={(e) => setNestpickFileKind(e.target.value as typeof nestpickFileKind)}
                >
                  <option value="Nestpick.erl">Nestpick.erl</option>
                  <option value="Report_FullNestpickUnstack.csv">Report_FullNestpickUnstack.csv</option>
                </select>
              </div>
              <div>
                <FieldLabel>Base</FieldLabel>
                <input
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={nestpickBase}
                  onChange={(e) => setNestpickBase(e.target.value)}
                />
              </div>
            </div>

            {nestpickFileKind === 'Report_FullNestpickUnstack.csv' ? (
              <div>
                <FieldLabel>Pallet Number</FieldLabel>
                <input
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={nestpickPallet}
                  onChange={(e) => setNestpickPallet(e.target.value)}
                />
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <FieldLabel>Corruption</FieldLabel>
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={nestpickPreset}
                  onChange={(e) => setNestpickPreset(e.target.value as CorruptPreset)}
                >
                  <option value="valid">Valid</option>
                  <option value="incorrectDelimiter">Incorrect delimiter</option>
                  <option value="noDelimiter">No delimiter</option>
                  <option value="truncateHalf">Truncate half</option>
                  <option value="empty">Empty file</option>
                  <option value="randomGarbage">Random garbage</option>
                </select>
              </div>
              <div>
                <FieldLabel>Write Mode</FieldLabel>
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={nestpickWriteMode}
                  onChange={(e) => setNestpickWriteMode(e.target.value as WriteMode)}
                >
                  <option value="atomic">Atomic (tmp+rename)</option>
                  <option value="direct">Direct</option>
                  <option value="chunked">Chunked</option>
                </select>
              </div>
              <div>
                <FieldLabel>Line Endings</FieldLabel>
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={nestpickLineEnding}
                  onChange={(e) => setNestpickLineEnding(e.target.value as LineEnding)}
                >
                  <option value="crlf">CRLF</option>
                  <option value="lf">LF</option>
                </select>
              </div>
            </div>

            <div>
              <FieldLabel>File Name</FieldLabel>
              <input
                className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
                value={nestpickFileName}
                onChange={(e) => {
                  setNestpickDirty(true);
                  setNestpickFileName(e.target.value);
                }}
              />
            </div>
            <div>
              <FieldLabel>File Contents</FieldLabel>
              <textarea
                className="min-h-36 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
                value={nestpickContent}
                onChange={(e) => {
                  setNestpickDirty(true);
                  setNestpickContent(e.target.value);
                }}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    setNestpickResult(null);
                    const machineId = nestpickMachineId ?? machines[0]?.machineId;
                    if (!machineId) throw new Error('No machine selected');
                    const fullPath = await writeFile({
                      target: { kind: 'machineNestpickFolder', machineId },
                      fileName: nestpickFileName,
                      content: nestpickContent,
                      writeMode: nestpickWriteMode,
                      lineEnding: nestpickLineEnding,
                      overwrite: true
                    });
                    setNestpickResult(`Wrote: ${fullPath}`);
                  } catch (e) {
                    setNestpickResult(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
                  }
                }}
                disabled={!machines.length}
              >
                Generate
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setNestpickDirty(false);
                  setNestpickResult(null);
                }}
                disabled={!machines.length}
              >
                Reset Preview
              </Button>
              {nestpickResult ? <div className="text-xs text-muted-foreground font-mono">{nestpickResult}</div> : null}
            </div>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card title="Processed Jobs Root: Create Job Folder">
          <div className="space-y-3">
            <div>
              <FieldLabel>Target Folder</FieldLabel>
              <ReadOnlyPath value={paths?.processedJobsRoot ?? ''} />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <FieldLabel>Job Folder Name</FieldLabel>
                <input
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={jobFolderName}
                  onChange={(e) => setJobFolderName(e.target.value)}
                />
              </div>
              <div>
                <FieldLabel>Base Name</FieldLabel>
                <input
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={jobBase}
                  onChange={(e) => setJobBase(e.target.value)}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={jobIncludeNpt} onChange={(e) => setJobIncludeNpt(e.target.checked)} />
                Include <span className="font-mono">.npt</span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={jobIncludePts} onChange={(e) => setJobIncludePts(e.target.checked)} />
                Include <span className="font-mono">.pts</span>
              </label>
              <div className="min-w-[220px]">
                <FieldLabel>Corruption</FieldLabel>
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={jobPreset}
                  onChange={(e) => setJobPreset(e.target.value as CorruptPreset)}
                >
                  <option value="valid">Valid</option>
                  <option value="truncateHalf">Truncate half</option>
                  <option value="empty">Empty (NC file empty)</option>
                  <option value="randomGarbage">Random garbage</option>
                </select>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    setJobResult(null);
                    const folder = jobFolderName.trim();
                    const base = jobBase.trim();
                    if (!folder) throw new Error('Job folder name required');
                    if (!base) throw new Error('Base name required');

                    const ncGood = `; minimal test NC\r\nID=TEST\r\nG100 X2400 Y1200 Z18\r\n`;
                    const ncContent = applyCorruption(ncGood, jobPreset);

                    const created: string[] = [];

                    created.push(
                      await writeFile({
                        target: { kind: 'processedJobsRoot' },
                        relativeDir: folder,
                        fileName: `${base}.nc`,
                        content: ncContent,
                        writeMode: 'atomic',
                        lineEnding: 'crlf',
                        overwrite: true
                      })
                    );

                    if (jobIncludeNpt) {
                      const nptGood = `Job;Destination;SourceMachine;\r\n${base};99;1;\r\n`;
                      created.push(
                        await writeFile({
                          target: { kind: 'processedJobsRoot' },
                          relativeDir: folder,
                          fileName: `${base}.npt`,
                          content: nptGood,
                          writeMode: 'atomic',
                          lineEnding: 'crlf',
                          overwrite: true
                        })
                      );
                    }

                    if (jobIncludePts) {
                      const ptsGood = `PART-001\r\nPART-002\r\n`;
                      created.push(
                        await writeFile({
                          target: { kind: 'processedJobsRoot' },
                          relativeDir: folder,
                          fileName: `${base}.pts`,
                          content: ptsGood,
                          writeMode: 'atomic',
                          lineEnding: 'crlf',
                          overwrite: true
                        })
                      );
                    }

                    setJobResult(`Created ${created.length} file(s): ${created.join(', ')}`);
                  } catch (e) {
                    setJobResult(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
                  }
                }}
                disabled={!paths?.processedJobsRoot}
              >
                Create Job Folder
              </Button>
              {jobResult ? <div className="text-xs text-muted-foreground font-mono">{jobResult}</div> : null}
            </div>
          </div>
        </Card>

        <div className="space-y-4">
          <GenericFolderWriter
            title="Jobs Root"
            folderPath={paths?.jobsRoot ?? ''}
            targetKind="jobsRoot"
            writeFile={writeFile}
          />
          <GenericFolderWriter
            title="Archive Root"
            folderPath={paths?.archiveRoot ?? ''}
            targetKind="archiveRoot"
            writeFile={writeFile}
          />
          <GenericFolderWriter
            title="Quarantine Root"
            folderPath={paths?.quarantineRoot ?? ''}
            targetKind="quarantineRoot"
            writeFile={writeFile}
          />
          <GenericFolderWriter
            title="Test Data Folder"
            folderPath={settings?.test?.testDataFolderPath ?? ''}
            targetKind="testDataFolderPath"
            writeFile={writeFile}
          />
        </div>
      </div>
    </div>
  );
}
