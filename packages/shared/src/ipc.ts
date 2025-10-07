import { z } from 'zod';
import type { ResultEnvelope } from './result';

export const SslMode = z.enum(['disable', 'require', 'verify-ca', 'verify-full']);

export const DbSettingsSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(5432),
  database: z.string().min(1),
  user: z.string().min(1),
  password: z.string().min(1, 'Password is required'),
  sslMode: SslMode.default('disable'),
  statementTimeoutMs: z.number().int().min(0).max(600000).default(30000)
});
export type DbSettings = z.infer<typeof DbSettingsSchema>;

export const DbStatusSchema = z.object({
  online: z.boolean(),
  checkedAt: z.string(),
  latencyMs: z.number().int().nonnegative().nullable(),
  error: z.string().nullable()
});
export type DbStatus = z.infer<typeof DbStatusSchema>;

export const CURRENT_SETTINGS_VERSION = 1 as const;

export const ThemePreference = z.enum(['system', 'light', 'dark', 'modern']);
export type ThemePreference = z.infer<typeof ThemePreference>;

export const ThemePreferenceReq = z.object({ preference: ThemePreference });
export type ThemePreferenceReq = z.infer<typeof ThemePreferenceReq>;

export const ThemePreferenceRes = z.object({ preference: ThemePreference });
export type ThemePreferenceRes = z.infer<typeof ThemePreferenceRes>;

export const SettingsSchema = z.object({
  version: z.number().int().min(1).default(CURRENT_SETTINGS_VERSION),
  db: DbSettingsSchema,
  paths: z.object({
    processedJobsRoot: z.string().default(''),
    autoPacCsvDir: z.string().default(''),
    grundnerFolderPath: z.string().default(''),
  }).default({ processedJobsRoot: '', autoPacCsvDir: '', grundnerFolderPath: '' }),
  test: z.object({
    testDataFolderPath: z.string().default(''),
    useTestDataMode: z.boolean().default(false),
    sheetIdMode: z.enum(['type_data', 'customer_id']).default('type_data')
  }).default({ testDataFolderPath: '', useTestDataMode: false, sheetIdMode: 'type_data' }),
  grundner: z.object({
    reservedAdjustmentMode: z.enum(['delta', 'absolute']).default('delta')
  }).default({ reservedAdjustmentMode: 'delta' })
});
export type Settings = z.infer<typeof SettingsSchema>;

export const AppErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.any().optional()
});
export type AppError = z.infer<typeof AppErrorSchema>;

export const JobStatus = z.enum([
  'PENDING',
  'STAGED',
  'LOAD_FINISH',
  'LABEL_FINISH',
  'CNC_FINISH',
  'FORWARDED_TO_NESTPICK',
  'NESTPICK_COMPLETE'
]);
export const JOB_STATUS_VALUES = JobStatus.options;
export type JobStatus = z.infer<typeof JobStatus>;

export const JobsListFilter = z.object({
  folder: z.string().optional(),
  material: z.string().optional(),
  materialIn: z.array(z.string().min(1)).optional(),
  size: z.string().optional(),
  thickness: z.string().optional(),
  status: z.enum(['all', 'cut', 'uncut']).optional(),
  statusIn: z.array(JobStatus).optional(),
  machineId: z.number().int().optional()
});

