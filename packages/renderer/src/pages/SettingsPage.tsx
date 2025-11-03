import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { DbSettings, Settings, Machine, SaveMachineReq, DbStatus } from '../../../shared/src';
import { CURRENT_SETTINGS_VERSION } from '../../../shared/src';

const schema = z.object({
  host: z.string().default(''),
  port: z.coerce.number().int().min(1).max(65535).default(5432),
  database: z.string().default(''),
  user: z.string().default(''),
  password: z.string().default(''),
  sslMode: z.enum(['disable', 'require', 'verify-ca', 'verify-full']).default('disable'),
  statementTimeoutMs: z.coerce.number().int().min(0).max(600000).default(30000)
});

const DEFAULT_FORM_VALUES: DbSettings = {
  host: '',
  port: 5432,
  database: '',
  user: '',
  password: '', // Will be validated as required by schema
  sslMode: 'disable',
  statementTimeoutMs: 30000
};

type FormValues = z.infer<typeof schema>;
type PathsState = Settings['paths'];
type TestState = Settings['test'];
type GrundnerState = Settings['grundner'];

const DEFAULT_PATHS: PathsState = { processedJobsRoot: '', autoPacCsvDir: '', grundnerFolderPath: '', archiveRoot: '' };
const DEFAULT_TEST: TestState = { testDataFolderPath: '', useTestDataMode: false, sheetIdMode: 'type_data' };
const DEFAULT_GRUNDNER: GrundnerState = { reservedAdjustmentMode: 'delta' };

type PathFieldKey = 'processedJobsRoot' | 'autoPacCsvDir' | 'grundnerFolderPath' | 'archiveRoot' | 'testDataFolderPath';
type PathValidationState = { status: 'empty' | 'checking' | 'valid' | 'invalid'; message: string };
type MachinePathKey = 'machineApJobfolder' | 'machineNestpickFolder';

const PATH_STATUS_COLORS: Record<PathValidationState['status'], string> = {
  valid: 'text-success',
  invalid: 'text-destructive',
  checking: 'text-warning',
  empty: 'text-muted-foreground'
};

function createInitialPathStatus(): Record<PathFieldKey, PathValidationState> {
  return {
    processedJobsRoot: { status: 'empty', message: 'Not set' },
    autoPacCsvDir: { status: 'empty', message: 'Not set' },
    grundnerFolderPath: { status: 'empty', message: 'Not set' },
    archiveRoot: { status: 'empty', message: 'Not set' },
    testDataFolderPath: { status: 'empty', message: 'Not set' }
  };
}

function createInitialMachinePathStatus(): Record<MachinePathKey, PathValidationState> {
  return {
    machineApJobfolder: { status: 'empty', message: 'Select a machine to edit' },
    machineNestpickFolder: { status: 'empty', message: 'Select a machine to edit' }
  };
}

function statusBorderClass(status: PathValidationState) {
  switch (status.status) {
    case 'valid':
      return 'border-success focus:ring-success/40';
    case 'invalid':
      return 'border-destructive focus:ring-destructive/40';
    case 'checking':
      return 'border-warning focus:ring-warning/40';
    default:
      return 'border-border';
  }
}

function withDefaults<T extends object>(defaults: T, value?: Partial<T> | null): T {
  return { ...defaults, ...(value ?? {}) };
}

type ResultEnvelope<T> = { ok: true; value: T } | { ok: false; error: { message: string } };

