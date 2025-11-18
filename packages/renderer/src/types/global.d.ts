import type {
  AppError,
  AlarmEntry,
  CopyDiagnosticsResult,
  DbSettings,
  DbStatus,
  DiagnosticsSnapshot,
  GrundnerListReq,
  GrundnerListRes,
  GrundnerResyncReq,
  GrundnerUpdateReq,
  AppMessage,
  MessagesListRes,
  HistoryListReq,
  HistoryListRes,
  JobEventsReq,
  JobEventsRes,
  JobTimelineRes,
  JobsFiltersRes,
  JobsListReq,
  JobsListRes,
  Machine,
  MachinesListRes,
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
  DiagnosticsLogsRes,
  DiagnosticsLogTailReq,
  DiagnosticsLogTailRes,
  ThemePreferenceReq,
  ThemePreferenceRes,
  AllocatedMaterialListRes,
  OrderingListRes,
  OrderingUpdateReq,
  OrderingExportRes,
  OrderingRow,
  AuthStateRes,
  AuthSuccessRes,
  AuthLoginReq,
  AuthRegisterReq,
  AuthResetPasswordReq
} from '../../../shared/src';
import type { TelemetrySummaryReq, TelemetrySummaryRes, AlarmsHistoryReq, AlarmsHistoryRes } from '../../../shared/src';

declare global {
  interface Window {
    api: {
      auth: {
        me: () => Promise<Result<AuthStateRes, AppError>>;
        login: (req: AuthLoginReq) => Promise<Result<AuthSuccessRes, AppError>>;
        register: (req: AuthRegisterReq) => Promise<Result<AuthSuccessRes, AppError>>;
        resetPassword: (req: AuthResetPasswordReq) => Promise<Result<AuthSuccessRes, AppError>>;
        logout: () => Promise<Result<null, AppError>>;
      };
      settings: {
        get: () => Promise<Result<Settings, AppError>>;
        getPath: () => Promise<Result<string, AppError>>;
        save: (s: Settings) => Promise<Result<Settings, AppError>>;
        validatePath: (input: PathValidationReq) => Promise<Result<PathValidationRes, AppError>>;
      };
      db: {
        testConnection: (db: DbSettings) => Promise<Result<{ ok: true } | { ok: false; error: string }, AppError>>;
        getStatus: () => Promise<Result<DbStatus, AppError>>;
        subscribeStatus: (listener: (status: DbStatus) => void) => () => void;
      };
      jobs: {
        list: (req: JobsListReq) => Promise<Result<JobsListRes, AppError>>;
        filters: () => Promise<Result<JobsFiltersRes, AppError>>;
        events: (req: JobEventsReq) => Promise<Result<JobEventsRes, AppError>>;
        reserve: (key: string) => Promise<Result<null, AppError>>;
        unreserve: (key: string) => Promise<Result<null, AppError>>;
        lock: (key: string) => Promise<Result<null, AppError>>;
        unlock: (key: string) => Promise<Result<null, AppError>>;
        lockBatch: (keys: string[]) => Promise<Result<null, AppError>>;
        unlockBatch: (keys: string[]) => Promise<Result<null, AppError>>;
        rerun: (key: string) => Promise<Result<null, AppError>>;
        rerunAndStage: (key: string, machineId: number) => Promise<Result<WorklistAddResult, AppError>>;
        addToWorklist: (key: string, machineId: number) => Promise<Result<WorklistAddResult, AppError>>;
        resync: () => Promise<Result<{ inserted: number; updated: number; pruned: number; addedJobs: { ncFile: string; folder: string }[]; updatedJobs: { ncFile: string; folder: string }[]; prunedJobs: { key: string; folder: string; ncFile: string; material: string | null; preReserved: boolean }[] }, AppError>>;
      };
      machines: {
        list: () => Promise<Result<MachinesListRes, AppError>>;
        save: (m: SaveMachineReq) => Promise<Result<Machine, AppError>>;
        delete: (id: number) => Promise<Result<null, AppError>>;
      };
      dialog: {
        pickFolder: () => Promise<Result<string | null, AppError>>;
      };
      files: {
        listReady: (machineId: number) => Promise<Result<ReadyListRes, AppError>>;
        importReady: (input: ReadyImportReq) => Promise<Result<ReadyImportRes, AppError>>;
        deleteReadyAssets: (input: ReadyDeleteReq) => Promise<Result<ReadyDeleteRes, AppError>>;
        subscribeReady: (
          machineId: number,
          listener: (payload: ReadyListRes) => void
        ) => () => void;
      };
      router: {
        list: (req?: RouterListReq) => Promise<Result<RouterListRes, AppError>>;
      };
      grundner: {
        list: (req?: GrundnerListReq) => Promise<Result<GrundnerListRes, AppError>>;
        update: (input: GrundnerUpdateReq) => Promise<Result<{ ok: boolean; updated: number }, AppError>>;
        resync: (input?: GrundnerResyncReq) => Promise<Result<{ updated: number }, AppError>>;
        subscribeRefresh: (listener: () => void) => () => void;
      };
      allocatedMaterial: {
        list: () => Promise<Result<AllocatedMaterialListRes, AppError>>;
        subscribe: (listener: () => void) => () => void;
      };
      messages: {
        list: () => Promise<Result<MessagesListRes, AppError>>;
        unreadCount: () => Promise<Result<number, AppError>>;
        markAllRead: () => Promise<Result<null, AppError>>;
        subscribe: (listener: (entry: AppMessage) => void) => () => void;
        subscribeCount: (listener: (count: number) => void) => () => void;
      };
      hypernest: {
        open: () => Promise<Result<null, AppError>>;
      };
      alarms: {
        list: () => Promise<Result<AlarmEntry[], AppError>>;
        history: (req: AlarmsHistoryReq) => Promise<Result<AlarmsHistoryRes, AppError>>;
        subscribe: (listener: (alarms: AlarmEntry[]) => void) => () => void;
      };
      telemetry: {
        summary: (req: TelemetrySummaryReq) => Promise<Result<TelemetrySummaryRes, AppError>>;
        subscribe: (
          req: TelemetrySummaryReq,
          listener: (payload: TelemetrySummaryRes) => void
        ) => () => void;
      };
      diagnostics: {
        get: () => Promise<Result<DiagnosticsSnapshot, AppError>>;
        copy: () => Promise<Result<CopyDiagnosticsResult, AppError>>;
        restartWatchers: () => Promise<Result<{ ok: true }, AppError>>;
        listLogs: () => Promise<Result<DiagnosticsLogsRes, AppError>>;
        logTail: (req: DiagnosticsLogTailReq) => Promise<Result<DiagnosticsLogTailRes, AppError>>;
        subscribe: (listener: (snapshot: DiagnosticsSnapshot) => void) => () => void;
      };
      ui: {
        theme: {
          get: () => Promise<Result<ThemePreferenceRes, AppError>>;
          set: (req: ThemePreferenceReq) => Promise<Result<ThemePreferenceRes, AppError>>;
        };
      };
      history: {
        list: (req?: HistoryListReq) => Promise<Result<HistoryListRes, AppError>>;
        timeline: (key: string) => Promise<Result<JobTimelineRes | null, AppError>>;
      };
      ordering: {
        list: () => Promise<Result<OrderingListRes, AppError>>;
        update: (input: OrderingUpdateReq) => Promise<Result<OrderingRow, AppError>>;
        exportCsv: () => Promise<Result<OrderingExportRes, AppError>>;
        exportPdf: () => Promise<Result<OrderingExportRes, AppError>>;
      };
    };
  }
}

export {};