export const JobsListReq = z.object({
  search: z.string().optional(),
  sortBy: z.enum(['folder', 'ncfile', 'material', 'parts', 'size', 'thickness', 'dateadded', 'reserved', 'status']).default('dateadded'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  cursor: z.string().nullable().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  filter: JobsListFilter.default({})
});
export type JobsListReq = z.infer<typeof JobsListReq>;

export const JobRow = z.object({
  key: z.string(),
  folder: z.string().nullable(),
  ncfile: z.string().nullable(),
  material: z.string().nullable(),
  parts: z.string().nullable(),
  size: z.string().nullable(),
  thickness: z.string().nullable(),
  dateadded: z.string().nullable(),
  reserved: z.boolean(),
  status: JobStatus,
  machineId: z.number().int().nullable(),
  processingSeconds: z.number().int().nullable().optional()
});
export type JobRow = z.infer<typeof JobRow>;

export const JobsListRes = z.object({
  items: z.array(JobRow),
  nextCursor: z.string().nullable()
});
export type JobsListRes = z.infer<typeof JobsListRes>;

export const JobsFilterOptions = z.object({
  materials: z.array(z.string().min(1)),
  statuses: z.array(JobStatus)
});
export type JobsFilterOptions = z.infer<typeof JobsFilterOptions>;

export const JobsFiltersRes = z.object({ options: JobsFilterOptions });
export type JobsFiltersRes = z.infer<typeof JobsFiltersRes>;

export const ReserveReq = z.object({ key: z.string().min(1) });
export type ReserveReq = z.infer<typeof ReserveReq>;

export const UnreserveReq = z.object({ key: z.string().min(1) });
export type UnreserveReq = z.infer<typeof UnreserveReq>;

export const JobEvent = z.object({
  id: z.number().int(),
  key: z.string(),
  eventType: z.string(),
  payload: z.unknown().nullable(),
  machineId: z.number().int().nullable(),
  createdAt: z.string()
});
export type JobEvent = z.infer<typeof JobEvent>;

export const JobEventsReq = z.object({
  key: z.string().min(1),
  limit: z.number().int().min(1).max(200).default(50)
});
export type JobEventsReq = z.infer<typeof JobEventsReq>;

export const JobEventsRes = z.object({ events: z.array(JobEvent) });
export type JobEventsRes = z.infer<typeof JobEventsRes>;

export type Result<T> = ResultEnvelope<T>;

export const Machine = z.object({
  machineId: z.number().int(),
  name: z.string(),
  pcIp: z.string().nullable().optional(),
  cncIp: z.string().nullable().optional(),
  cncPort: z.number().int().nullable().optional(),
  apJobfolder: z.string(),
  nestpickFolder: z.string(),
  nestpickEnabled: z.boolean(),
  pcPort: z.number().int()
});
export type Machine = z.infer<typeof Machine>;

export const SaveMachineReq = Machine.partial({ machineId: true }).extend({ machineId: z.number().int().optional() });
export type SaveMachineReq = z.infer<typeof SaveMachineReq>;

export const MachinesListRes = z.object({ items: z.array(Machine) });
export type MachinesListRes = z.infer<typeof MachinesListRes>;


export const WorklistSkippedFile = z.object({
  relativePath: z.string(),
  reason: z.enum(['skip-pattern', 'exists', 'error']),
  message: z.string().optional()
});
export type WorklistSkippedFile = z.infer<typeof WorklistSkippedFile>;

export const WorklistCollisionInfo = z.object({
  originalPath: z.string(),
  redirectedPath: z.string()
});
export type WorklistCollisionInfo = z.infer<typeof WorklistCollisionInfo>;

export const WorklistAddSuccess = z.object({
  ok: z.literal(true),
  path: z.string(),
  copied: z.number().int(),
  skipped: z.array(WorklistSkippedFile),
  stagedAt: z.string().nullable(),
  alreadyStaged: z.boolean(),
  collision: WorklistCollisionInfo.optional()
});
export type WorklistAddSuccess = z.infer<typeof WorklistAddSuccess>;

export const WorklistAddFailure = z.object({
  ok: z.literal(false),
  error: z.string(),
  skipped: z.array(WorklistSkippedFile).optional()
});
export type WorklistAddFailure = z.infer<typeof WorklistAddFailure>;

export const WorklistAddResult = z.union([WorklistAddSuccess, WorklistAddFailure]);
export type WorklistAddResult = z.infer<typeof WorklistAddResult>;
export const ReadyFile = z.object({
  name: z.string(),
  relativePath: z.string(),
  size: z.number().int(),
  mtimeMs: z.number(),
  inDatabase: z.boolean(),
  jobKey: z.string().nullable(),
  status: JobStatus.nullable(),
  // Enriched job metadata when a matching job row exists
  jobMaterial: z.string().nullable().optional(),
  jobSize: z.string().nullable().optional(),
  jobParts: z.string().nullable().optional(),
  jobThickness: z.string().nullable().optional(),
  jobDateadded: z.string().nullable().optional(),
  // When the file appeared in Ready-To-Run (based on filesystem mtime)
  addedAtR2R: z.string().optional()
});
export type ReadyFile = z.infer<typeof ReadyFile>;
export const ReadyListRes = z.object({ machineId: z.number().int(), files: z.array(ReadyFile) });
export type ReadyListRes = z.infer<typeof ReadyListRes>;

export const ReadyImportReq = z.object({
  machineId: z.number().int(),
  relativePath: z.string().min(1)
});
export type ReadyImportReq = z.infer<typeof ReadyImportReq>;

export const ReadyImportRes = z.object({
  jobKey: z.string(),
  created: z.boolean(),
  status: JobStatus,
  folder: z.string(),
  ncfile: z.string(),
  material: z.string().nullable(),
  size: z.string().nullable(),
  thickness: z.string().nullable(),
  parts: z.string().nullable()
});
export type ReadyImportRes = z.infer<typeof ReadyImportRes>;

export const ReadyDeleteReq = z.object({
  machineId: z.number().int(),
  relativePaths: z.array(z.string().min(1)).min(1)
});
export type ReadyDeleteReq = z.infer<typeof ReadyDeleteReq>;

export const ReadyDeleteError = z.object({
  file: z.string(),
  message: z.string()
});
export type ReadyDeleteError = z.infer<typeof ReadyDeleteError>;

export const ReadyDeleteRes = z.object({
  deleted: z.number().int().nonnegative(),
  files: z.array(z.string()),
  errors: z.array(ReadyDeleteError)
});
export type ReadyDeleteRes = z.infer<typeof ReadyDeleteRes>;

export const RouterListReq = z.object({
  machineId: z.number().int().optional(),
  statusIn: z.array(JobStatus).optional(),
  limit: z.number().int().min(1).max(500).default(200)
});
export type RouterListReq = z.infer<typeof RouterListReq>;

export const RouterRow = z.object({
  key: z.string(),
  folder: z.string().nullable(),
  ncfile: z.string().nullable(),
  material: z.string().nullable(),
  status: JobStatus,
  machineId: z.number().int().nullable(),
  stagedAt: z.string().nullable(),
  cutAt: z.string().nullable(),
  nestpickCompletedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  pallet: z.string().nullable(),
  lastError: z.string().nullable()
});
export type RouterRow = z.infer<typeof RouterRow>;

export const RouterListRes = z.object({ items: z.array(RouterRow) });
export type RouterListRes = z.infer<typeof RouterListRes>;

export const LifecycleReq = z.object({
  key: z.string().min(1),
  to: JobStatus,
  machineId: z.number().int().nullable().optional(),
  source: z.string().min(1).optional(),
  payload: z.unknown().optional()
});
export type LifecycleReq = z.infer<typeof LifecycleReq>;

export const LifecycleRes = z.object({
  ok: z.boolean(),
  reason: z.enum(['NOT_FOUND', 'INVALID_TRANSITION', 'NO_CHANGE']).optional(),
  previousStatus: JobStatus.optional(),
  status: JobStatus.optional(),
  machineId: z.number().int().nullable().optional()
});
export type LifecycleRes = z.infer<typeof LifecycleRes>;
export const GrundnerFilter = z.object({
  search: z.string().optional(),
  onlyAvailable: z.boolean().optional(),
  onlyReserved: z.boolean().optional(),
  thicknessMin: z.number().int().optional(),
  thicknessMax: z.number().int().optional()
});

export const GrundnerListReq = z.object({
  limit: z.number().int().min(1).max(500).default(200),
  filter: GrundnerFilter.default({})
});
export type GrundnerListReq = z.infer<typeof GrundnerListReq>;

export const GrundnerRow = z.object({
  id: z.number().int(),
  typeData: z.number().int().nullable(),
  customerId: z.string().nullable(),
  lengthMm: z.number().int().nullable(),
  widthMm: z.number().int().nullable(),
  thicknessMm: z.number().int().nullable(),
  stock: z.number().int().nullable(),
  stockAvailable: z.number().int().nullable(),
  reservedStock: z.number().int().nullable(),
  lastUpdated: z.string().nullable()
});
export type GrundnerRow = z.infer<typeof GrundnerRow>;

export const GrundnerListRes = z.object({ items: z.array(GrundnerRow) });
export type GrundnerListRes = z.infer<typeof GrundnerListRes>;

export const GrundnerUpdateReq = z.object({
  id: z.number().int(),
  stock: z.number().int().nullable().optional(),
  stockAvailable: z.number().int().nullable().optional(),
  reservedStock: z.number().int().nullable().optional()
}).refine((data) =>
  Object.prototype.hasOwnProperty.call(data, 'stock') ||
  Object.prototype.hasOwnProperty.call(data, 'stockAvailable') ||
  Object.prototype.hasOwnProperty.call(data, 'reservedStock'),
  { message: 'At least one field must be provided' }
);
export type GrundnerUpdateReq = z.infer<typeof GrundnerUpdateReq>;

export const GrundnerResyncReq = z.object({ id: z.number().int().optional() });
export type GrundnerResyncReq = z.infer<typeof GrundnerResyncReq>;










export const PathValidationReq = z.object({
  path: z.string().min(1),
  kind: z.enum(['any', 'file', 'directory']).default('directory')
});
export type PathValidationReq = z.infer<typeof PathValidationReq>;

export const PathValidationRes = z.object({
  path: z.string(),
  exists: z.boolean(),
  isDirectory: z.boolean(),
  isFile: z.boolean(),
  error: z.string().nullable()
});
export type PathValidationRes = z.infer<typeof PathValidationRes>;
export const HistoryListReq = z.object({
  limit: z.number().int().min(1).max(200).default(100),
  machineId: z.number().int().optional(),
  search: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional()
});
export type HistoryListReq = z.infer<typeof HistoryListReq>;

export const HistoryRow = z.object({
  key: z.string(),
  folder: z.string().nullable(),
  ncfile: z.string().nullable(),
  material: z.string().nullable(),
  machineId: z.number().int().nullable(),
  machineName: z.string().nullable(),
  machineNestpickEnabled: z.boolean().nullable(),
  status: JobStatus,
  stagedAt: z.string().nullable(),
  cutAt: z.string().nullable(),
  nestpickCompletedAt: z.string().nullable(),
  finishAt: z.string(),
  finishSource: z.enum(['cut', 'nestpick']),
  pallet: z.string().nullable(),
  updatedAt: z.string().nullable()
});
export type HistoryRow = z.infer<typeof HistoryRow>;

export const HistoryListRes = z.object({ items: z.array(HistoryRow) });
export type HistoryListRes = z.infer<typeof HistoryListRes>;

export const JobTimelineEvent = z.object({
  id: z.string(),
  eventType: z.string(),
  createdAt: z.string().nullable(),
  machineId: z.number().int().nullable(),
  machineName: z.string().nullable(),
  payload: z.unknown().nullable()
});
export type JobTimelineEvent = z.infer<typeof JobTimelineEvent>;

export const JobTimelineRes = z.object({
  job: z.object({
    key: z.string(),
    folder: z.string().nullable(),
    ncfile: z.string().nullable(),
    material: z.string().nullable(),
    machineId: z.number().int().nullable(),
    machineName: z.string().nullable(),
    machineNestpickEnabled: z.boolean().nullable(),
    status: JobStatus,
    dateadded: z.string().nullable(),
    stagedAt: z.string().nullable(),
    cutAt: z.string().nullable(),
    nestpickCompletedAt: z.string().nullable(),
    finishAt: z.string().nullable(),
    finishSource: z.enum(['pending', 'cut', 'nestpick']),
    pallet: z.string().nullable(),
    updatedAt: z.string().nullable()
  }),
  events: z.array(JobTimelineEvent)
});
export type JobTimelineRes = z.infer<typeof JobTimelineRes>;

const ALARM_INACTIVE_VALUES = ['ok', 'ready', '0', 'none', ''] as const;

export const AlarmEntry = z.object({
  id: z.string(),
  key: z.string(),
  alarm: z.string(),
  status: z.string().nullable().optional(),
  mode: z.string().nullable().optional(),
  currentProgram: z.string().nullable().optional(),
  alarmHistory: z.string().nullable().optional(),
  lastSeenAt: z.string(),
  severity: z.enum(['info', 'warning', 'critical']).default('warning')
});
export type AlarmEntry = z.infer<typeof AlarmEntry>;

export const WatcherStatus = z.object({
  name: z.string(),
  label: z.string(),
  status: z.enum(['idle', 'watching', 'error']),
  lastEventAt: z.string().nullable(),
  lastEvent: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
  lastError: z.string().nullable()
});
export type WatcherStatus = z.infer<typeof WatcherStatus>;

export const WorkerErrorEntry = z.object({
  id: z.string(),
  source: z.string(),
  message: z.string(),
  timestamp: z.string(),
  stack: z.string().nullable().optional(),
  context: z.record(z.unknown()).optional()
});
export type WorkerErrorEntry = z.infer<typeof WorkerErrorEntry>;

export const MachineHealthCode = z.enum(['NO_PARTS_CSV', 'NESTPICK_SHARE_UNREACHABLE', 'COPY_FAILURE']);
export type MachineHealthCode = z.infer<typeof MachineHealthCode>;

export const MachineHealthEntry = z.object({
  id: z.string(),
  machineId: z.number().int().nullable(),
  code: MachineHealthCode,
  severity: z.enum(['info', 'warning', 'critical']).default('warning'),
  message: z.string(),
  lastUpdatedAt: z.string(),
  context: z.record(z.unknown()).optional()
});
export type MachineHealthEntry = z.infer<typeof MachineHealthEntry>;

export const DiagnosticsSnapshot = z.object({
  dbStatus: DbStatusSchema.optional(),
  watchers: z.array(WatcherStatus),
  recentErrors: z.array(WorkerErrorEntry),
  machineHealth: z.array(MachineHealthEntry),
  lastUpdatedAt: z.string()
});
export type DiagnosticsSnapshot = z.infer<typeof DiagnosticsSnapshot>;

export const DiagnosticsLogSummary = z.object({
  file: z.string(),
  name: z.string(),
  size: z.number().int().nonnegative().nullable(),
  updatedAt: z.string().nullable()
});
export type DiagnosticsLogSummary = z.infer<typeof DiagnosticsLogSummary>;

export const DiagnosticsLogsRes = z.object({ items: z.array(DiagnosticsLogSummary) });
export type DiagnosticsLogsRes = z.infer<typeof DiagnosticsLogsRes>;

export const DiagnosticsLogTailReq = z.object({
  file: z.string(),
  limit: z.number().int().min(10).max(2000).default(200)
});
export type DiagnosticsLogTailReq = z.infer<typeof DiagnosticsLogTailReq>;

export const DiagnosticsLogTailRes = DiagnosticsLogSummary.extend({
  lines: z.array(z.string()),
  limit: z.number().int().min(10).max(2000),
  available: z.number().int().nonnegative().nullable()
});
export type DiagnosticsLogTailRes = z.infer<typeof DiagnosticsLogTailRes>;


export const AlarmInactiveValues = z.enum(ALARM_INACTIVE_VALUES);

export const CopyDiagnosticsLog = DiagnosticsLogSummary.extend({
  lines: z.array(z.string()),
  available: z.number().int().nonnegative().nullable()
});
export type CopyDiagnosticsLog = z.infer<typeof CopyDiagnosticsLog>;

export const CopyDiagnosticsResult = z.object({
  ok: z.literal(true),
  copiedAt: z.string(),
  bytes: z.number().int().nonnegative(),
  logCount: z.number().int().nonnegative(),
  logs: z.array(CopyDiagnosticsLog),
  snapshot: DiagnosticsSnapshot
});
export type CopyDiagnosticsResult = z.infer<typeof CopyDiagnosticsResult>;



// Live log streaming
export const DiagnosticsLogStreamReq = z.object({ file: z.string() });
export type DiagnosticsLogStreamReq = z.infer<typeof DiagnosticsLogStreamReq>;

export const DiagnosticsLogUpdate = z.object({ file: z.string(), lines: z.array(z.string()) });
export type DiagnosticsLogUpdate = z.infer<typeof DiagnosticsLogUpdate>;

// Cross‑process Logging
export const LogLevel = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
export type LogLevel = z.infer<typeof LogLevel>;

export const LogWriteReq = z.object({
  level: LogLevel.default('info'),
  msg: z.string().min(1),
  context: z.record(z.unknown()).optional()
});
export type LogWriteReq = z.infer<typeof LogWriteReq>;


// CNC Telemetry & Alarms

export const TelemetrySummaryReq = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  machineIds: z.array(z.number().int()).optional()
});
export type TelemetrySummaryReq = z.infer<typeof TelemetrySummaryReq>;

