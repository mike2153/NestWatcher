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
  AllocatedMaterialListRes,
  AppMessage,
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
  ReadyDeleteReq,
  ReadyDeleteRes,
  RouterListReq,
  RouterListRes,
  SaveMachineReq,
  Settings,
  WorklistAddResult,
  TelemetrySummaryReq,
  TelemetrySummaryRes,
  AlarmsHistoryReq,
  MessagesListRes,
  OrderingListRes,
  OrderingUpdateReq,
  OrderingExportRes,
  OrderingRow,
  ValidationDataReq,
  ValidationDataRes,
  AggregatedValidationDataReq,
  AggregatedValidationDataRes,
  ValidationWarningsListRes,
  AuthStateRes,
  AuthSuccessRes,
  AuthLoginReq,
  AuthRegisterReq,
  AuthResetPasswordReq,
  NcCatProfile,
  NcCatProfilesListRes,
  NcCatProfileSaveReq,
  NcCatProfileSetActiveReq,
  NcCatProfileDeleteReq,
  NcCatAssignProfileReq,
  NcCatAssignProfileRes,
  NcCatProfileMachinesReq,
  NcCatProfileMachinesRes,
  NcCatSubmitValidationReq,
  NcCatSubmitValidationRes,
  OpenJobInSimulatorReq,
  OpenJobInSimulatorRes,
  SubscriptionAuthState,
  SubscriptionLoginReq,
  SubscriptionLoginRes
} from '../../shared/src';
import { type ResultEnvelope } from '../../shared/src/result';

// Normalize all IPC calls to return a simple { ok, value | error } envelope
const invokeResult = <T>(channel: string, ...args: unknown[]): Promise<ResultEnvelope<T>> =>
  ipcRenderer.invoke(channel, ...args) as Promise<ResultEnvelope<T>>;

