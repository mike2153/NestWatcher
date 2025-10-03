import { contextBridge, ipcRenderer } from 'electron';
import type {
  CopyDiagnosticsResult,
  DbSettings,
  DbStatus,
  DiagnosticsSnapshot,
  DiagnosticsLogsRes,
  DiagnosticsLogTailReq,
  DiagnosticsLogTailRes,
  LogWriteReq,
  ThemePreferenceReq,
  ThemePreferenceRes,
  GrundnerListReq,
  GrundnerListRes,
  GrundnerResyncReq,
  GrundnerUpdateReq,
  HistoryListReq,
  HistoryListRes,
  JobEventsReq,
  JobEventsRes,
  JobTimelineRes,
  JobsFiltersRes,
  JobsListReq,
  JobsListRes,
  LifecycleReq,
  LifecycleRes,
  MachinesListRes,
  Machine,
  PathValidationReq,
  PathValidationRes,
  ReadyListRes,
  ReadyImportReq,
  ReadyImportRes,
  RouterListReq,
  RouterListRes,
  SaveMachineReq,
  Settings,
  WorklistAddResult,
  TelemetrySummaryReq,
  TelemetrySummaryRes,
  AlarmsHistoryReq
} from '../../shared/src';
import { type ResultEnvelope } from '../../shared/src/result';

// Normalize all IPC calls to return a simple { ok, value | error } envelope
const invokeResult = <T>(channel: string, ...args: unknown[]): Promise<ResultEnvelope<T>> =>
  ipcRenderer.invoke(channel, ...args) as Promise<ResultEnvelope<T>>;