export const TelemetrySeconds = z.object({
  READY: z.number().int().nonnegative().default(0),
  'B-STOP': z.number().int().nonnegative().default(0),
  BUSY: z.number().int().nonnegative().default(0),
  ALARM: z.number().int().nonnegative().default(0),
  EMG: z.number().int().nonnegative().default(0),
  OTHER: z.number().int().nonnegative().default(0)
});
export type TelemetrySeconds = z.infer<typeof TelemetrySeconds>;

export const TelemetryMachineSummary = z.object({
  machineId: z.number().int().nullable(),
  machineName: z.string().nullable(),
  seconds: TelemetrySeconds
});
export type TelemetryMachineSummary = z.infer<typeof TelemetryMachineSummary>;

export const TelemetrySummaryRes = z.object({ items: z.array(TelemetryMachineSummary) });
export type TelemetrySummaryRes = z.infer<typeof TelemetrySummaryRes>;

export const AlarmsHistoryReq = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  machineIds: z.array(z.number().int()).optional()
});
export type AlarmsHistoryReq = z.infer<typeof AlarmsHistoryReq>;

export const AlarmIntervalRow = z.object({
  startAt: z.string(),
  endAt: z.string().nullable(),
  durationMinutes: z.number().int().nonnegative(),
  machineId: z.number().int().nullable(),
  machineName: z.string().nullable(),
  alarmId: z.string().nullable(),
  description: z.string()
});
export type AlarmIntervalRow = z.infer<typeof AlarmIntervalRow>;

export const AlarmsHistoryRes = z.object({ items: z.array(AlarmIntervalRow) });
export type AlarmsHistoryRes = z.infer<typeof AlarmsHistoryRes>;