const api = {
  auth: {
    me: () => invokeResult<AuthStateRes>('auth:me'),
    login: (input: AuthLoginReq) => invokeResult<AuthSuccessRes>('auth:login', input),
    register: (input: AuthRegisterReq) => invokeResult<AuthSuccessRes>('auth:register', input),
    resetPassword: (input: AuthResetPasswordReq) => invokeResult<AuthSuccessRes>('auth:resetPassword', input),
    logout: () => invokeResult<null>('auth:logout'),
    onRevoked: (listener: () => void) => {
      const channel = 'auth:revoked';
      const handler = () => listener();
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    }
  },
  validation: {
    getData: (input: ValidationDataReq) => invokeResult<ValidationDataRes>('validation:getData', input),
    getAggregatedData: (input: AggregatedValidationDataReq) => invokeResult<AggregatedValidationDataRes>('validation:getAggregatedData', input),
    getWarnings: () => invokeResult<ValidationWarningsListRes>('validation:getWarnings')
  },
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
    lock: (key: string) => invokeResult<null>('jobs:lock', { key }),
    unlock: (key: string) => invokeResult<null>('jobs:unlock', { key }),
    lockBatch: (keys: string[]) => invokeResult<null>('jobs:lockBatch', { keys }),
    unlockBatch: (keys: string[]) => invokeResult<null>('jobs:unlockBatch', { keys }),
    rerun: (key: string) => invokeResult<null>('jobs:rerun', { key }),
    addToWorklist: (key: string, machineId: number) => invokeResult<WorklistAddResult>('jobs:addToWorklist', { key, machineId }),
    rerunAndStage: (key: string, machineId: number) => invokeResult<WorklistAddResult>('jobs:rerunAndStage', { key, machineId }),
    resync: () =>
      invokeResult<{
        inserted: number;
        updated: number;
        pruned: number;
        addedJobs: { ncFile: string; folder: string }[];
        updatedJobs: { ncFile: string; folder: string }[];
        prunedJobs: { key: string; folder: string; ncFile: string; material: string | null; preReserved: boolean }[];
      }>('jobs:resync')
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
    deleteReadyAssets: (input: ReadyDeleteReq) => invokeResult<ReadyDeleteRes>('files:ready:delete', input),
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
    resync: (input?: GrundnerResyncReq) => invokeResult<{ updated: number }>('grundner:resync', input ?? {}),
    subscribeRefresh: (listener: () => void) => {
      const channel = 'grundner:refresh';
      const handler = () => listener();
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.removeListener(channel, handler);
      };
    }
  },
  allocatedMaterial: {
    list: () => invokeResult<AllocatedMaterialListRes>('allocatedMaterial:list'),
    subscribe: (listener: () => void) => {
      const channel = 'allocatedMaterial:refresh';
      const handler = () => listener();
      ipcRenderer.on(channel, handler);
      invokeResult<null>('allocatedMaterial:subscribe').catch(() => {});
      return () => {
        ipcRenderer.removeListener(channel, handler);
        invokeResult<null>('allocatedMaterial:unsubscribe').catch(() => {});
      };
    }
  },
  ordering: {
    list: () => invokeResult<OrderingListRes>('ordering:list'),
    update: (input: OrderingUpdateReq) => invokeResult<OrderingRow>('ordering:update', input),
    exportCsv: () => invokeResult<OrderingExportRes>('ordering:exportCsv'),
    exportPdf: () => invokeResult<OrderingExportRes>('ordering:exportPdf')
  },
  messages: {
    list: () => invokeResult<MessagesListRes>('messages:list'),
    unreadCount: () => invokeResult<number>('messages:unreadCount'),
    markAllRead: () => invokeResult<null>('messages:markRead'),
    subscribe: (listener: (entry: AppMessage) => void) => {
      const channel = 'messages:append';
      const handler = (_event: Electron.IpcRendererEvent, entry: AppMessage) => listener(entry);
      ipcRenderer.on(channel, handler);
      invokeResult<null>('messages:subscribe').catch(() => {});
      return () => {
        ipcRenderer.removeListener(channel, handler);
        invokeResult<null>('messages:unsubscribe').catch(() => {});
      };
    },
    subscribeCount: (listener: (count: number) => void) => {
      const channel = 'messages:count';
      const handler = (_event: Electron.IpcRendererEvent, count: number) => listener(count);
      ipcRenderer.on(channel, handler);
      invokeResult<null>('messages:subscribeCount').catch(() => {});
      return () => {
        ipcRenderer.removeListener(channel, handler);
        invokeResult<null>('messages:unsubscribeCount').catch(() => {});
      };
    }
  },
  ncCatalyst: {
    open: () => invokeResult<null>('nc-catalyst:open'),
    getSharedSettings: () =>
      invokeResult<import('../../shared/src').SharedSettingsSnapshot>('nc-catalyst:get-shared-settings'),
    // Submit validated job data from NC-Cat to NestWatch
    submitValidation: (req: NcCatSubmitValidationReq) =>
      invokeResult<NcCatSubmitValidationRes>('nc-catalyst:submit-validation', req),
    // Open jobs in the NC-Cat simulator (called from Jobs page)
    openJobs: (jobKeys: string[]) =>
      invokeResult<OpenJobInSimulatorRes>('nc-catalyst:open-jobs', { jobKeys }),
    // Listen for jobs being pushed to NC-Cat from NestWatcher
    onOpenJobs: (listener: (payload: OpenJobInSimulatorReq) => void) => {
      const channel = 'nc-catalyst:open-jobs';
      const handler = (_event: Electron.IpcRendererEvent, payload: OpenJobInSimulatorReq) => listener(payload);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    // Machine profiles CRUD (stored in PostgreSQL)
    profiles: {
      list: () => invokeResult<NcCatProfilesListRes>('nc-catalyst:profiles:list'),
      save: (req: NcCatProfileSaveReq) => invokeResult<NcCatProfile>('nc-catalyst:profiles:save', req),
      setActive: (req: NcCatProfileSetActiveReq) => invokeResult<null>('nc-catalyst:profiles:setActive', req),
      delete: (req: NcCatProfileDeleteReq) => invokeResult<null>('nc-catalyst:profiles:delete', req),
      // Profile ↔ Machine assignment
      assign: (req: NcCatAssignProfileReq) => invokeResult<NcCatAssignProfileRes>('nc-catalyst:profiles:assign', req),
      getMachines: (req: NcCatProfileMachinesReq) => invokeResult<NcCatProfileMachinesRes>('nc-catalyst:profiles:machines', req)
    },
    // Subscription authentication (via NC-Cat → Supabase)
    subscriptionAuth: {
      // Get current auth state
      getState: () => invokeResult<SubscriptionAuthState | null>('nc-catalyst:auth:getState'),
      // Login with email/password
      login: (req: SubscriptionLoginReq) => invokeResult<SubscriptionLoginRes>('nc-catalyst:auth:login', req),
      // Logout
      logout: () => invokeResult<null>('nc-catalyst:auth:logout'),
      // Check if subscription is valid
      isValid: () => invokeResult<boolean>('nc-catalyst:auth:isValid'),
      // Get hardware ID (real hardware-based ID in Electron)
      getHardwareId: () => invokeResult<string>('nc-catalyst:auth:getHardwareId'),
      // Listen for auth state changes
      onStateChange: (listener: (state: SubscriptionAuthState) => void) => {
        const channel = 'nc-catalyst:auth:stateChanged';
        const handler = (_event: Electron.IpcRendererEvent, state: SubscriptionAuthState) => listener(state);
        ipcRenderer.on(channel, handler);
        return () => ipcRenderer.removeListener(channel, handler);
      },
      // NC-Cat uses these to respond to NestWatcher requests
      onRequestState: (handler: () => void) => {
        const channel = 'nc-catalyst:auth:requestState';
        const listener = () => handler();
        ipcRenderer.on(channel, listener);
        return () => ipcRenderer.removeListener(channel, listener);
      },
      sendStateResponse: (state: SubscriptionAuthState) => {
        ipcRenderer.send('nc-catalyst:auth:stateResponse', state);
      },
      sendStateUpdate: (state: SubscriptionAuthState) => {
        ipcRenderer.send('nc-catalyst:auth:stateUpdate', state);
      },
      // NC-Cat uses these for login/logout requests from NestWatcher
      onLoginRequest: (handler: (req: SubscriptionLoginReq) => void) => {
        const channel = 'nc-catalyst:auth:loginRequest';
        const listener = (_event: Electron.IpcRendererEvent, req: SubscriptionLoginReq) => handler(req);
        ipcRenderer.on(channel, listener);
        return () => ipcRenderer.removeListener(channel, listener);
      },
      sendLoginResponse: (response: SubscriptionLoginRes) => {
        ipcRenderer.send('nc-catalyst:auth:loginResponse', response);
      },
      onLogoutRequest: (handler: () => void) => {
        const channel = 'nc-catalyst:auth:logoutRequest';
        const listener = () => handler();
        ipcRenderer.on(channel, listener);
        return () => ipcRenderer.removeListener(channel, listener);
      },
      sendLogoutResponse: () => {
        ipcRenderer.send('nc-catalyst:auth:logoutResponse');
      }
    }
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
    restartWatchers: () => invokeResult<{ ok: true }>('diagnostics:restart-watchers'),
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