const api = {
  settings: {
    get: () => invokeResult<Settings>('settings:get'),
    getPath: () => invokeResult<string>('settings:path'),
    save: (next: Settings) => invokeResult<Settings>('settings:save', next),
    validatePath: (input: PathValidationReq) => invokeResult<PathValidationRes>('settings:validatePath', input)
  },
  db: {
    testConnection: (db: DbSettings) => invokeResult<{ ok: true } | { ok: false; error: string }>('db:test', db),
    ping: () => invokeResult<null>('db:ping'),
    getStatus: () => invokeResult<DbStatus>('db:status:get'),
    subscribeStatus: (listener: (status: DbStatus) => void) => {
      const channel = 'db:status:update';
      const handler = (_event: Electron.IpcRendererEvent, status: DbStatus) => listener(status);
      ipcRenderer.on(channel, handler);
      invokeResult<DbStatus>('db:status:subscribe').catch(() => {});
      return () => {
        ipcRenderer.removeListener(channel, handler);
        invokeResult<null>('db:status:unsubscribe').catch(() => {});
      };
    }
  },
  lifecycle: {
    update: (key: string, to: LifecycleReq['to']) => invokeResult<LifecycleRes>('jobs:lifecycle', { key, to })
  },
  jobs: {
    list: (req: JobsListReq) => invokeResult<JobsListRes>('jobs:list', req),
    filters: () => invokeResult<JobsFiltersRes>('jobs:filters'),
    events: (req: JobEventsReq) => invokeResult<JobEventsRes>('jobs:events', req),
    reserve: (key: string) => invokeResult<null>('jobs:reserve', { key }),
    unreserve: (key: string) => invokeResult<null>('jobs:unreserve', { key }),
    addToWorklist: (key: string, machineId: number) => invokeResult<WorklistAddResult>('jobs:addToWorklist', { key, machineId }),
    resync: () => invokeResult<{ inserted: number; updated: number }>('jobs:resync')
  },
  machines: {
    list: () => invokeResult<MachinesListRes>('machines:list'),
    save: (machine: SaveMachineReq) => invokeResult<Machine>('machines:save', machine),
    delete: (machineId: number) => invokeResult<null>('machines:delete', machineId)
  },
  dialog: {
    pickFolder: () => invokeResult<string | null>('dialog:pickFolder')
  },
  files: {
    listReady: (machineId: number) => invokeResult<ReadyListRes>('files:listReady', machineId),
    importReady: (input: ReadyImportReq) => invokeResult<ReadyImportRes>('files:importReady', input),
    subscribeReady: (machineId: number, listener: (payload: ReadyListRes) => void) => {
      const channel = 'files:ready:update';
      const handler = (_e: Electron.IpcRendererEvent, payload: ReadyListRes) => listener(payload);
      ipcRenderer.on(channel, handler);
      invokeResult<null>('files:ready:subscribe', machineId).catch(() => {});
      return () => {
        ipcRenderer.removeListener(channel, handler);
        invokeResult<null>('files:ready:unsubscribe').catch(() => {});
      };
    }
  },
  router: {
    list: (req?: RouterListReq) => invokeResult<RouterListRes>('router:list', req ?? {})
  },
  grundner: {
    list: (req?: GrundnerListReq) => invokeResult<GrundnerListRes>('grundner:list', req ?? {}),
    update: (input: GrundnerUpdateReq) => invokeResult<{ ok: boolean; updated: number }>('grundner:update', input),
    resync: (input?: GrundnerResyncReq) => invokeResult<{ updated: number }>('grundner:resync', input ?? {})
  },
  hypernest: {
    open: () => invokeResult<null>('hypernest:open')
  },
  alarms: {
    list: () => invokeResult('alarms:list'),
    history: (req: AlarmsHistoryReq) => invokeResult('alarms:history', req),
    subscribe: (listener: (alarms: unknown[]) => void) => {
      const channel = 'alarms:update';
      const handler = (_event: Electron.IpcRendererEvent, alarms: unknown[]) => listener(alarms);
      ipcRenderer.on(channel, handler);
      invokeResult<null>('alarms:subscribe').catch(() => {});
      return () => {
        ipcRenderer.removeListener(channel, handler);
        invokeResult<null>('alarms:unsubscribe').catch(() => {});
      };
    }
  },
  telemetry: {
    summary: (req: TelemetrySummaryReq) => invokeResult<TelemetrySummaryRes>('telemetry:summary', req),
    subscribe: (req: TelemetrySummaryReq, listener: (payload: TelemetrySummaryRes) => void) => {
      const channel = 'telemetry:update';
      const handler = (_e: Electron.IpcRendererEvent, payload: TelemetrySummaryRes) => listener(payload);
      ipcRenderer.on(channel, handler);
      invokeResult<null>('telemetry:subscribe', req).catch(() => {});
      return () => {
        ipcRenderer.removeListener(channel, handler);
        invokeResult<null>('telemetry:unsubscribe').catch(() => {});
      };
    }
  },
  diagnostics: {
    get: () => invokeResult<DiagnosticsSnapshot>('diagnostics:get'),
    copy: () => invokeResult<CopyDiagnosticsResult>('diagnostics:copy'),
    listLogs: () => invokeResult<DiagnosticsLogsRes>('diagnostics:logs:list'),
    logTail: (req: DiagnosticsLogTailReq) =>
      invokeResult<DiagnosticsLogTailRes>('diagnostics:logs:tail', req),
    subscribe: (listener: (snapshot: DiagnosticsSnapshot) => void) => {
      const channel = 'diagnostics:update';
      const handler = (_event: Electron.IpcRendererEvent, snapshot: DiagnosticsSnapshot) => listener(snapshot);
      ipcRenderer.on(channel, handler);
      invokeResult<null>('diagnostics:subscribe').catch(() => {});
      return () => {
        ipcRenderer.removeListener(channel, handler);
        invokeResult<null>('diagnostics:unsubscribe').catch(() => {});
      };
    },
    subscribeLog: (file: string, listener: (payload: { file: string; lines: string[] }) => void) => {
      const channel = 'diagnostics:log:update';
      const handler = (_event: Electron.IpcRendererEvent, payload: { file: string; lines: string[] }) => {
        if (payload?.file === file) listener(payload);
      };
      ipcRenderer.on(channel, handler);
      invokeResult<null>('diagnostics:log:subscribe', { file }).catch(() => {});
      return () => {
        ipcRenderer.removeListener(channel, handler);
        invokeResult<null>('diagnostics:log:unsubscribe').catch(() => {});
      };
    }
  },
  ui: {
    theme: {
      get: () => invokeResult<ThemePreferenceRes>('ui:theme:get'),
      set: (req: ThemePreferenceReq) => invokeResult<ThemePreferenceRes>('ui:theme:set', req)
    }
  },

  history: {
    list: (req?: HistoryListReq) => invokeResult<HistoryListRes>('history:list', req ?? {}),
    timeline: (key: string) => invokeResult<JobTimelineRes | null>('history:timeline', key)
  }
  ,
  log: {
    write: (req: LogWriteReq) => invokeResult<null>('log:write', req),
    trace: (msg: string, context?: Record<string, unknown>) => invokeResult<null>('log:write', { level: 'trace', msg, context }),
    debug: (msg: string, context?: Record<string, unknown>) => invokeResult<null>('log:write', { level: 'debug', msg, context }),
    info: (msg: string, context?: Record<string, unknown>) => invokeResult<null>('log:write', { level: 'info', msg, context }),
    warn: (msg: string, context?: Record<string, unknown>) => invokeResult<null>('log:write', { level: 'warn', msg, context }),
    error: (msg: string, context?: Record<string, unknown>) => invokeResult<null>('log:write', { level: 'error', msg, context }),
    fatal: (msg: string, context?: Record<string, unknown>) => invokeResult<null>('log:write', { level: 'fatal', msg, context })
  }
} as const;

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;



