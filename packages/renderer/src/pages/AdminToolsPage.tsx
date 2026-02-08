/* eslint-disable react/prop-types */
import React, { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { Machine, Settings } from '../../../shared/src';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/utils/cn';
import { useAuth } from '@/contexts/AuthContext';
import { AlertTriangle, FileText, Folder, Server, Settings as SettingsIcon, Wrench } from 'lucide-react';

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

const ADMIN_TOOLS_CACHE_KEY = 'nestwatcher.adminTools.cache.v1';

type AdminToolsCacheV1 = {
  version: 1;
  autoPac: {
    type: 'load_finish' | 'label_finish' | 'cnc_finish';
    machineToken: string;
    bases: string;
    preset: CorruptPreset;
    writeMode: WriteMode;
    lineEnding: LineEnding;
    fileName: string;
    content: string;
    dirty: boolean;
  };
  grundner: {
    fileKind:
      | 'order_saw.csv'
      | 'order_saw.erl'
      | 'ChangeMachNr.csv'
      | 'ChangeMachNr.erl'
      | 'get_production.erl'
      | 'get_production.csv'
      | 'productionLIST_del.csv';
    bases: string;
    machineId: string;
    preset: CorruptPreset;
    writeMode: WriteMode;
    lineEnding: LineEnding;
    fileName: string;
    content: string;
    dirty: boolean;
  };
  nestpick: {
    machineId: number | null;
    fileKind: 'Nestpick.erl' | 'Report_FullNestpickUnstack.csv';
    base: string;
    pallet: string;
    preset: CorruptPreset;
    writeMode: WriteMode;
    lineEnding: LineEnding;
    fileName: string;
    content: string;
    dirty: boolean;
  };
  r2r: {
    machineId: number | null;
    fileKind: 'base.nsp' | 'base.npt' | 'base.nc' | 'base.pts';
    base: string;
    preset: CorruptPreset;
    writeMode: WriteMode;
    lineEnding: LineEnding;
    fileName: string;
    content: string;
    dirty: boolean;
  };
  processedJobs: {
    folderName: string;
    base: string;
    includeNpt: boolean;
    includePts: boolean;
    preset: CorruptPreset;
  };
};

function readAdminToolsCache(): AdminToolsCacheV1 | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const raw = window.localStorage.getItem(ADMIN_TOOLS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AdminToolsCacheV1>;
    if (!parsed || parsed.version !== 1) return null;
    return parsed as AdminToolsCacheV1;
  } catch {
    return null;
  }
}

function applyCorruption(content: string, preset: CorruptPreset, options?: { wrongMachineToken?: string }): string {
  switch (preset) {
    case 'valid':
      return content;
    case 'incorrectDelimiter':
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

/* ─────────────────────────────────────────────────────────────────────────────
   Styled Form Components
   ───────────────────────────────────────────────────────────────────────────── */

function FieldLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('text-xs font-medium text-muted-foreground', className)}>
      {children}
    </span>
  );
}

function FormGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-col gap-1.5', className)}>{children}</div>;
}

function ReadOnlyPath({ value }: { value: string }) {
  const ok = Boolean(value && value.trim());
  return (
    <input
      className={cn(
        'w-full h-9 rounded-md bg-muted/50 px-3 py-2 text-sm font-medium',
        ok ? 'text-foreground' : 'border-destructive/50 text-muted-foreground'
      )}
      value={value || ''}
      readOnly
      placeholder="Not configured"
    />
  );
}

function FormInput({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'w-full h-9 rounded-md bg-card px-3 py-2 text-sm font-medium',
        'focus:outline-none focus:ring-2 focus:ring-ring/40',
        'transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
        className
      )}
      {...props}
    />
  );
}

function FormSelect({
  className,
  children,
  value,
  onChange,
  disabled,
}: React.SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  // Extract options from children (expecting <option> elements)
  const options: { value: string; label: string }[] = [];
  React.Children.forEach(children, (child) => {
    if (React.isValidElement(child) && child.type === 'option') {
      options.push({
        value: String(child.props.value ?? ''),
        label: String(child.props.children ?? ''),
      });
    }
  });

  return (
    <Select
      value={String(value ?? '')}
      onValueChange={(v) => {
        if (onChange) {
          const syntheticEvent = {
            target: { value: v },
          } as React.ChangeEvent<HTMLSelectElement>;
          onChange(syntheticEvent);
        }
      }}
      disabled={disabled}
    >
      <SelectTrigger className={cn('w-full', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function FormTextarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        'w-full min-h-[7rem] rounded-md bg-card px-3 py-2 text-sm font-medium',
        'focus:outline-none focus:ring-2 focus:ring-ring/40',
        'transition-colors resize-y disabled:opacity-50 disabled:cursor-not-allowed',
        className
      )}
      {...props}
    />
  );
}