function extractResult<T>(raw: unknown): ResultEnvelope<T> {
  // Direct value fallback (older stubs or IPC shims)
  if (typeof raw === 'string' || raw === null) {
    return { ok: true, value: raw as unknown as T };
  }

  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;

    // neverthrow-like Result<T,E>
    const hasNtOk = Object.prototype.hasOwnProperty.call(obj, 'isOk');
    const hasNtErr = Object.prototype.hasOwnProperty.call(obj, 'isErr');
    const isNtOkFn = hasNtOk && typeof (obj as { isOk?: unknown }).isOk === 'function';
    const isNtErrFn = hasNtErr && typeof (obj as { isErr?: unknown }).isErr === 'function';
    if (isNtOkFn && isNtErrFn) {
      try {
        const isErr = ((obj as { isErr: () => boolean }).isErr)();
        if (isErr) {
          const errValue = obj.error as { message?: string } | string | undefined;
          const message = typeof errValue === 'string' ? errValue : errValue?.message ?? 'Unknown error';
          return { ok: false, error: { message } };
        }
        const value = (obj as { value?: T }).value as T;
        return { ok: true, value };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: { message } };
      }
    }

    // Envelope { ok, value | error }
    if (Object.prototype.hasOwnProperty.call(obj, 'ok')) {
      const okFlag = Boolean((obj as { ok?: unknown }).ok as boolean);
      if (okFlag) {
        return { ok: true, value: (obj as { value?: T }).value as T };
      }
      const errValue = (obj as { error?: unknown }).error as { message?: string } | string | undefined;
      const message = typeof errValue === 'string' ? errValue : errValue?.message ?? 'Unknown error';
      return { ok: false, error: { message } };
    }

    // Tolerate boolean-style flags (defensive)
    const maybeIsOk = (obj as { isOk?: unknown }).isOk;
    if (typeof maybeIsOk === 'boolean') {
      const okFlag = Boolean(maybeIsOk);
      if (okFlag) return { ok: true, value: (obj as { value?: T }).value as T };
      const errValue = (obj as { error?: unknown }).error as { message?: string } | string | undefined;
      const message = typeof errValue === 'string' ? errValue : errValue?.message ?? 'Unknown error';
      return { ok: false, error: { message } };
    }
  }

  return { ok: false, error: { message: 'Unexpected response from API' } };
}

export function SettingsPage() {
  const { register, handleSubmit, reset, formState: { isSubmitting } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: DEFAULT_FORM_VALUES
  });

  const [configVersion, setConfigVersion] = useState<number>(CURRENT_SETTINGS_VERSION);
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [selectedMachineId, setSelectedMachineId] = useState<number | null>(null);
  const [editingMachine, setEditingMachine] = useState<Machine | null>(null);
  const [paths, setPaths] = useState<PathsState>(DEFAULT_PATHS);
  const [testState, setTestState] = useState<TestState>(DEFAULT_TEST);
  const [grundnerState, setGrundnerState] = useState<GrundnerState>(DEFAULT_GRUNDNER);
  const [dbStatus, setDbStatus] = useState<DbStatus | null>(null);
  const [pathStatus, setPathStatus] = useState<Record<PathFieldKey, PathValidationState>>(() => createInitialPathStatus());
  const [machinePathStatus, setMachinePathStatus] = useState<Record<MachinePathKey, PathValidationState>>(() => createInitialMachinePathStatus());
  const [dbTestResult, setDbTestResult] = useState<{ status: 'idle' | 'testing' | 'ok' | 'error'; message: string }>({ status: 'idle', message: '' });

  const lastCheckedLabel = useMemo(() => {
    if (!dbStatus) return null;
    const date = new Date(dbStatus.checkedAt);
    if (Number.isNaN(date.getTime()) || date.getTime() === 0) return null;
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }, [dbStatus]);

  const latencyLabel = useMemo(() => {
    return dbStatus?.online && typeof dbStatus.latencyMs === 'number' ? `${dbStatus.latencyMs} ms` : null;
  }, [dbStatus]);

  const statusLabel = useMemo(() => {
    if (!dbStatus) return 'Checking...';
    return dbStatus.online
      ? 'Online'
      : dbStatus.error ? 'Offline' : 'Checking...';
  }, [dbStatus]);

  const hasPathErrors = useMemo(() => Object.values(pathStatus).some((entry) => entry.status === 'invalid'), [pathStatus]);
  const isPathValidationPending = useMemo(() => Object.values(pathStatus).some((entry) => entry.status === 'checking'), [pathStatus]);

  const machineHasErrors = useMemo(() => {
    if (!editingMachine) return false;
    return Object.entries(machinePathStatus).some(([key, state]) => {
      if (key === 'machineNestpickFolder' && !editingMachine.nestpickEnabled) return false;
      return state.status === 'invalid';
    });
  }, [editingMachine, machinePathStatus]);

  const machineValidationPending = useMemo(() => {
    if (!editingMachine) return false;
    return Object.entries(machinePathStatus).some(([key, state]) => {
      if (key === 'machineNestpickFolder' && !editingMachine.nestpickEnabled) return false;
      return state.status === 'checking';
    });
  }, [editingMachine, machinePathStatus]);

  const machineHasBlockingIssues = machineHasErrors || machineValidationPending;

  const statusToneClass = useMemo(() => {
    if (dbStatus?.online) return 'text-success';
    if (dbStatus?.error) return 'text-destructive';
    return 'text-warning';
  }, [dbStatus]);

  const indicatorToneClass = useMemo(() => {
    if (dbStatus?.online) return 'bg-success';
    if (dbStatus?.error) return 'bg-destructive';
    return 'bg-warning';
  }, [dbStatus]);

  const applyMachines = useCallback((items: Machine[], preferredId?: number | null) => {
    setMachines(items);
    if (!items.length) {
      setSelectedMachineId(null);
      setEditingMachine(null);
      return;
    }

    const targetId = preferredId ?? selectedMachineId ?? items[0].machineId;
    const match = items.find((m) => m.machineId === targetId) ?? items[0];
    setSelectedMachineId(match.machineId);
    setEditingMachine({ ...match });
  }, [selectedMachineId]);

  const loadMachines = useCallback(async (preferredId?: number | null) => {
    const raw = await window.api.machines.list();
    const result = extractResult<{ items: Machine[] }>(raw as unknown);
    if (!result.ok) {
      alert(`Failed to load machines: ${result.error.message}`);
      applyMachines([], preferredId);
      return;
    }
    applyMachines(result.value.items, preferredId);
  }, [applyMachines]);

  const loadSettings = useCallback(async () => {
    const settingsRaw = await window.api.settings.get();
    const settingsRes = extractResult<Settings>(settingsRaw as unknown);
    if (!settingsRes.ok) {
      alert(`Failed to load settings: ${settingsRes.error.message}`);
      return;
    }
    const settings = settingsRes.value;
    const pathRaw = await window.api.settings.getPath();
    const pathRes = extractResult<string>(pathRaw as unknown);
    if (pathRes.ok) {
      setConfigPath(pathRes.value);
    }
    setConfigVersion(settings.version ?? CURRENT_SETTINGS_VERSION);
    
    // Merge settings and show password as-is per product decision
    const dbSettings = withDefaults(DEFAULT_FORM_VALUES, settings.db);
    reset(dbSettings);
    setPaths(withDefaults(DEFAULT_PATHS, settings.paths));
    setTestState(withDefaults(DEFAULT_TEST, settings.test));
    setGrundnerState(withDefaults(DEFAULT_GRUNDNER, settings.grundner));
    await loadMachines();
  }, [loadMachines, reset]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    let cancelled = false;
    window.api.db.getStatus()
      .then((raw) => {
        if (cancelled) return;
        const res = extractResult<DbStatus>(raw as unknown);
        if (res.ok) setDbStatus(res.value);
      })
      .catch(() => {});
    const unsubscribe = window.api.db.subscribeStatus((status) => setDbStatus(status));
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    const descriptors: Array<{ key: PathFieldKey; value: string; required: boolean }> = [
      { key: 'processedJobsRoot', value: paths.processedJobsRoot ?? '', required: true },
      { key: 'autoPacCsvDir', value: paths.autoPacCsvDir ?? '', required: false },
      { key: 'grundnerFolderPath', value: paths.grundnerFolderPath ?? '', required: false },
      { key: 'archiveRoot', value: paths.archiveRoot ?? '', required: false },
      { key: 'testDataFolderPath', value: testState.testDataFolderPath ?? '', required: false }
    ];
    setPathStatus((prev) => {
      const next = { ...prev };
      descriptors.forEach((descriptor) => {
        const trimmed = descriptor.value.trim();
        if (!trimmed) {
          next[descriptor.key] = {
            status: descriptor.required ? 'invalid' : 'empty',
            message: descriptor.required ? 'Required' : 'Not set'
          };
        } else {
          next[descriptor.key] = { status: 'checking', message: 'Checking...' };
        }
      });
      return next;
    });

    let cancelled = false;

    (async () => {
      for (const descriptor of descriptors) {
        const trimmed = descriptor.value.trim();
        if (!trimmed) continue;
        const raw = await window.api.settings.validatePath({ path: trimmed, kind: 'directory' });
        const res = extractResult<{ path: string; exists: boolean; isDirectory: boolean; isFile: boolean; error: string | null }>(raw as unknown);
        if (cancelled) return;
        if (!res.ok) {
          setPathStatus((prev) => ({
            ...prev,
            [descriptor.key]: { status: 'invalid', message: res.error.message }
          }));
          continue;
        }
        const data = res.value;
        const ok = data.exists && data.isDirectory;
        setPathStatus((prev) => ({
          ...prev,
          [descriptor.key]: {
            status: ok ? 'valid' : 'invalid',
            message: ok ? 'Directory found' : data.exists ? 'Not a directory' : 'Directory not found'
          }
        }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [paths.processedJobsRoot, paths.autoPacCsvDir, paths.grundnerFolderPath, paths.archiveRoot, testState.testDataFolderPath]);

  useEffect(() => {
    if (!editingMachine) {
      setMachinePathStatus(createInitialMachinePathStatus());
      return;
    }

    const descriptors: Array<{ key: MachinePathKey; value: string; required: boolean; disabledMessage?: string }> = [
      { key: 'machineApJobfolder', value: editingMachine.apJobfolder ?? '', required: true },
      { key: 'machineNestpickFolder', value: editingMachine.nestpickFolder ?? '', required: !!editingMachine.nestpickEnabled, disabledMessage: editingMachine.nestpickEnabled ? undefined : 'Nestpick disabled' }
    ];

    setMachinePathStatus((prev) => {
      const next = { ...prev };
      descriptors.forEach((descriptor) => {
        const trimmed = descriptor.value.trim();
        if (!trimmed) {
          const message = descriptor.required
            ? 'Required'
            : descriptor.disabledMessage ?? 'Not set';
          next[descriptor.key] = {
            status: descriptor.required ? 'invalid' : 'empty',
            message
          };
        } else if (descriptor.disabledMessage && !descriptor.required) {
          next[descriptor.key] = { status: 'empty', message: descriptor.disabledMessage };
        } else {
          next[descriptor.key] = { status: 'checking', message: 'Checking...' };
        }
      });
      return next;
    });

    let cancelled = false;

    (async () => {
      for (const descriptor of descriptors) {
        const trimmed = descriptor.value.trim();
        if (!trimmed) continue;
        if (descriptor.disabledMessage && !descriptor.required && !editingMachine.nestpickEnabled) continue;
        const raw = await window.api.settings.validatePath({ path: trimmed, kind: 'directory' });
        const res = extractResult<{ path: string; exists: boolean; isDirectory: boolean; isFile: boolean; error: string | null }>(raw as unknown);
        if (cancelled) return;
        if (!res.ok) {
          setMachinePathStatus((prev) => ({
            ...prev,
            [descriptor.key]: { status: 'invalid', message: res.error.message }
          }));
          continue;
        }
        const data = res.value;
        const ok = data.exists && data.isDirectory;
        setMachinePathStatus((prev) => ({
          ...prev,
          [descriptor.key]: {
            status: ok ? 'valid' : 'invalid',
            message: ok ? 'Directory found' : data.exists ? 'Not a directory' : 'Directory not found'
          }
        }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [editingMachine]);

  const onTest = async (values: FormValues) => {
    setDbTestResult({ status: 'testing', message: 'Testing connection...' });
    const res = extractResult<{ ok: true } | { ok: false; error: string }>(
      await window.api.db.testConnection(values as DbSettings)
    );
    if (!res.ok) {
      setDbTestResult({ status: 'error', message: res.error.message });
      return;
    }
    if (res.value.ok) {
      setDbTestResult({ status: 'ok', message: 'Connection OK' });
    } else {
      setDbTestResult({ status: 'error', message: res.value.error ?? 'Unknown error' });
    }
  };

  const onSave = async (values: FormValues) => {
    const next: Settings = {
      version: configVersion,
      db: values as DbSettings,
      paths,
      test: testState,
      grundner: grundnerState,
      jobs: { completedJobsTimeframe: '7days', statusFilter: ['pending', 'processing', 'complete'] }
    };
    const saved = extractResult<Settings>(await window.api.settings.save(next));
    if (!saved.ok) {
      alert(`Failed to save settings: ${saved.error.message}`);
      return;
    }
    setConfigVersion(saved.value.version ?? CURRENT_SETTINGS_VERSION);
    await loadSettings();
    setDbTestResult({ status: 'idle', message: '' });
    alert('Settings saved');
  };

  const addMachine = async () => {
    const createdRaw = await window.api.machines.save({
      name: 'New Machine',
      apJobfolder: '',
      nestpickFolder: '',
      nestpickEnabled: true,
      pcPort: 5000
    });
    const created = extractResult<Machine>(createdRaw as unknown);
    if (!created.ok) {
      alert(`Failed to create machine: ${created.error.message}`);
      return;
    }
    await loadMachines(created.value.machineId ?? undefined);
  };

  const saveMachine = async () => {
    if (!editingMachine) return;
    if (machineHasBlockingIssues) {
      alert('Machine folder validation is pending or has errors.');
      return;
    }

    const payload: SaveMachineReq = {
      machineId: editingMachine.machineId,
      name: editingMachine.name,
      pcIp: editingMachine.pcIp ?? null,
      cncIp: editingMachine.cncIp ?? null,
      cncPort: editingMachine.cncPort ?? null,
      apJobfolder: editingMachine.apJobfolder,
      nestpickFolder: editingMachine.nestpickFolder,
      nestpickEnabled: editingMachine.nestpickEnabled,
      pcPort: editingMachine.pcPort
    };

    const raw = await window.api.machines.save(payload);
    const res = extractResult<Machine>(raw as unknown);
    if (!res.ok) {
      alert(`Failed to save machine: ${res.error.message}`);
      return;
    }
    await loadMachines(editingMachine.machineId);
  };

  const deleteMachine = async () => {
    if (selectedMachineId == null) return;
    if (!confirm('Delete this machine?')) return;
    const raw = await window.api.machines.delete(selectedMachineId);
    const res = extractResult<null>(raw as unknown);
    if (!res.ok) {
      alert(`Failed to delete machine: ${res.error.message}`);
      return;
    }
    await loadMachines();
  };

  const deleteMachineById = async (id: number, name?: string | null) => {
    if (!confirm(`Delete machine "${name ?? id}"?`)) return;
    const raw = await window.api.machines.delete(id);
    const res = extractResult<null>(raw as unknown);
    if (!res.ok) {
      alert(`Failed to delete machine: ${res.error.message}`);
      return;
    }
    await loadMachines();
  };

  const handleSelectMachine = (machineId: number) => {
    const machine = machines.find((m) => m.machineId === machineId);
    if (!machine) return;
    setSelectedMachineId(machine.machineId);
    setEditingMachine({ ...machine });
  };

  const browseFolder = async (setter: (value: string) => void, initial?: string) => {
    try {
      const raw = await window.api.dialog.pickFolder();
      const res = extractResult<string | null>(raw as unknown);
      if (!res.ok) {
        alert(`Failed to open folder picker: ${res.error.message}`);
        console.error('Folder picker error', res.error.message);
        return;
      }
      const value = res.value;
      if (value) {
        console.debug('Picked folder:', value);
        setter(value);
      } else if (initial !== undefined) {
        console.debug('Picker cancelled, keeping initial:', initial);
        setter(initial);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Failed to open folder picker: ${msg}`);
      console.error('Folder picker error', msg);
    }
  };

  return (
    <div className="space-section max-w-6xl">
      <div className="mb-2">
        {configPath && (
          <div className="text-sm text-muted-foreground mt-2 break-all">Config file: {configPath}</div>
        )}
      </div>

      <div className="grid grid-cols-[320px_1fr] gap-8">
        <div className="settings-panel p-6 h-[320px]">
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-semibold text-foreground">Machines</h3>
            <button type="button" className="btn-secondary text-sm" onClick={addMachine}>Add</button>
          </div>
          <div className="h-[calc(100%-2.5rem)] overflow-auto">
            <ul className="space-y-1">
              {machines.map((machine) => (
                <li key={machine.machineId} className="relative group">
                  <button
                    type="button"
                    className={`w-full text-left pr-10 pl-3 py-2 rounded-lg text-sm transition-colors ${
                      machine.machineId === selectedMachineId
                        ? 'bg-primary text-primary-foreground'
                        : 'hover:bg-muted text-foreground'
                    }`}
                    onClick={() => handleSelectMachine(machine.machineId)}
                    title={machine.name}
                  >
                    {machine.name}
                  </button>
                  <button
                    type="button"
                    aria-label="Delete machine"
                    title="Delete machine"
                    className={`absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded transition-colors ${
                      machine.machineId === selectedMachineId
                        ? 'text-primary-foreground/90 hover:text-destructive hover:bg-destructive/10'
                        : 'text-muted-foreground hover:text-destructive hover:bg-destructive/10'
                    }`}
                    onClick={(e) => { e.stopPropagation(); void deleteMachineById(machine.machineId, machine.name); }}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </li>
              ))}
              {!machines.length && <li className="text-sm text-muted-foreground p-2">No machines configured yet.</li>}
            </ul>
          </div>
        </div>

        <div className="settings-panel p-6 space-y-4">
          <h3 className="font-semibold text-foreground">Machine Details</h3>
          {machineHasErrors ? (
            <div className="text-sm text-destructive">Fix required machine folders before saving.</div>
          ) : machineValidationPending ? (
            <div className="text-sm text-warning">Validating machine folders...</div>
          ) : null}
          {editingMachine ? (
            <div className="grid grid-cols-2 gap-3">
              <label className="form-label">
                <span>Name</span>
                <input
                  className="form-input"
                  value={editingMachine.name}
                  onChange={(e) => setEditingMachine((prev) => prev ? { ...prev, name: e.target.value } : prev)}
                />
              </label>
              <label className="form-label">
                <span>PC IP</span>
                <input
                  className="form-input"
                  value={editingMachine.pcIp ?? ''}
                  onChange={(e) => setEditingMachine((prev) => prev ? { ...prev, pcIp: e.target.value || null } : prev)}
                />
              </label>
              <label className="form-label">
                <span>CNC IP</span>
                <input
                  className="form-input"
                  value={editingMachine.cncIp ?? ''}
                  onChange={(e) => setEditingMachine((prev) => prev ? { ...prev, cncIp: e.target.value || null } : prev)}
                />
              </label>
              <label className="form-label">
                <span>CNC Port</span>
                <input
                  className="form-input"
                  type="number"
                  value={editingMachine.cncPort ?? ''}
                  onChange={(e) => setEditingMachine((prev) => prev ? {
                    ...prev,
                    cncPort: e.target.value === '' ? null : Number(e.target.value)
                  } : prev)}
                />
              </label>
              <div className="col-span-2">
                <label className="form-label">
                  <span>Ready-To-Run Folder</span>
                  <div className="flex gap-2 items-start">
                    <input
                      className={`form-input flex-1 ${statusBorderClass(machinePathStatus.machineApJobfolder)}`}
                      value={editingMachine.apJobfolder}
                      onChange={(e) => setEditingMachine((prev) => prev ? { ...prev, apJobfolder: e.target.value } : prev)}
                    />
                    <button
                      type="button"
                      className="btn-secondary whitespace-nowrap"
                      onClick={() => browseFolder((value) => setEditingMachine((prev) => prev ? { ...prev, apJobfolder: value } : prev), editingMachine.apJobfolder)}
                    >
                      Browse
                    </button>
                  </div>
                  <span className={`text-xs ${PATH_STATUS_COLORS[machinePathStatus.machineApJobfolder.status]}`}>
                    {machinePathStatus.machineApJobfolder.message}
                  </span>
                </label>
              </div>
              <div className="col-span-2">
                <label className="form-label">
                  <span>Nestpick Folder</span>
                  <div className="flex gap-2 items-start">
                    <input
                      className={`form-input flex-1 ${statusBorderClass(machinePathStatus.machineNestpickFolder)}`}
                      value={editingMachine.nestpickFolder}
                      onChange={(e) => setEditingMachine((prev) => prev ? { ...prev, nestpickFolder: e.target.value } : prev)}
                    />
                    <button
                      type="button"
                      className="btn-secondary whitespace-nowrap"
                      onClick={() => browseFolder((value) => setEditingMachine((prev) => prev ? { ...prev, nestpickFolder: value } : prev), editingMachine.nestpickFolder)}
                    >
                      Browse
                    </button>
                  </div>
                  <span className={`text-xs ${PATH_STATUS_COLORS[machinePathStatus.machineNestpickFolder.status]}`}>
                    {machinePathStatus.machineNestpickFolder.message}
                  </span>
                </label>
              </div>
              <label className="form-label">
                <span>Nestpick Enabled</span>
                <select
                  className="form-input"
                  value={editingMachine.nestpickEnabled ? 'true' : 'false'}
                  onChange={(e) => setEditingMachine((prev) => prev ? { ...prev, nestpickEnabled: e.target.value === 'true' } : prev)}
                >
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              </label>
              <label className="form-label">
                <span>PC Port</span>
                <input
                  className="form-input"
                  type="number"
                  value={editingMachine.pcPort}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === '') {
                      setEditingMachine((prev) => prev ? { ...prev, pcPort: prev.pcPort } : prev);
                    } else {
                      const numVal = Number(val);
                      setEditingMachine((prev) => prev ? { ...prev, pcPort: isNaN(numVal) ? prev.pcPort : numVal } : prev);
                    }
                  }}
                />
              </label>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground p-4 text-center">Select a machine to edit</div>
          )}
          <div className="flex gap-3 pt-2">
            <button type="button" className="btn-primary" onClick={saveMachine} disabled={!editingMachine || machineHasBlockingIssues}>Save Machine</button>
            <button type="button" className="btn-secondary" onClick={deleteMachine} disabled={selectedMachineId == null}>Delete</button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mt-12">
        <div className="settings-panel p-6 space-y-4">
          <h3 className="font-semibold text-foreground">Paths</h3>
          {hasPathErrors ? (
            <div className="text-sm text-destructive">Some paths are missing; update as needed.</div>
          ) : isPathValidationPending ? (
            <div className="text-sm text-warning">Validating paths...</div>
          ) : null}
          <label className="form-label">
            <span>Processed Jobs Root</span>
            <div className="flex gap-2 items-start">
              <input
                className={`form-input w-full ${statusBorderClass(pathStatus.processedJobsRoot)}`}
                value={paths.processedJobsRoot}
                onChange={(e) => setPaths({ ...paths, processedJobsRoot: e.target.value })}
              />
              <button
                type="button"
                className="border rounded px-2"
                onClick={() => browseFolder((value) => setPaths((prev) => ({ ...prev, processedJobsRoot: value })), paths.processedJobsRoot)}
              >
                Browse
              </button>
            </div>
            <span className={`text-xs ${PATH_STATUS_COLORS[pathStatus.processedJobsRoot.status]}`}>
              {pathStatus.processedJobsRoot.message}
            </span>
          </label>
          <label className="form-label">
            <span>AutoPAC CSV Directory</span>
            <div className="flex gap-2 items-start">
              <input
                className={`form-input w-full ${statusBorderClass(pathStatus.autoPacCsvDir)}`}
                value={paths.autoPacCsvDir}
                onChange={(e) => setPaths({ ...paths, autoPacCsvDir: e.target.value })}
              />
              <button
                type="button"
                className="border rounded px-2"
                onClick={() => browseFolder((value) => setPaths((prev) => ({ ...prev, autoPacCsvDir: value })), paths.autoPacCsvDir)}
              >
                Browse
              </button>
            </div>
            <span className={`text-xs ${PATH_STATUS_COLORS[pathStatus.autoPacCsvDir.status]}`}>
              {pathStatus.autoPacCsvDir.message}
            </span>
          </label>
          <label className="form-label">
            <span>Grundner Folder</span>
            <div className="flex gap-2 items-start">
              <input
                className={`form-input w-full ${statusBorderClass(pathStatus.grundnerFolderPath)}`}
                value={paths.grundnerFolderPath}
                onChange={(e) => setPaths({ ...paths, grundnerFolderPath: e.target.value })}
              />
              <button
                type="button"
                className="border rounded px-2"
                onClick={() => browseFolder((value) => setPaths((prev) => ({ ...prev, grundnerFolderPath: value })), paths.grundnerFolderPath)}
              >
                Browse
              </button>
            </div>
            <span className={`text-xs ${PATH_STATUS_COLORS[pathStatus.grundnerFolderPath.status]}`}>
              {pathStatus.grundnerFolderPath.message}
            </span>
          </label>
          <label className="form-label">
            <span>Archive Root</span>
            <div className="flex gap-2 items-start">
              <input
                className={`form-input w-full ${statusBorderClass(pathStatus.archiveRoot)}`}
                value={paths.archiveRoot}
                onChange={(e) => setPaths({ ...paths, archiveRoot: e.target.value })}
              />
              <button
                type="button"
                className="border rounded px-2"
                onClick={() => browseFolder((value) => setPaths((prev) => ({ ...prev, archiveRoot: value })), paths.archiveRoot)}
              >
                Browse
              </button>
            </div>
            <span className={`text-xs ${PATH_STATUS_COLORS[pathStatus.archiveRoot.status]}`}>
              {pathStatus.archiveRoot.message}
            </span>
          </label>
        </div>

        <div className="settings-panel p-6 space-y-4">
          <h3 className="font-semibold text-foreground">Test / Grundner</h3>
          <label className="form-label">
            <span>Test Data Folder</span>
            <div className="flex gap-2 items-start">
              <input
                className={`form-input w-full ${statusBorderClass(pathStatus.testDataFolderPath)}`}
                value={testState.testDataFolderPath}
                onChange={(e) => setTestState({ ...testState, testDataFolderPath: e.target.value })}
              />
              <button
                type="button"
                className="border rounded px-2"
                onClick={() => browseFolder((value) => setTestState((prev) => ({ ...prev, testDataFolderPath: value })), testState.testDataFolderPath)}
              >
                Browse
              </button>
            </div>
            <span className={`text-xs ${PATH_STATUS_COLORS[pathStatus.testDataFolderPath.status]}`}>
              {pathStatus.testDataFolderPath.message}
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={testState.useTestDataMode}
              onChange={(e) => setTestState({ ...testState, useTestDataMode: e.target.checked })}
            />
            Use test data mode
          </label>
          <label className="form-label">
            <span>Sheet ID Mode</span>
            <select
              className="form-input"
              value={testState.sheetIdMode}
              onChange={(e) => setTestState({ ...testState, sheetIdMode: e.target.value as TestState['sheetIdMode'] })}
            >
              <option value="type_data">type_data</option>
              <option value="customer_id">customer_id</option>
            </select>
          </label>
          <label className="form-label">
            <span>Grundner Reserved Mode</span>
            <select
              className="form-input"
              value={grundnerState.reservedAdjustmentMode}
              onChange={(e) => setGrundnerState({ reservedAdjustmentMode: e.target.value as GrundnerState['reservedAdjustmentMode'] })}
            >
              <option value="delta">delta</option>
              <option value="absolute">absolute</option>
            </select>
          </label>
        </div>
      </div>

      <form className="settings-panel p-6 space-y-4 mt-12" onSubmit={handleSubmit(onSave)}>
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-lg" id="db-settings-heading">Database</h2>
          {dbStatus && (
            <div
              className="flex items-center gap-2 text-sm"
              title={!dbStatus.online && dbStatus.error ? dbStatus.error : undefined}
            >
              <span
                className={`h-2.5 w-2.5 rounded-full ${indicatorToneClass}`}
                aria-hidden
              />
              <span className={statusToneClass}>
                {statusLabel}
              </span>
              {lastCheckedLabel && (
                <span className="text-muted-foreground">{lastCheckedLabel}</span>
              )}
              {latencyLabel && (
                <span className="text-muted-foreground">{latencyLabel}</span>
              )}
              {!dbStatus.online && dbStatus.error && (
                <span className="text-xs text-muted-foreground max-w-[220px] truncate">
                  {dbStatus.error}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="form-label">
            <span>Host</span>
            <input className="form-input" {...register('host')} />
          </label>
          <label className="form-label">
            <span>Port</span>
            <input className="form-input" type="number" {...register('port', { valueAsNumber: true })} />
          </label>
          <label className="form-label">
            <span>Database</span>
            <input className="form-input" {...register('database')} />
          </label>
          <label className="form-label">
            <span>User</span>
            <input className="form-input" {...register('user')} />
          </label>
          <label className="form-label">
            <span>Password</span>
            <input className="form-input" type="password" autoComplete="off" {...register('password')} />
          </label>
          <label className="form-label">
            <span>SSL Mode</span>
            <select className="form-input" {...register('sslMode')}>
              <option value="disable">disable</option>
              <option value="require">require</option>
              <option value="verify-ca">verify-ca</option>
              <option value="verify-full">verify-full</option>
            </select>
          </label>
          <label className="form-label">
            <span>Statement Timeout (ms)</span>
            <input className="form-input" type="number" {...register('statementTimeoutMs', { valueAsNumber: true })} />
          </label>
        </div>
        <div className="flex gap-2">
          <button type="button" className="border rounded px-3 py-1" disabled={isSubmitting || dbTestResult.status === 'testing'} onClick={handleSubmit(onTest)}>Test</button>
          <button type="submit" className="border rounded px-3 py-1" disabled={isSubmitting}>Save</button>
        </div>
        {dbTestResult.status !== 'idle' && (
          <div className={`text-xs ${dbTestResult.status === 'ok' ? 'text-success' : dbTestResult.status === 'error' ? 'text-destructive' : 'text-warning'}`}>
            {dbTestResult.message}
          </div>
        )}
      </form>
    </div>
  );
}