function ResultMessage({ children }: { children: ReactNode }) {
  return <span className="text-xs text-muted-foreground font-medium">{children}</span>;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Panel Components
   ───────────────────────────────────────────────────────────────────────────── */

function SectionCard({
  title,
  icon: Icon,
  children,
  className
}: {
  title: string;
  icon?: React.ComponentType<{ className?: string }>;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2.5 text-base font-semibold">
          {Icon && <Icon className="size-4 text-muted-foreground" />}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

function GenericFolderWriter(props: {
  title: string;
  folderPath: string;
  targetKind: 'jobsRoot' | 'archiveRoot' | 'quarantineRoot' | 'testDataFolderPath';
  writeFile: (input: Parameters<typeof window.api.adminTools.writeFile>[0]) => Promise<string>;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  const { title, folderPath, targetKind, writeFile, icon: Icon } = props;
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
    <SectionCard title={title} icon={Icon}>
      <FormGroup>
        <FieldLabel>Target Folder</FieldLabel>
        <ReadOnlyPath value={folderPath} />
      </FormGroup>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormGroup>
          <FieldLabel>Relative Subfolder</FieldLabel>
          <FormInput
            value={relativeDir}
            onChange={(e) => setRelativeDir(e.target.value)}
            placeholder="optional/subfolder"
            disabled={!configured}
          />
        </FormGroup>
        <FormGroup>
          <FieldLabel>File Name</FieldLabel>
          <FormInput
            value={fileName}
            onChange={(e) => setFileName(e.target.value)}
            disabled={!configured}
          />
        </FormGroup>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <FormGroup>
          <FieldLabel>Corruption</FieldLabel>
          <FormSelect
            value={preset}
            onChange={(e) => setPreset(e.target.value as CorruptPreset)}
            disabled={!configured}
          >
            <option value="valid">Valid</option>
            <option value="truncateHalf">Truncate half</option>
            <option value="empty">Empty file</option>
            <option value="randomGarbage">Random garbage</option>
          </FormSelect>
        </FormGroup>
        <FormGroup>
          <FieldLabel>Write Mode</FieldLabel>
          <FormSelect
            value={writeMode}
            onChange={(e) => setWriteMode(e.target.value as WriteMode)}
            disabled={!configured}
          >
            <option value="atomic">Atomic (tmp+rename)</option>
            <option value="direct">Direct</option>
            <option value="chunked">Chunked</option>
          </FormSelect>
        </FormGroup>
        <FormGroup>
          <FieldLabel>Line Endings</FieldLabel>
          <FormSelect
            value={lineEnding}
            onChange={(e) => setLineEnding(e.target.value as LineEnding)}
            disabled={!configured}
          >
            <option value="crlf">CRLF</option>
            <option value="lf">LF</option>
          </FormSelect>
        </FormGroup>
      </div>

      <FormGroup>
        <FieldLabel>File Contents</FieldLabel>
        <FormTextarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          disabled={!configured}
        />
      </FormGroup>

      <div className="flex flex-wrap items-center gap-3 pt-2">
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
        {result && <ResultMessage>{result}</ResultMessage>}
      </div>
    </SectionCard>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   Main Page Component
   ───────────────────────────────────────────────────────────────────────────── */

export function AdminToolsPage() {
  const { session } = useAuth();

  const cacheHydratedRef = useRef(false);
  const cacheLatestRef = useRef<AdminToolsCacheV1 | null>(null);
  const lastCacheRawRef = useRef<string | null>(null);
  const [cacheStatus, setCacheStatus] = useState<string | null>(null);

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
  const [grundnerFileKind, setGrundnerFileKind] = useState<
    | 'order_saw.csv'
    | 'order_saw.erl'
    | 'ChangeMachNr.csv'
    | 'ChangeMachNr.erl'
    | 'get_production.erl'
    | 'get_production.csv'
    | 'productionLIST_del.csv'
  >(
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
  const [r2rFileKind, setR2rFileKind] = useState<'base.nsp' | 'base.npt' | 'base.nc' | 'base.pts'>('base.nsp');
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

  const applyCachedInputs = useCallback((cached: AdminToolsCacheV1) => {
    setAutoPacType(cached.autoPac?.type ?? 'cnc_finish');
    setAutoPacMachineToken(cached.autoPac?.machineToken ?? 'WT1');
    setAutoPacBases(cached.autoPac?.bases ?? '');
    setAutoPacPreset(cached.autoPac?.preset ?? 'valid');
    setAutoPacWriteMode(cached.autoPac?.writeMode ?? 'atomic');
    setAutoPacLineEnding(cached.autoPac?.lineEnding ?? 'crlf');
    setAutoPacFileName(cached.autoPac?.fileName ?? '');
    setAutoPacContent(cached.autoPac?.content ?? '');
    setAutoPacDirty(Boolean(cached.autoPac?.dirty) || Boolean(cached.autoPac?.fileName) || Boolean(cached.autoPac?.content));

    setGrundnerFileKind(cached.grundner?.fileKind ?? 'order_saw.csv');
    setGrundnerBases(cached.grundner?.bases ?? '');
    setGrundnerMachineId(cached.grundner?.machineId ?? '1');
    setGrundnerPreset(cached.grundner?.preset ?? 'valid');
    setGrundnerWriteMode(cached.grundner?.writeMode ?? 'atomic');
    setGrundnerLineEnding(cached.grundner?.lineEnding ?? 'crlf');
    setGrundnerFileName(cached.grundner?.fileName ?? '');
    setGrundnerContent(cached.grundner?.content ?? '');
    setGrundnerDirty(Boolean(cached.grundner?.dirty) || Boolean(cached.grundner?.fileName) || Boolean(cached.grundner?.content));

    setNestpickMachineId(cached.nestpick?.machineId ?? null);
    setNestpickFileKind(cached.nestpick?.fileKind ?? 'Nestpick.erl');
    setNestpickBase(cached.nestpick?.base ?? '');
    setNestpickPallet(cached.nestpick?.pallet ?? '');
    setNestpickPreset(cached.nestpick?.preset ?? 'valid');
    setNestpickWriteMode(cached.nestpick?.writeMode ?? 'atomic');
    setNestpickLineEnding(cached.nestpick?.lineEnding ?? 'crlf');
    setNestpickFileName(cached.nestpick?.fileName ?? '');
    setNestpickContent(cached.nestpick?.content ?? '');
    setNestpickDirty(Boolean(cached.nestpick?.dirty) || Boolean(cached.nestpick?.fileName) || Boolean(cached.nestpick?.content));

    setR2rMachineId(cached.r2r?.machineId ?? null);
    setR2rFileKind(cached.r2r?.fileKind ?? 'base.nsp');
    setR2rBase(cached.r2r?.base ?? '');
    setR2rPreset(cached.r2r?.preset ?? 'valid');
    setR2rWriteMode(cached.r2r?.writeMode ?? 'atomic');
    setR2rLineEnding(cached.r2r?.lineEnding ?? 'crlf');
    setR2rFileName(cached.r2r?.fileName ?? '');
    setR2rContent(cached.r2r?.content ?? '');
    setR2rDirty(Boolean(cached.r2r?.dirty) || Boolean(cached.r2r?.fileName) || Boolean(cached.r2r?.content));

    setJobFolderName(cached.processedJobs?.folderName ?? '');
    setJobBase(cached.processedJobs?.base ?? '');
    setJobIncludeNpt(cached.processedJobs?.includeNpt ?? true);
    setJobIncludePts(cached.processedJobs?.includePts ?? false);
    setJobPreset(cached.processedJobs?.preset ?? 'valid');
  }, []);

  // Restore Admin Tools inputs from localStorage
  useEffect(() => {
    try {
      lastCacheRawRef.current = window.localStorage.getItem(ADMIN_TOOLS_CACHE_KEY);
    } catch {
      lastCacheRawRef.current = null;
    }

    const cached = readAdminToolsCache();
    if (cached) {
      applyCachedInputs(cached);
    }

    cacheHydratedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyCachedInputs]);

  // Sync Admin Tools inputs across windows.
  // Why: the Admin Tools page persists to localStorage, but React state doesn't automatically
  // refresh unless we listen for the browser-level `storage` event.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== ADMIN_TOOLS_CACHE_KEY) return;
      if (!e.newValue) return;

      lastCacheRawRef.current = e.newValue;

      try {
        const parsed = JSON.parse(e.newValue) as Partial<AdminToolsCacheV1>;
        if (!parsed || parsed.version !== 1) return;
        applyCachedInputs(parsed as AdminToolsCacheV1);
        setCacheStatus(`Synced ${new Date().toLocaleTimeString()}`);
      } catch {
        // ignore
      }
    };

    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
    };
  }, [applyCachedInputs]);

  // Persist all panel inputs immediately.
  // Why: you may navigate away quickly, so debounced writes can be lost.
  const buildCacheSnapshot = useCallback((): AdminToolsCacheV1 => {
    return {
      version: 1,
      autoPac: {
        type: autoPacType,
        machineToken: autoPacMachineToken,
        bases: autoPacBases,
        preset: autoPacPreset,
        writeMode: autoPacWriteMode,
        lineEnding: autoPacLineEnding,
        fileName: autoPacFileName,
        content: autoPacContent,
        dirty: autoPacDirty
      },
      grundner: {
        fileKind: grundnerFileKind,
        bases: grundnerBases,
        machineId: grundnerMachineId,
        preset: grundnerPreset,
        writeMode: grundnerWriteMode,
        lineEnding: grundnerLineEnding,
        fileName: grundnerFileName,
        content: grundnerContent,
        dirty: grundnerDirty
      },
      nestpick: {
        machineId: nestpickMachineId,
        fileKind: nestpickFileKind,
        base: nestpickBase,
        pallet: nestpickPallet,
        preset: nestpickPreset,
        writeMode: nestpickWriteMode,
        lineEnding: nestpickLineEnding,
        fileName: nestpickFileName,
        content: nestpickContent,
        dirty: nestpickDirty
      },
      r2r: {
        machineId: r2rMachineId,
        fileKind: r2rFileKind,
        base: r2rBase,
        preset: r2rPreset,
        writeMode: r2rWriteMode,
        lineEnding: r2rLineEnding,
        fileName: r2rFileName,
        content: r2rContent,
        dirty: r2rDirty
      },
      processedJobs: {
        folderName: jobFolderName,
        base: jobBase,
        includeNpt: jobIncludeNpt,
        includePts: jobIncludePts,
        preset: jobPreset
      }
    };
  }, [
    autoPacBases,
    autoPacContent,
    autoPacDirty,
    autoPacFileName,
    autoPacLineEnding,
    autoPacMachineToken,
    autoPacPreset,
    autoPacType,
    autoPacWriteMode,
    grundnerBases,
    grundnerContent,
    grundnerDirty,
    grundnerFileKind,
    grundnerFileName,
    grundnerLineEnding,
    grundnerMachineId,
    grundnerPreset,
    grundnerWriteMode,
    jobBase,
    jobFolderName,
    jobIncludeNpt,
    jobIncludePts,
    jobPreset,
    nestpickBase,
    nestpickContent,
    nestpickDirty,
    nestpickFileKind,
    nestpickFileName,
    nestpickLineEnding,
    nestpickMachineId,
    nestpickPallet,
    nestpickPreset,
    nestpickWriteMode,
    r2rBase,
    r2rContent,
    r2rDirty,
    r2rFileKind,
    r2rFileName,
    r2rLineEnding,
    r2rMachineId,
    r2rPreset,
    r2rWriteMode
  ]);

  // Keep a live snapshot for unmount/beforeunload flush.
  cacheLatestRef.current = buildCacheSnapshot();

  const flushCacheNow = useCallback(() => {
    if (!cacheLatestRef.current) return;
    try {
      if (typeof window === 'undefined' || !window.localStorage) return;
      const nextRaw = JSON.stringify(cacheLatestRef.current);

      // Avoid redundant writes (and avoid storage-event loops between windows).
      const existing = window.localStorage.getItem(ADMIN_TOOLS_CACHE_KEY);
      if (existing === nextRaw) {
        lastCacheRawRef.current = nextRaw;
        return;
      }

      if (lastCacheRawRef.current === nextRaw) {
        return;
      }

      lastCacheRawRef.current = nextRaw;
      window.localStorage.setItem(ADMIN_TOOLS_CACHE_KEY, nextRaw);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    flushCacheNow();
    setCacheStatus(`Saved ${new Date().toLocaleTimeString()}`);
  }, [flushCacheNow, buildCacheSnapshot]);

  useEffect(() => {
    const onBeforeUnload = () => flushCacheNow();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      // Also flush when navigating within the SPA and this component unmounts.
      flushCacheNow();
    };
  }, [flushCacheNow]);

  // Note: buildCacheSnapshot's dependency list drives persistence.

  // AutoPAC preview generator
  useEffect(() => {
    if (!cacheHydratedRef.current) return;
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
    if (!cacheHydratedRef.current) return;
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
        case 'get_production.erl':
        case 'get_production.csv': {
          const deleteMachineId = 0;
          return (
            bases
              .map((b) => {
                const trimmed = b.trim();
                const noNc = trimmed.toLowerCase().endsWith('.nc') ? trimmed.slice(0, -3) : trimmed;
                return `${noNc};${deleteMachineId};`;
              })
              .join('\r\n') +
            (bases.length ? '\r\n' : '')
          );
        }
        case 'productionLIST_del.csv': {
          return (
            bases
              .map((b) => {
                const name = b.toLowerCase().endsWith('.nc') ? b : `${b}.nc`;
                return `${name};0;`;
              })
              .join('\r\n') +
            (bases.length ? '\r\n' : '')
          );
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
    if (!cacheHydratedRef.current) return;
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
    if (!cacheHydratedRef.current) return;
    const machineId = r2rMachineId ?? machines[0]?.machineId ?? 1;
    const base = r2rBase.trim() || 'TEST 001';

    const good = (() => {
      switch (r2rFileKind) {
        case 'base.nsp':
          return `Job;Destination;SourceMachine;\r\n${base};99;${machineId};\r\n`;
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

  /* ───────────────────────────────────────────────────────────────────────────
     Not Allowed State
     ─────────────────────────────────────────────────────────────────────────── */
  if (!allowed) {
    return (
      <div className="p-6 max-w-4xl">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Admin Tools</h1>
          <p className="text-sm text-muted-foreground mt-1">File fuzzer for testing watched folders</p>
        </div>
        <Card>
          <CardContent className="py-8">
            <div className="flex items-center gap-3 text-destructive">
              <AlertTriangle className="size-5" />
              <span className="text-sm font-medium">
                This page is only available when signed in as username <strong>admin</strong>.
              </span>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  /* ───────────────────────────────────────────────────────────────────────────
     Main Render
     ─────────────────────────────────────────────────────────────────────────── */
  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Page Header */}
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Admin Tools</h1>
          {cacheStatus ? <div className="text-xs text-muted-foreground mt-1">{cacheStatus}</div> : null}
        </div>

        {/* Test Mode Toggle */}
        <label className="flex items-center gap-2 cursor-pointer shrink-0">
          <input
            type="checkbox"
            className="custom-checkbox"
            checked={!!settings?.test?.disableErlTimeouts}
            onChange={async (e) => {
              if (!settings) return;
              const next = {
                test: {
                  ...settings.test,
                  disableErlTimeouts: e.target.checked
                }
              };
              const res = await window.api.settings.save(next);
              if (res.ok) {
                setSettings(res.value);
              } else {
                alert(`Failed to save setting: ${res.error.message}`);
              }
            }}
            disabled={!settings}
          />
          <span className="text-base font-medium text-foreground">Disable .erl timeouts</span>
        </label>
      </header>

      {/* Loading / Error States */}
      {loading && (
        <div className="text-sm text-muted-foreground">Loading settings...</div>
      )}
      {loadError && (
        <div className="text-sm text-destructive">Failed to load: {loadError}</div>
      )}

      {/* Main Two-Column Layout */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {/* LEFT COLUMN: Grundner, AutoPAC, Ready-To-Run, Processed Jobs, Test Data */}
        <div className="flex flex-col gap-6">
          {/* Grundner Panel */}
          <SectionCard title="Grundner Folder" icon={Folder}>
            <FormGroup>
              <FieldLabel>Target Folder</FieldLabel>
              <ReadOnlyPath value={paths?.grundnerFolderPath ?? ''} />
            </FormGroup>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormGroup>
                <FieldLabel>File Type</FieldLabel>
                <FormSelect
                  value={grundnerFileKind}
                  onChange={(e) => {
                    const next = e.target.value as typeof grundnerFileKind;
                    // Switching file types should reset the filename + content to match the template.
                    setGrundnerDirty(false);
                    setGrundnerResult(null);
                    setGrundnerFileName(next);
                    setGrundnerContent('');
                    setGrundnerFileKind(next);
                  }}
                >
                  <option value="order_saw.csv">order_saw.csv</option>
                  <option value="order_saw.erl">order_saw.erl</option>
                  <option value="ChangeMachNr.csv">ChangeMachNr.csv</option>
                  <option value="ChangeMachNr.erl">ChangeMachNr.erl</option>
                  <option value="get_production.csv">get_production.csv</option>
                  <option value="get_production.erl">get_production.erl</option>
                  <option value="productionLIST_del.csv">productionLIST_del.csv</option>
                </FormSelect>
              </FormGroup>
              <FormGroup>
                <FieldLabel>Machine Id (for ChangeMachNr)</FieldLabel>
                <FormInput
                  value={grundnerMachineId}
                  onChange={(e) => setGrundnerMachineId(e.target.value)}
                  placeholder="1"
                />
              </FormGroup>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <FormGroup>
                <FieldLabel>Corruption</FieldLabel>
                <FormSelect
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
                </FormSelect>
              </FormGroup>
              <FormGroup>
                <FieldLabel>Write Mode</FieldLabel>
                <FormSelect
                  value={grundnerWriteMode}
                  onChange={(e) => setGrundnerWriteMode(e.target.value as WriteMode)}
                >
                  <option value="atomic">Atomic (tmp+rename)</option>
                  <option value="direct">Direct</option>
                  <option value="chunked">Chunked</option>
                </FormSelect>
              </FormGroup>
              <FormGroup>
                <FieldLabel>Line Endings</FieldLabel>
                <FormSelect
                  value={grundnerLineEnding}
                  onChange={(e) => setGrundnerLineEnding(e.target.value as LineEnding)}
                >
                  <option value="crlf">CRLF</option>
                  <option value="lf">LF</option>
                </FormSelect>
              </FormGroup>
            </div>

            <FormGroup>
              <FieldLabel>File Name</FieldLabel>
              <FormInput
                value={grundnerFileName}
                onChange={(e) => {
                  setGrundnerDirty(true);
                  setGrundnerFileName(e.target.value);
                }}
              />
            </FormGroup>

            <FormGroup>
              <FieldLabel>File Contents</FieldLabel>
              <FormTextarea
                value={grundnerContent}
                onChange={(e) => {
                  setGrundnerDirty(true);
                  setGrundnerContent(e.target.value);
                }}
              />
            </FormGroup>

            <div className="flex flex-wrap items-center gap-3 pt-2">
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

                    const wroteErl = grundnerFileName.trim().toLowerCase().endsWith('.erl');
                    const shouldCleanup = wroteErl && Boolean(settings?.test?.disableErlTimeouts);
                    if (!shouldCleanup) {
                      setGrundnerResult(`Wrote: ${fullPath}`);
                      return;
                    }

                    const cleanupRes = await window.api.adminTools.cleanupTestCsv({
                      target: { kind: 'grundnerFolderPath' }
                    });
                    if (!cleanupRes.ok) {
                      setGrundnerResult(`Wrote: ${fullPath} | Cleanup ERROR: ${cleanupRes.error.message}`);
                      return;
                    }

                    const { deleted, missing, failed } = cleanupRes.value;
                    const detail = failed.length ? ` (failed: ${failed[0].file})` : '';
                    setGrundnerResult(
                      `Wrote: ${fullPath} | Cleaned CSV: deleted ${deleted.length}, missing ${missing.length}, failed ${failed.length}${detail}`
                    );
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
              {grundnerResult && <ResultMessage>{grundnerResult}</ResultMessage>}
            </div>
          </SectionCard>

          {/* AutoPAC CSV Panel */}
          <SectionCard title="AutoPAC CSV Directory" icon={FileText}>
          <FormGroup>
            <FieldLabel>Target Folder</FieldLabel>
            <ReadOnlyPath value={paths?.autoPacCsvDir ?? ''} />
          </FormGroup>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormGroup>
              <FieldLabel>CSV Type</FieldLabel>
              <FormSelect
                value={autoPacType}
                onChange={(e) => {
                  const next = e.target.value as typeof autoPacType;
                  setAutoPacDirty(false);
                  setAutoPacResult(null);
                  setAutoPacFileName('');
                  setAutoPacContent('');
                  setAutoPacType(next);
                }}
              >
                <option value="load_finish">load_finish</option>
                <option value="label_finish">label_finish</option>
                <option value="cnc_finish">cnc_finish</option>
              </FormSelect>
            </FormGroup>
            <FormGroup>
              <FieldLabel>Machine Token</FieldLabel>
              <FormInput
                value={autoPacMachineToken}
                onChange={(e) => setAutoPacMachineToken(e.target.value)}
                placeholder="WT1"
              />
            </FormGroup>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <FormGroup>
              <FieldLabel>Corruption</FieldLabel>
              <FormSelect
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
              </FormSelect>
            </FormGroup>
            <FormGroup>
              <FieldLabel>Write Mode</FieldLabel>
              <FormSelect
                value={autoPacWriteMode}
                onChange={(e) => setAutoPacWriteMode(e.target.value as WriteMode)}
              >
                <option value="atomic">Atomic (tmp+rename)</option>
                <option value="direct">Direct</option>
                <option value="chunked">Chunked</option>
              </FormSelect>
            </FormGroup>
            <FormGroup>
              <FieldLabel>Line Endings</FieldLabel>
              <FormSelect
                value={autoPacLineEnding}
                onChange={(e) => setAutoPacLineEnding(e.target.value as LineEnding)}
              >
                <option value="crlf">CRLF</option>
                <option value="lf">LF</option>
              </FormSelect>
            </FormGroup>
          </div>

          <FormGroup>
            <FieldLabel>File Name</FieldLabel>
            <FormInput
              value={autoPacFileName}
              onChange={(e) => {
                setAutoPacDirty(true);
                setAutoPacFileName(e.target.value);
              }}
            />
          </FormGroup>

          <FormGroup>
            <FieldLabel>File Contents</FieldLabel>
            <FormTextarea
              value={autoPacContent}
              onChange={(e) => {
                setAutoPacDirty(true);
                setAutoPacContent(e.target.value);
              }}
            />
          </FormGroup>

          <div className="flex flex-wrap items-center gap-3 pt-2">
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
            {autoPacResult && <ResultMessage>{autoPacResult}</ResultMessage>}
          </div>
        </SectionCard>

          {/* Ready-To-Run Panel */}
          <SectionCard title="Machine Ready-To-Run (apJobfolder)" icon={Server}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormGroup>
              <FieldLabel>Machine</FieldLabel>
              <FormSelect
                value={r2rMachineId ?? ''}
                onChange={(e) => setR2rMachineId(Number(e.target.value))}
              >
                {machines.map((m) => (
                  <option key={m.machineId} value={m.machineId}>
                    {m.name || `Machine ${m.machineId}`}
                  </option>
                ))}
              </FormSelect>
            </FormGroup>
            <FormGroup>
              <FieldLabel>Target Folder</FieldLabel>
              <ReadOnlyPath value={machines.find((m) => m.machineId === r2rMachineId)?.apJobfolder ?? ''} />
            </FormGroup>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormGroup>
              <FieldLabel>Base</FieldLabel>
              <FormInput
                value={r2rBase}
                onChange={(e) => setR2rBase(e.target.value)}
              />
            </FormGroup>
            <FormGroup>
              <FieldLabel>File Type</FieldLabel>
              <FormSelect
                value={r2rFileKind}
                onChange={(e) => {
                  const next = e.target.value as typeof r2rFileKind;
                  setR2rDirty(false);
                  setR2rResult(null);
                  setR2rFileName('');
                  setR2rContent('');
                  setR2rFileKind(next);
                }}
              >
                <option value="base.nsp">base.nsp</option>
                <option value="base.npt">base.npt legacy</option>
                <option value="base.nc">base.nc</option>
                <option value="base.pts">base.pts</option>
              </FormSelect>
            </FormGroup>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <FormGroup>
              <FieldLabel>Corruption</FieldLabel>
              <FormSelect
                value={r2rPreset}
                onChange={(e) => setR2rPreset(e.target.value as CorruptPreset)}
              >
                <option value="valid">Valid</option>
                <option value="incorrectDelimiter">Incorrect delimiter</option>
                <option value="noDelimiter">No delimiter</option>
                <option value="truncateHalf">Truncate half</option>
                <option value="empty">Empty file</option>
                <option value="randomGarbage">Random garbage</option>
              </FormSelect>
            </FormGroup>
            <FormGroup>
              <FieldLabel>Write Mode</FieldLabel>
              <FormSelect
                value={r2rWriteMode}
                onChange={(e) => setR2rWriteMode(e.target.value as WriteMode)}
              >
                <option value="atomic">Atomic (tmp+rename)</option>
                <option value="direct">Direct</option>
                <option value="chunked">Chunked</option>
              </FormSelect>
            </FormGroup>
            <FormGroup>
              <FieldLabel>Line Endings</FieldLabel>
              <FormSelect
                value={r2rLineEnding}
                onChange={(e) => setR2rLineEnding(e.target.value as LineEnding)}
              >
                <option value="crlf">CRLF</option>
                <option value="lf">LF</option>
              </FormSelect>
            </FormGroup>
          </div>

          <FormGroup>
            <FieldLabel>File Name</FieldLabel>
            <FormInput
              value={r2rFileName}
              onChange={(e) => {
                setR2rDirty(true);
                setR2rFileName(e.target.value);
              }}
            />
          </FormGroup>

          <FormGroup>
            <FieldLabel>File Contents</FieldLabel>
            <FormTextarea
              value={r2rContent}
              onChange={(e) => {
                setR2rDirty(true);
                setR2rContent(e.target.value);
              }}
            />
          </FormGroup>

          <div className="flex flex-wrap items-center gap-3 pt-2">
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
            {r2rResult && <ResultMessage>{r2rResult}</ResultMessage>}
          </div>
        </SectionCard>

          {/* Processed Jobs - Job Folder Builder */}
          <SectionCard title="Processed Jobs Root: Create Job Folder" icon={Wrench}>
            <FormGroup>
              <FieldLabel>Target Folder</FieldLabel>
              <ReadOnlyPath value={paths?.processedJobsRoot ?? ''} />
            </FormGroup>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormGroup>
                <FieldLabel>Job Folder Name</FieldLabel>
                <FormInput
                  value={jobFolderName}
                  onChange={(e) => setJobFolderName(e.target.value)}
                />
              </FormGroup>
              <FormGroup>
                <FieldLabel>Base Name</FieldLabel>
                <FormInput
                  value={jobBase}
                  onChange={(e) => setJobBase(e.target.value)}
                />
              </FormGroup>
            </div>

            <div className="flex flex-wrap items-center gap-6">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  className="custom-checkbox"
                  checked={jobIncludeNpt}
                  onChange={(e) => setJobIncludeNpt(e.target.checked)}
                />
                <span>Include Nestpick payload .nsp</span>
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  className="custom-checkbox"
                  checked={jobIncludePts}
                  onChange={(e) => setJobIncludePts(e.target.checked)}
                />
                <span>Include .pts</span>
              </label>
              <FormGroup className="flex-1 min-w-[180px]">
                <FieldLabel>Corruption</FieldLabel>
                <FormSelect
                  value={jobPreset}
                  onChange={(e) => setJobPreset(e.target.value as CorruptPreset)}
                >
                  <option value="valid">Valid</option>
                  <option value="truncateHalf">Truncate half</option>
                  <option value="empty">Empty (NC file empty)</option>
                  <option value="randomGarbage">Random garbage</option>
                </FormSelect>
              </FormGroup>
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-2">
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
                      const nspGood = `Job;Destination;SourceMachine;\r\n${base};99;1;\r\n`;
                      created.push(
                        await writeFile({
                          target: { kind: 'processedJobsRoot' },
                          relativeDir: folder,
                          fileName: `${base}.nsp`,
                          content: nspGood,
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

                    setJobResult(`Created ${created.length} file(s)`);
                  } catch (e) {
                    setJobResult(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
                  }
                }}
                disabled={!paths?.processedJobsRoot}
              >
                Create Job Folder
              </Button>
              {jobResult && <ResultMessage>{jobResult}</ResultMessage>}
            </div>
          </SectionCard>

          {/* Test Data Folder */}
          <GenericFolderWriter
            title="Test Data Folder"
            icon={Folder}
            folderPath={settings?.test?.testDataFolderPath ?? ''}
            targetKind="testDataFolderPath"
            writeFile={writeFile}
          />
        </div>

        {/* RIGHT COLUMN: Nestpick, Jobs Root, Archive, Quarantine */}
        <div className="flex flex-col gap-6">
          {/* Nestpick Panel */}
          <SectionCard title="Machine Nestpick Folder" icon={SettingsIcon}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormGroup>
              <FieldLabel>Machine</FieldLabel>
              <FormSelect
                value={nestpickMachineId ?? ''}
                onChange={(e) => setNestpickMachineId(Number(e.target.value))}
              >
                {machines.map((m) => (
                  <option key={m.machineId} value={m.machineId}>
                    {m.name || `Machine ${m.machineId}`}
                  </option>
                ))}
              </FormSelect>
            </FormGroup>
            <FormGroup>
              <FieldLabel>Target Folder</FieldLabel>
              <ReadOnlyPath value={machines.find((m) => m.machineId === nestpickMachineId)?.nestpickFolder ?? ''} />
            </FormGroup>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormGroup>
              <FieldLabel>File Type</FieldLabel>
              <FormSelect
                value={nestpickFileKind}
                onChange={(e) => {
                  const next = e.target.value as typeof nestpickFileKind;
                  setNestpickDirty(false);
                  setNestpickResult(null);
                  setNestpickFileName(next);
                  setNestpickContent('');
                  setNestpickFileKind(next);
                }}
              >
                <option value="Nestpick.erl">Nestpick.erl</option>
                <option value="Report_FullNestpickUnstack.csv">Report_FullNestpickUnstack.csv</option>
              </FormSelect>
            </FormGroup>
            <FormGroup>
              <FieldLabel>Base</FieldLabel>
              <FormInput
                value={nestpickBase}
                onChange={(e) => setNestpickBase(e.target.value)}
              />
            </FormGroup>
          </div>

          {nestpickFileKind === 'Report_FullNestpickUnstack.csv' && (
            <FormGroup>
              <FieldLabel>Pallet Number</FieldLabel>
              <FormInput
                value={nestpickPallet}
                onChange={(e) => setNestpickPallet(e.target.value)}
              />
            </FormGroup>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <FormGroup>
              <FieldLabel>Corruption</FieldLabel>
              <FormSelect
                value={nestpickPreset}
                onChange={(e) => setNestpickPreset(e.target.value as CorruptPreset)}
              >
                <option value="valid">Valid</option>
                <option value="incorrectDelimiter">Incorrect delimiter</option>
                <option value="noDelimiter">No delimiter</option>
                <option value="truncateHalf">Truncate half</option>
                <option value="empty">Empty file</option>
                <option value="randomGarbage">Random garbage</option>
              </FormSelect>
            </FormGroup>
            <FormGroup>
              <FieldLabel>Write Mode</FieldLabel>
              <FormSelect
                value={nestpickWriteMode}
                onChange={(e) => setNestpickWriteMode(e.target.value as WriteMode)}
              >
                <option value="atomic">Atomic (tmp+rename)</option>
                <option value="direct">Direct</option>
                <option value="chunked">Chunked</option>
              </FormSelect>
            </FormGroup>
            <FormGroup>
              <FieldLabel>Line Endings</FieldLabel>
              <FormSelect
                value={nestpickLineEnding}
                onChange={(e) => setNestpickLineEnding(e.target.value as LineEnding)}
              >
                <option value="crlf">CRLF</option>
                <option value="lf">LF</option>
              </FormSelect>
            </FormGroup>
          </div>

          <FormGroup>
            <FieldLabel>File Name</FieldLabel>
            <FormInput
              value={nestpickFileName}
              onChange={(e) => {
                setNestpickDirty(true);
                setNestpickFileName(e.target.value);
              }}
            />
          </FormGroup>

          <FormGroup>
            <FieldLabel>File Contents</FieldLabel>
            <FormTextarea
              value={nestpickContent}
              onChange={(e) => {
                setNestpickDirty(true);
                setNestpickContent(e.target.value);
              }}
            />
          </FormGroup>

          <div className="flex flex-wrap items-center gap-3 pt-2">
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

                  const wroteErl = nestpickFileName.trim().toLowerCase().endsWith('.erl');
                  const shouldCleanup = wroteErl && Boolean(settings?.test?.disableErlTimeouts);
                  if (!shouldCleanup) {
                    setNestpickResult(`Wrote: ${fullPath}`);
                    return;
                  }

                  const cleanupRes = await window.api.adminTools.cleanupTestCsv({
                    target: { kind: 'machineNestpickFolder', machineId }
                  });
                  if (!cleanupRes.ok) {
                    setNestpickResult(`Wrote: ${fullPath} | Cleanup ERROR: ${cleanupRes.error.message}`);
                    return;
                  }

                  const { deleted, missing, failed } = cleanupRes.value;
                  const detail = failed.length ? ` (failed: ${failed[0].file})` : '';
                  setNestpickResult(
                    `Wrote: ${fullPath} | Cleaned CSV: deleted ${deleted.length}, missing ${missing.length}, failed ${failed.length}${detail}`
                  );
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
            {nestpickResult && <ResultMessage>{nestpickResult}</ResultMessage>}
          </div>
        </SectionCard>

          {/* Jobs Root */}
          <GenericFolderWriter
            title="Jobs Root"
            icon={Folder}
            folderPath={paths?.jobsRoot ?? ''}
            targetKind="jobsRoot"
            writeFile={writeFile}
          />

          {/* Archive Root */}
          <GenericFolderWriter
            title="Archive Root"
            icon={Folder}
            folderPath={paths?.archiveRoot ?? ''}
            targetKind="archiveRoot"
            writeFile={writeFile}
          />

          {/* Quarantine Root */}
          <GenericFolderWriter
            title="Quarantine Root"
            icon={Folder}
            folderPath={paths?.quarantineRoot ?? ''}
            targetKind="quarantineRoot"
            writeFile={writeFile}
          />
        </div>
      </div>
    </div>
  );
}
