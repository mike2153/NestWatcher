import chokidar, { type FSWatcher } from 'chokidar';
import { createHash } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { promises as fsp } from 'fs';
import type { Dirent } from 'fs';
import { basename, extname, join, normalize, relative } from 'path';
import type { PoolClient } from 'pg';
import { parentPort } from 'worker_threads';
import type { Machine, MachineHealthCode } from '../../../shared/src';
import { loadConfig } from '../services/config';
import { logger } from '../logger';
import { getPool, testConnection, withClient } from '../services/db';
import { appendJobEvent } from '../repo/jobEventsRepo';
import { upsertGrundnerInventory, type GrundnerCsvRow, findGrundnerAllocationConflicts } from '../repo/grundnerRepo';
import { listMachines } from '../repo/machinesRepo';
import { findJobByNcBase, findJobByNcBasePreferStatus, updateJobPallet, updateLifecycle, resyncGrundnerPreReservedForMaterial } from '../repo/jobsRepo';
import { bulkUpsertCncStats } from '../repo/cncStatsRepo';
import type { CncStatsUpsert } from '../repo/cncStatsRepo';
import type { WatcherWorkerToMainMessage, MainToWatcherMessage } from './watchersMessages';
import { ingestProcessedJobsRoot } from '../services/ingest';
import { appendProductionListDel } from '../services/nestpick';
import { archiveCompletedJob } from '../services/archive';
import { getGrundnerLookupColumn } from '../services/grundner';

const { access, copyFile, readFile, readdir, rename, stat, unlink, open } = fsp;

const channel = parentPort;
const fsWatchers = new Set<FSWatcher>();

function postMessageToMain(message: WatcherWorkerToMainMessage) {
  if (!channel) {
    logger.debug({ messageType: message?.type }, 'watchersWorker: parentPort unavailable; skipping message');
    return;
  }
  try {
    channel.postMessage(message);
  } catch (err) {
    logger.warn({ err }, 'watchersWorker: failed to post message');
  }
}

function serializeError(error: unknown): { message: string; stack?: string | null } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack ?? null };
  }
  if (typeof error === 'string') {
    return { message: error };
  }
  try {
    return { message: JSON.stringify(error) };
  } catch {
    return { message: String(error) };
  }
}

function registerWatcher(name: string, label: string) {
  postMessageToMain({ type: 'registerWatcher', name, label });
}

function watcherReady(name: string, label: string) {
  postMessageToMain({ type: 'watcherReady', name, label });
}

function recordWatcherEvent(
  name: string,
  event: { label?: string; message: string; context?: Record<string, unknown> }
) {
  postMessageToMain({ type: 'watcherEvent', name, label: event.label, message: event.message, context: event.context });
}

function recordWatcherError(
  name: string,
  error: unknown,
  context?: Record<string, unknown> & { label?: string }
) {
  const { label, ...rest } = context ?? {};
  postMessageToMain({
    type: 'watcherError',
    name,
    label: label as string | undefined,
    error: serializeError(error),
    context: rest && Object.keys(rest).length ? rest : undefined
  });
}

function recordWorkerError(source: string, error: unknown, context?: Record<string, unknown>) {
  postMessageToMain({ type: 'workerError', source, error: serializeError(error), context });
}

function setMachineHealthIssue(params: {
  machineId: number | null;
  code: MachineHealthCode;
  message: string;
  severity?: 'info' | 'warning' | 'critical';
  context?: Record<string, unknown>;
}) {
  postMessageToMain({ type: 'machineHealthSet', payload: params });
}

function clearMachineHealthIssue(machineId: number | null, code: MachineHealthCode) {
  postMessageToMain({ type: 'machineHealthClear', payload: { machineId, code } });
}

function emitAppMessage(event: string, params?: Record<string, unknown>, source?: string) {
  postMessageToMain({
    type: 'appMessage',
    event,
    params,
    timestamp: new Date().toISOString(),
    source
  });
}

type LifecycleMessageJob = {
  folder: string | null;
  ncfile: string | null;
};

function emitLifecycleStageMessage(
  status: 'LOAD_FINISH' | 'LABEL_FINISH' | 'CNC_FINISH' | 'NESTPICK_COMPLETE',
  job: LifecycleMessageJob,
  fallbackBase: string,
  machine: Machine | null | undefined,
  source: string,
  extras?: Record<string, unknown>
) {
  let key: string | null = null;
  switch (status) {
    case 'LOAD_FINISH':
      key = 'status.load_finish';
      break;
    case 'LABEL_FINISH':
      key = 'status.label_finish';
      break;
    case 'CNC_FINISH':
      key = 'status.cnc_finish';
      break;
    case 'NESTPICK_COMPLETE':
      key = 'status.nestpick_complete';
      break;
    default:
      key = null;
  }
  if (!key) return;
  const normalizedBase = fallbackBase.toLowerCase().endsWith('.nc') ? fallbackBase : `${fallbackBase}.nc`;
  const machineName =
    machine?.name ?? (machine?.machineId != null ? `Machine ${machine.machineId}` : 'Unknown machine');
  const payload: Record<string, unknown> = {
    ncFile: displayNcName(job.ncfile, normalizedBase),
    folder: job.folder ?? '',
    machineName
  };
  if (extras && Object.keys(extras).length) {
    Object.assign(payload, extras);
  }
  emitAppMessage(key, payload, source);
}

function trackWatcher(watcher: FSWatcher) {
  fsWatchers.add(watcher);
  watcher.on('close', () => fsWatchers.delete(watcher));
}

let shuttingDown = false;
let jobsIngestInterval: NodeJS.Timeout | null = null;
let processedRootMissingNotified = false;
let stageSanityTimer: NodeJS.Timeout | null = null;
let sourceSanityTimer: NodeJS.Timeout | null = null;

const autoPacHashes = new Map<string, string>();
const pendingGrundnerReleases = new Map<string, number>();
const PENDING_GRUNDNER_RELEASE_TTL_MS = 60_000;
const pendingGrundnerConflicts = new Map<string, number>();
const GRUNDNER_CONFLICT_GRACE_MS = 120_000;

const NESTPICK_UNSTACK_FILENAME = 'Report_FullNestpickUnstack.csv';

const AUTOPAC_WATCHER_NAME = 'watcher:autopac';
const AUTOPAC_WATCHER_LABEL = 'AutoPAC CSV Watcher';
const HEALTH_CODES: Record<'noParts' | 'nestpickShare' | 'copyFailure', MachineHealthCode> = {
  noParts: 'NO_PARTS_CSV',
  nestpickShare: 'NESTPICK_SHARE_UNREACHABLE',
  copyFailure: 'COPY_FAILURE'
};

const TESTDATA_WATCHER_NAME = 'watcher:testdata';
const TESTDATA_WATCHER_LABEL = 'Test Data Telemetry';
const TESTDATA_PROCESSED_DIR = 'processed';
const TESTDATA_FAILED_DIR = 'failed';

const NCCAT_WATCHER_NAME = 'watcher:nccat';
const NCCAT_WATCHER_LABEL = 'NC Cat Jobs Watcher';
const TESTDATA_SKIP_DIRS = new Set([TESTDATA_PROCESSED_DIR, TESTDATA_FAILED_DIR]);

// Serial processing queue for test data files
const testDataQueue: string[] = [];
const testDataQueued = new Set<string>();
let testDataProcessing = false;
//
let testDataIndex: string[] = [];
let testDataIndexPos = 0;
let testDataIndexBuilt = false;

// Grundner poller
const GRUNDNER_WATCHER_NAME = 'watcher:grundner';
const GRUNDNER_WATCHER_LABEL = 'Grundner Stock Poller';
let grundnerTimer: NodeJS.Timeout | null = null;
let grundnerLastHash: string | null = null;

type RefreshChannel = 'grundner' | 'allocated-material';
const refreshTimers = new Map<RefreshChannel, NodeJS.Timeout>();
let notificationClient: PoolClient | null = null;
let notificationRestartTimer: NodeJS.Timeout | null = null;

const STAGE_SANITY_WATCHER_NAME = 'watcher:stage-sanity';
const STAGE_SANITY_WATCHER_LABEL = 'Stage Sanity';
const SOURCE_SANITY_WATCHER_NAME = 'watcher:source-sanity';
const SOURCE_SANITY_WATCHER_LABEL = 'Source Sanity';

function machineLabel(machine: Machine) {
  return machine.name ? `${machine.name} (#${machine.machineId})` : `Machine ${machine.machineId}`;
}

function nestpickProcessedWatcherName(machine: Machine) {
  return `watcher:nestpick-processed:${machine.machineId}`;
}

function nestpickProcessedWatcherLabel(machine: Machine) {
  return `Nestpick Processed (${machineLabel(machine)})`;
}

function nestpickUnstackWatcherName(machine: Machine) {
  return `watcher:nestpick-unstack:${machine.machineId}`;
}

function nestpickUnstackWatcherLabel(machine: Machine) {
  return `Nestpick Unstack (${machineLabel(machine)})`;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDbReady(maxAttempts = 10, initialDelayMs = 500) {
  const maxDelay = 5000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await testConnection();
      if (result.ok) {
        if (attempt > 1) {
          logger.info({ attempt }, 'watchers: database connection established after retries');
        }
        return;
      }
      throw new Error(result.error);
    } catch (err) {
      const delayMs = Math.min(initialDelayMs * Math.pow(2, attempt - 1), maxDelay);
      logger.warn({ err, attempt, maxAttempts, delayMs }, 'watchers: database not ready, retrying');
      await delay(delayMs);
    }
  }
  throw new Error('watchers: database not ready after maximum retries');
}

async function fileExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForStableFile(path: string, attempts = 5, intervalMs = 1000) {
  let lastSize = -1;
  let lastMtime = -1;
  for (let i = 0; i < attempts; i++) {
    const info = await stat(path);
    if (info.size === lastSize && info.mtimeMs === lastMtime) {
      return info;
    }
    lastSize = info.size;
    lastMtime = info.mtimeMs;
    await delay(intervalMs);
  }
  return stat(path);
}

async function waitForFileRelease(path: string, attempts = 10, intervalMs = 200) {
  for (let i = 0; i < attempts; i++) {
    try {
      const handle = await open(path, 'r');
      await handle.close();
      return true;
    } catch (err) {
      await delay(intervalMs);
    }
  }
  return false;
}

function scheduleRendererRefresh(channel: RefreshChannel) {
  if (refreshTimers.has(channel)) return;
  const timer = setTimeout(() => {
    refreshTimers.delete(channel);
    postMessageToMain({ type: 'dbNotify', channel });
  }, 250);
  if (typeof timer.unref === 'function') timer.unref();
  refreshTimers.set(channel, timer);
}

async function startDbNotificationListener() {
  try {
    await withClient(async () => {
      /* Ensure pool is ready */
    });
    const pool = getPool();
    if (!pool) {
      throw new Error('watchers: database pool unavailable for LISTEN');
    }
    const client = await pool.connect();
    notificationClient = client;
    await client.query('SET search_path TO public');
    await client.query('LISTEN grundner_changed');
    await client.query('LISTEN allocated_material_changed');
    client.on('notification', (msg) => {
      if (!msg.channel) return;
      if (msg.channel === 'grundner_changed') {
        scheduleRendererRefresh('grundner');
      } else if (msg.channel === 'allocated_material_changed') {
        scheduleRendererRefresh('allocated-material');
      }
    });
    client.on('error', (err) => {
      recordWorkerError('watchers:db-listener', err);
      try {
        client.removeAllListeners();
        client.release();
      } catch {
        /* noop */
      }
      notificationClient = null;
      if (!notificationRestartTimer) {
        notificationRestartTimer = setTimeout(() => {
          notificationRestartTimer = null;
          void startDbNotificationListener();
        }, 1000);
        if (typeof notificationRestartTimer.unref === 'function') {
          notificationRestartTimer.unref();
        }
      }
    });
    client.on('end', () => {
      notificationClient = null;
      if (!notificationRestartTimer && !shuttingDown) {
        notificationRestartTimer = setTimeout(() => {
          notificationRestartTimer = null;
          void startDbNotificationListener();
        }, 1000);
        if (typeof notificationRestartTimer.unref === 'function') {
          notificationRestartTimer.unref();
        }
      }
    });
  } catch (err) {
    recordWorkerError('watchers:db-listener', err);
    if (!notificationRestartTimer && !shuttingDown) {
      notificationRestartTimer = setTimeout(() => {
        notificationRestartTimer = null;
        void startDbNotificationListener();
      }, 1000);
      if (typeof notificationRestartTimer.unref === 'function') {
        notificationRestartTimer.unref();
      }
    }
  }
}

async function hashFile(path: string) {
  const buffer = await readFile(path);
  return createHash('sha1').update(buffer).digest('hex');
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if ((ch === ',' || ch === ';' || ch === '\t') && !inQuotes) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map((cell) => cell.trim());
}

async function unlinkWithRetry(path: string, attempts = 3, waitMs = 200) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await unlink(path);
      if (attempt > 1) {
        logger.warn({ path, attempts: attempt }, 'watcher: unlink succeeded after retries');
      }
      return true;
    } catch (err) {
      if (attempt === attempts) {
        logger.error({ err, path, attempts }, 'watcher: failed to delete file after retries');
        return false;
      }
      await delay(waitMs * attempt);
    }
  }
  return false;
}

function parseCsvContent(content: string) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .map(splitCsvLine);
}

function extractBases(rows: string[][], fallback: string) {
  const bases = new Set<string>();
  for (const row of rows) {
    for (const raw of row) {
      const cell = raw.replace(/^"|"$/g, '').trim();
      if (!cell) continue;
      const match = cell.match(/^([A-Za-z0-9_.-]+)(?:\.nc)?$/);
      if (!match) continue;
      const candidate = match[1];
      if (candidate.length < 3) continue;
      bases.add(candidate);
      break;
    }
  }
  if (bases.size === 0 && fallback) {
    const fileBase = fallback.toLowerCase().split('_')[0]?.replace(/\.csv$/i, '').replace(/\.nc$/i, '');
    if (fileBase) bases.add(fileBase);
  }
  return Array.from(bases);
}

function toPosixLower(path: string) {
  return path.replace(/\\/g, '/').toLowerCase();
}

function isTestDataInternalPath(path: string) {
  const lower = toPosixLower(path);
  for (const segment of TESTDATA_SKIP_DIRS) {
    if (lower.includes(`/${segment}/`) || lower.endsWith(`/${segment}`)) {
      return true;
    }
  }
  return false;
}

function isTestDataFileName(filePath: string) {
  const name = basename(filePath).toLowerCase();
  if (!name.startsWith('cnc_data') && !name.startsWith('cnc_stats')) return false;
  const extension = extname(name);
  if (!extension) return true;
  return extension === '.csv' || extension === '.json' || extension === '.ndjson' || extension === '.txt';
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pickCaseInsensitive(source: Record<string, unknown> | null, candidates: string[]): unknown {
  if (!source) return undefined;
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    for (const [key, val] of Object.entries(source)) {
      if (key.toLowerCase() === lower) {
        return val;
      }
    }
  }
  return undefined;
}

function toStringOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return Number.isFinite(Number(value)) ? String(value) : null;
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return null;
}

function inferTimestampFromFileName(fileName: string): string | null {
  const match = fileName.match(/(\d{4})[._-]?(\d{2})[._-]?(\d{2})[T_\- ]?(\d{2})[._-]?(\d{2})[._-]?(\d{2})/);
  if (!match) return null;
  return `${match[1]}.${match[2]}.${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
}

function stripCsvCell(value: string | undefined): string {
  if (typeof value !== 'string') return '';
  return value.replace(/^"|"$/g, '').trim();
}

function normalizeHeaderName(name: string, index: number, seen: Map<string, number>): string {
  let base = stripCsvCell(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!base) {
    base = `column_${index + 1}`;
  }
  const count = (seen.get(base) ?? 0) + 1;
  seen.set(base, count);
  if (count > 1) {
    return `${base}_${count}`;
  }
  return base;
}

function parseTestDataCsv(raw: string): Record<string, unknown>[] {
  const rows = parseCsvContent(raw);
  if (rows.length <= 1) return [];
  const headers = rows[0];
  const seen = new Map<string, number>();
  const keys = headers.map((header, idx) => normalizeHeaderName(header, idx, seen));
  const records: Record<string, unknown>[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const record: Record<string, unknown> = {};
    let hasValue = false;
    for (let j = 0; j < keys.length; j++) {
      const key = keys[j];
      const rawCell = row[j] ?? '';
      const value = stripCsvCell(rawCell);
      if (value.length === 0) continue;
      record[key] = value;
      hasValue = true;
    }
    if (hasValue) records.push(record);
  }
  return records;
}

function parseTestDataPayloads(raw: string, fileName: string): unknown[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  const normalized = trimmed.replace(/^\uFEFF/, '');
  try {
    const parsed = JSON.parse(normalized);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const out: unknown[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* ignore non-JSON lines */
      }
    }
    if (out.length) return out;
  }
  const csvRecords = parseTestDataCsv(raw);
  if (csvRecords.length) return csvRecords;
  throw new Error(`Unable to parse test data file ${fileName}; expected JSON, NDJSON, or CSV payload`);
}

function pickString(sources: Array<Record<string, unknown> | null>, candidates: string[]): string | null {
  for (const source of sources) {
    if (!source) continue;
    const value = toStringOrNull(pickCaseInsensitive(source, candidates));
    if (value != null) return value;
  }
  return null;
}

function machineTokenFromFileName(fileName: string): string | null {
  const baseName = basename(fileName, extname(fileName));
  // Try to extract machine token from common patterns like "machinename_timestamp" or "machine-timestamp"
  const parts = baseName.split(/[-_]/);
  if (parts.length > 0) {
    const token = parts[0].trim();
    if (token.length > 0) return token;
  }
  return null;
}

function buildTestDataUpsert(entry: unknown, fileName: string): CncStatsUpsert | null {
  const record = toRecord(entry);
  if (!record) {
    logger.warn({ file: fileName }, 'test-data: payload is not an object, skipping');
    return null;
  }

  const machineStatus = toRecord(pickCaseInsensitive(record, ['MachineStatus', 'machineStatus', 'machine_status']));
  const timers = toRecord(pickCaseInsensitive(record, ['Timers', 'timers', 'timer']));

  let timestampValue =
    pickString([record], ['timestamp', 'time', 'ts', 'key']) ??
    inferTimestampFromFileName(basename(fileName));

  // Keep original timestamp format if it's already in the database format
  let dbFormattedTimestamp: string;

  // Handle different timestamp formats
  if (!timestampValue) {
    // No timestamp provided, use current time
    const now = new Date();
    timestampValue = now.toISOString();
    // Format for database key
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');
    const hours = String(now.getUTCHours()).padStart(2, '0');
    const minutes = String(now.getUTCMinutes()).padStart(2, '0');
    const seconds = String(now.getUTCSeconds()).padStart(2, '0');
    dbFormattedTimestamp = `${year}.${month}.${day} ${hours}:${minutes}:${seconds}`;
    logger.info({ file: fileName, timestamp: timestampValue }, 'test-data: missing timestamp; using current time');
  } else if (timestampValue.match(/^\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}$/)) {
    // Already in database format "YYYY.MM.DD HH:MI:SS"
    dbFormattedTimestamp = timestampValue;
  } else if (timestampValue.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)) {
    // ISO format "YYYY-MM-DDTHH:MI:SS", convert to database format
    const dt = new Date(timestampValue);
    const year = dt.getUTCFullYear();
    const month = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const day = String(dt.getUTCDate()).padStart(2, '0');
    const hours = String(dt.getUTCHours()).padStart(2, '0');
    const minutes = String(dt.getUTCMinutes()).padStart(2, '0');
    const seconds = String(dt.getUTCSeconds()).padStart(2, '0');
    dbFormattedTimestamp = `${year}.${month}.${day} ${hours}:${minutes}:${seconds}`;
  } else {
    // Unknown format, try to parse as date and convert
    try {
      const dt = new Date(timestampValue);
      const year = dt.getUTCFullYear();
      const month = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const day = String(dt.getUTCDate()).padStart(2, '0');
      const hours = String(dt.getUTCHours()).padStart(2, '0');
      const minutes = String(dt.getUTCMinutes()).padStart(2, '0');
      const seconds = String(dt.getUTCSeconds()).padStart(2, '0');
      dbFormattedTimestamp = `${year}.${month}.${day} ${hours}:${minutes}:${seconds}`;
    } catch {
      // If all else fails, use the original value
      dbFormattedTimestamp = timestampValue;
      logger.warn({ file: fileName, timestamp: timestampValue }, 'test-data: could not parse timestamp, using as-is');
    }
  }

  const apiIp = pickString(
    [record, machineStatus],
    ['CNC_IP', 'cnc_ip', 'api_ip', 'ip']
  ) || '127.0.0.1'; // Default to localhost if no IP provided

  // Key format: always timestamp_IP to prevent multiple machines from writing the same timestamp
  const key = `${dbFormattedTimestamp}_${apiIp}`;

  // AlarmHistory not needed - always set to null
  const upsert: CncStatsUpsert = {
    key,
    pcIp: apiIp,
    machineName: toStringOrNull(pickCaseInsensitive(record, ['machine', 'machineName', 'machinename'])) ?? machineTokenFromFileName(fileName),
    currentProgram: pickString(
      [machineStatus, record],
      ['CurrentProgram', 'currentProgram', 'Program', 'program', 'MainProgram']
    ),
    mode: pickString([machineStatus, record], ['Mode', 'mode', 'OperatingMode']),
    status: pickString([machineStatus, record], ['Status', 'status', 'MachineStatus', 'state']),
    alarm: pickString([machineStatus, record], ['Alarm', 'alarm']),
    emg: pickString([machineStatus, record], ['EMG', 'emg', 'Emergency', 'emergency']),
    powerOnTime: pickString(
      [timers, record],
      ['PowerOnTime_sec', 'PowerOnTime', 'powerOnTime', 'power_on', 'PowerOn', 'powerontime']
    ),
    cuttingTime: pickString(
      [timers, record],
      ['AccumulatedCuttingTime_sec', 'CycleCuttingTime_sec', 'CuttingTime_sec', 'CuttingTime', 'cycleCuttingTime', 'cuttingTime', 'cut_time', 'WorkTime_sec']
    ),
    alarmHistory: null,
    vacuumTime: pickString([timers, record], ['VacTime_sec', 'VacuumTime_sec', 'VacuumTime', 'vacTime', 'VacuumTime']),
    drillHeadTime: pickString([timers, record], ['DrillTime_sec', 'DrillHeadTime_sec', 'DrillHeadTime', 'drillTime', 'DrillHeadTime']),
    spindleTime: pickString([timers, record], ['SpindleTime_sec', 'SpindleTime', 'spindleTime']),
    conveyorTime: pickString([timers, record], ['ConveyorTime_sec', 'ConveyorTime', 'conveyorTime']),
    greaseTime: pickString([timers, record], ['GreaseTime_sec', 'GreaseTime', 'greaseTime'])
  };
  logger.info(
    {
      file: fileName,
      key: upsert.key,
      pcIp: upsert.pcIp ?? undefined,
      mode: upsert.mode ?? undefined,
      status: upsert.status ?? undefined,
      currentProgram: upsert.currentProgram ?? undefined
    },
    'test-data: built upsert payload'
  );
  return upsert;
}

function sanitizeToken(input: string | null | undefined) {
  return (input ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isAutoPacCsvFileName(fileName: string) {
  const lower = fileName.toLowerCase();
  if (!lower.endsWith('.csv')) return false;
  return (
    lower.startsWith('load_finish') ||
    lower.startsWith('label_finish') ||
    lower.startsWith('cnc_finish')
  );
}

// _inferMachineFromPath was unused and removed during cleanup

function deriveJobLeaf(folder: string | null, ncfile: string | null, key: string) {
  if (folder) {
    const parts = folder.split(/[\\/]/).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  if (ncfile) return ncfile.replace(/\.nc$/i, '');
  return key.replace(/\.nc$/i, '');
}

async function findMatchingCsv(root: string, base: string, depth = 0, maxDepth = 3): Promise<string | null> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const targetLower = base.toLowerCase();
    for (const entry of entries) {
      const entryPath = join(root, entry.name);
      if (entry.isFile()) {
        const nameLower = entry.name.toLowerCase();
        if (nameLower === `${targetLower}.csv` || (nameLower.startsWith(targetLower) && nameLower.endsWith('.csv'))) {
          return entryPath;
        }
      }
    }
    if (depth >= maxDepth) return null;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryPath = join(root, entry.name);
      const result = await findMatchingCsv(entryPath, base, depth + 1, maxDepth);
      if (result) return result;
    }
  } catch (err) {
    logger.debug({ err, root }, 'watcher: failed listing directory');
  }
  return null;
}

async function ensureDir(path: string) {
  if (existsSync(path)) return;
  mkdirSync(path, { recursive: true });
}

async function waitForNestpickSlot(path: string, timeoutMs = 5 * 60 * 1000) {
  const start = Date.now();
  while (await fileExists(path)) {
    if (Date.now() - start > timeoutMs) throw new Error('Nestpick.csv busy timeout');
    await delay(1000);
  }
}

function serializeCsv(rows: string[][]) {
  return rows
    .map((columns) =>
      columns
        .map((cell) => {
          if (cell.includes('"')) cell = cell.replace(/"/g, '""');
          if (cell.includes(',') || cell.includes('"')) return `"${cell}"`;
          return cell;
        })
        .join(',')
    )
    .join('\n');
}

function rewriteNestpickRows(rows: string[][], machineId: number) {
  if (rows.length === 0) return [];
  let destIndex = -1;
  let srcIndex = -1;
  const headerRow = rows[0];
  const isHeader = headerRow.some((cell) => /[A-Za-z]/.test(cell));

  if (isHeader) {
    destIndex = headerRow.findIndex((cell) => cell.toLowerCase() === 'destination');
    srcIndex = headerRow.findIndex((cell) => cell.toLowerCase() === 'sourcemachine');
    if (destIndex === -1) {
      headerRow.push('Destination');
      destIndex = headerRow.length - 1;
    } else {
      headerRow[destIndex] = 'Destination';
    }
    if (srcIndex === -1) {
      headerRow.push('SourceMachine');
      srcIndex = headerRow.length - 1;
    } else {
      headerRow[srcIndex] = 'SourceMachine';
    }
  } else {
    destIndex = headerRow.length;
    srcIndex = destIndex + 1;
    headerRow[destIndex] = '99';
    headerRow[srcIndex] = String(machineId);
  }

  const maxIndex = Math.max(destIndex, srcIndex);
  const dataStart = isHeader ? 1 : 0;
  for (let i = dataStart; i < rows.length; i++) {
    const row = rows[i];
    while (row.length <= maxIndex) row.push('');
    row[destIndex] = '99';
    row[srcIndex] = String(machineId);
  }
  return rows;
}

async function forwardToNestpick(base: string, job: Awaited<ReturnType<typeof findJobByNcBase>>, machine: Machine | undefined, machines: Machine[]) {
  if (!job) return;
  const resolvedMachine = machine ?? machines.find((m) => job.machineId != null && m.machineId === job.machineId);
  if (!resolvedMachine || !resolvedMachine.nestpickEnabled || !resolvedMachine.nestpickFolder) {
    logger.debug({ job: job.key }, 'watcher: nestpick forwarding skipped (no machine/folder)');
    return;
  }

  const apRoot = resolvedMachine.apJobfolder;
  if (!apRoot) {
    logger.warn({ machineId: resolvedMachine.machineId }, 'watcher: machine missing ap_jobfolder for nestpick forwarding');
    return;
  }

  const baseLower = base.toLowerCase();
  const leaf = deriveJobLeaf(job.folder, job.ncfile, job.key);
  const preferredDir = join(apRoot, leaf);
  let sourceCsv: string | null = null;
  if (await fileExists(preferredDir)) {
    sourceCsv = await findMatchingCsv(preferredDir, baseLower, 0, 2);
  }
  if (!sourceCsv) {
    sourceCsv = await findMatchingCsv(apRoot, baseLower, 0, 2);
  }
  if (!sourceCsv) {
    logger.warn({ job: job.key, apRoot, leaf }, 'watcher: staged CSV not found for nestpick forwarding');
    return;
  }

  try {
    await waitForStableFile(sourceCsv);
    const raw = await readFile(sourceCsv, 'utf8');
    const rows = parseCsvContent(raw);
    const rewritten = rewriteNestpickRows(rows, resolvedMachine.machineId);
    if (rewritten.length === 0) {
      logger.warn({ job: job.key, sourceCsv }, 'watcher: nestpick CSV empty after rewrite');
      return;
    }

    const outDir = resolvedMachine.nestpickFolder;
    await ensureDir(outDir);
    const outPath = join(outDir, 'Nestpick.csv');
    await waitForNestpickSlot(outPath);

    const tempPath = `${outPath}.tmp-${Date.now()}`;
    await fsp.writeFile(tempPath, `${serializeCsv(rewritten)}\n`, 'utf8');
    await rename(tempPath, outPath);

    await appendJobEvent(job.key, 'nestpick:forwarded', { source: sourceCsv, dest: outPath }, resolvedMachine.machineId);
    await updateLifecycle(job.key, 'FORWARDED_TO_NESTPICK', { machineId: resolvedMachine.machineId, source: 'nestpick-forward', payload: { source: sourceCsv, dest: outPath } });

    await unlink(sourceCsv).catch(() => {});
    clearMachineHealthIssue(resolvedMachine.machineId ?? null, HEALTH_CODES.copyFailure);
  } catch (err) {
    setMachineHealthIssue({
      machineId: resolvedMachine?.machineId ?? null,
      code: HEALTH_CODES.copyFailure,
      message: `Failed to forward Nestpick CSV for ${job?.key ?? base}`,
      severity: 'warning',
      context: {
        jobKey: job?.key,
        sourceCsv,
        destinationFolder: resolvedMachine?.nestpickFolder
      }
    });
    recordWorkerError('nestpick:forward', err, {
      jobKey: job.key,
      machineId: resolvedMachine?.machineId,
      sourceCsv,
      destinationFolder: resolvedMachine?.nestpickFolder
    });
    logger.error({ err, job: job.key }, 'watcher: nestpick forward failed');
  }
}

async function handleAutoPacCsv(path: string) {
  const fileName = basename(path);
  // Enforce naming: load_finish<machine>.csv, label_finish<machine>.csv, cnc_finish<machine>.csv
  const lower = fileName.toLowerCase();
  if (!lower.endsWith('.csv')) {
    logger.debug({ file: path }, 'watcher: ignoring non-CSV AutoPAC file');
    return;
  }
  let to: 'LOAD_FINISH' | 'LABEL_FINISH' | 'CNC_FINISH' | null = null;
  let machineToken = '';
  if (lower.startsWith('load_finish')) { to = 'LOAD_FINISH'; machineToken = fileName.slice('load_finish'.length); }
  else if (lower.startsWith('label_finish')) { to = 'LABEL_FINISH'; machineToken = fileName.slice('label_finish'.length); }
  else if (lower.startsWith('cnc_finish')) { to = 'CNC_FINISH'; machineToken = fileName.slice('cnc_finish'.length); }
  if (!to) return;
  machineToken = machineToken.replace(/^[-_\s]+/, '');
  const csvSuffix = machineToken.toLowerCase().indexOf('.csv');
  if (csvSuffix !== -1) {
    machineToken = machineToken.slice(0, csvSuffix);
  }
  machineToken = machineToken.trim();
  if (!machineToken) return; // machine must be specified

  try {
    await waitForStableFile(path);
    const hash = await hashFile(path);
    if (autoPacHashes.get(path) === hash) return;
    autoPacHashes.set(path, hash);
    if (autoPacHashes.size > 200) {
      const firstKey = autoPacHashes.keys().next().value;
      if (firstKey) autoPacHashes.delete(firstKey);
    }

    const raw = await readFile(path, 'utf8');

    // Validate CSV format before parsing
    const lines = raw.split(/\r?\n/).filter(line => line.trim().length > 0);
    if (lines.length === 0) {
      logger.warn({ file: path, machineToken }, 'watcher: autopac CSV file is empty');
      postMessageToMain({
        type: 'userAlert',
        title: 'AutoPAC CSV Format Error',
        message: `AutoPAC CSV ${machineToken} has incorrect format: file is empty`
      });
      recordWatcherError(AUTOPAC_WATCHER_NAME, new Error('Empty CSV file'), {
        path,
        machineToken,
        label: AUTOPAC_WATCHER_LABEL
      });
      await unlinkWithRetry(path);
      autoPacHashes.delete(path);
      logger.info({ file: path, machineToken }, 'watcher: deleted empty autopac CSV file');
      return;
    }

    // Check if CSV has proper delimiter (comma or semicolon)
    const hasDelimiters = lines.some(line => line.includes(',') || line.includes(';'));
    if (!hasDelimiters) {
      logger.warn({ file: path, machineToken, lineCount: lines.length, sampleLine: lines[0]?.slice(0, 100) }, 'watcher: autopac CSV has no delimiters (comma or semicolon)');
      postMessageToMain({
        type: 'userAlert',
        title: 'AutoPAC CSV Format Error',
        message: `AutoPAC CSV ${machineToken} has incorrect format: no comma or semicolon delimiters found`
      });
      recordWatcherError(AUTOPAC_WATCHER_NAME, new Error('Invalid CSV format: no delimiters'), {
        path,
        machineToken,
        label: AUTOPAC_WATCHER_LABEL
      });
      await unlinkWithRetry(path);
      autoPacHashes.delete(path);
      logger.info({ file: path, machineToken }, 'watcher: deleted autopac CSV with no delimiters');
      return;
    }

    const rows = parseCsvContent(raw);

    // Validate parsed rows have multiple columns
    const validRows = rows.filter(row => row.length > 1);
    if (validRows.length === 0) {
      logger.warn({ file: path, machineToken, totalRows: rows.length, sampleRow: rows[0] }, 'watcher: autopac CSV has no multi-column rows');
      postMessageToMain({
        type: 'userAlert',
        title: 'AutoPAC CSV Format Error',
        message: `AutoPAC CSV ${machineToken} has incorrect format: no valid multi-column rows found`
      });
      recordWatcherError(AUTOPAC_WATCHER_NAME, new Error('Invalid CSV format: single column only'), {
        path,
        machineToken,
        label: AUTOPAC_WATCHER_LABEL
      });
      await unlinkWithRetry(path);
      autoPacHashes.delete(path);
      logger.info({ file: path, machineToken }, 'watcher: deleted autopac CSV with single column only');
      return;
    }
    // Enforce machine token appears in CSV and matches filename
    const wantedToken = sanitizeToken(machineToken);
    const csvHasMachine = rows.some((row) =>
      row.some((cell) => {
        const token = sanitizeToken(cell);
        return token === wantedToken;
      })
    );
    if (!csvHasMachine) {
      logger.warn({ file: path, machineToken, wantedToken, fileName }, 'watcher: autopac CSV machine token not found in file content');
      postMessageToMain({
        type: 'userAlert',
        title: 'AutoPAC CSV Format Error',
        message: `AutoPAC CSV ${machineToken} has incorrect format: machine name mismatch`
      });
      setMachineHealthIssue({
        machineId: null,
        code: HEALTH_CODES.copyFailure,
        message: `AutoPAC machine mismatch: file=${fileName} expects '${machineToken}', CSV does not contain matching machine`,
        severity: 'warning',
        context: { file: path, expected: machineToken }
      });
      recordWatcherError(AUTOPAC_WATCHER_NAME, new Error('AutoPAC machine mismatch'), {
        path,
        expected: machineToken,
        label: AUTOPAC_WATCHER_LABEL
      });
      await unlinkWithRetry(path);
      autoPacHashes.delete(path);
      logger.info({ file: path, machineToken }, 'watcher: deleted autopac CSV with machine mismatch');
      return;
    }
    // Strict: first column is NC, only accept base or base.nc
    const bases = (() => {
      const set = new Set<string>();
      for (const row of rows) {
        if (!row.length) continue;
        const cell = row[0]?.trim() ?? '';
        if (!cell) continue;
        const m = cell.match(/^([A-Za-z0-9_.-]+)(?:\.nc)?$/i);
        if (m && m[1]) set.add(m[1]);
      }
      return Array.from(set);
    })();
    if (!bases.length) {
      logger.warn({ file: path, machineToken, rowCount: rows.length, sampleFirstColumn: rows.slice(0, 3).map(r => r[0]) }, 'watcher: autopac file had no identifiable bases');
      postMessageToMain({
        type: 'userAlert',
        title: 'AutoPAC CSV Format Error',
        message: `AutoPAC CSV ${machineToken} has incorrect format: no parts found`
      });
      setMachineHealthIssue({
        machineId: null,
        code: HEALTH_CODES.noParts,
        message: `No parts found in AutoPAC CSV ${basename(path)}`,
        severity: 'warning',
        context: { file: path }
      });
      recordWatcherError(AUTOPAC_WATCHER_NAME, new Error('No parts found'), {
        path,
        machineToken,
        label: AUTOPAC_WATCHER_LABEL
      });
      await unlinkWithRetry(path);
      autoPacHashes.delete(path);
      logger.info({ file: path, machineToken }, 'watcher: deleted autopac CSV with no identifiable parts');
      return;
    }

    const machines = await listMachines();
    // Resolve machine strictly from filename token (matches by name or numeric id)
    const wanted = sanitizeToken(machineToken);
    const machine = machines.find((m) => sanitizeToken(m.name) === wanted || sanitizeToken(String(m.machineId)) === wanted);
    if (!machine) {
      logger.warn({ file: path, machineToken }, 'watcher: autopac file specifies unknown machine');
      return;
    }
    let processedAny = false;

    for (const base of bases) {
      const job = await findJobByNcBase(base);
      if (!job) {
        logger.warn({ base, file: path }, 'watcher: job not found for AutoPAC CSV');
        continue;
      }
      const machineForJob = machine;
      const machineId = machineForJob.machineId;

      const lifecycle = await updateLifecycle(job.key, to, {
        machineId,
        source: 'autopac',
        payload: { file: path, base }
      });
      await appendJobEvent(job.key, `autopac:${to.toLowerCase()}`, { file: path, base }, machineId);

      if (lifecycle.ok && machineForJob.nestpickEnabled && to) {
        emitLifecycleStageMessage(to, job, base, machineForJob, 'autopac');
      }

      if (lifecycle.ok && to === 'CNC_FINISH') {
        await forwardToNestpick(base, job, machineForJob, machines);
        // Only emit CNC completion message if machine doesn't have Nestpick capability
        if (!machineForJob.nestpickEnabled) {
          const fallbackNc = base.toLowerCase().endsWith('.nc') ? base : `${base}.nc`;
          emitAppMessage(
            'cnc.completion',
            {
              ncFile: displayNcName(job.ncfile, fallbackNc),
              folder: job.folder ?? '',
              machineName: machineForJob.name ?? (machineId != null ? `Machine ${machineId}` : 'Unknown machine')
            },
            'autopac'
          );

          // Archive completed job files for non-Nestpick machines
          logger.info({ jobKey: job.key, status: 'CNC_FINISH', folder: job.folder }, 'watcher: archiving completed job');
          const arch = await archiveCompletedJob({
            jobKey: job.key,
            jobFolder: job.folder,
            ncfile: job.ncfile,
            status: 'CNC_FINISH',
            sourceFiles: []
          });
          if (!arch.ok) {
            logger.warn({ jobKey: job.key, error: arch.error }, 'watcher: archive failed');
          } else {
            logger.info({ jobKey: job.key, archiveDir: arch.archivedPath }, 'watcher: archive complete');
          }
        }
      }
      if (lifecycle.ok) {
        processedAny = true;
        const healthMachine = machineId ?? null;
        clearMachineHealthIssue(healthMachine, HEALTH_CODES.noParts);
      }
    }
    recordWatcherEvent(AUTOPAC_WATCHER_NAME, {
      label: AUTOPAC_WATCHER_LABEL,
      message: `Processed ${basename(path)}`
    });
    if (processedAny) {
      clearMachineHealthIssue(null, HEALTH_CODES.noParts);
      // Delete the source CSV after successful processing
      try {
        await unlinkWithRetry(path);
      } finally {
        autoPacHashes.delete(path);
      }
    }
  } catch (err) {
    autoPacHashes.delete(path);
    recordWatcherError(AUTOPAC_WATCHER_NAME, err, { path, label: AUTOPAC_WATCHER_LABEL });
    logger.error({ err, file: path }, 'watcher: AutoPAC processing failed');
  }
}

async function moveToArchive(source: string, archiveDir: string) {
  await ensureDir(archiveDir);
  const base = basename(source);
  let target = join(archiveDir, base);
  if (await fileExists(target)) {
    target = join(archiveDir, `${Date.now()}-${base}`);
  }
  try {
    await rename(source, target);
  } catch (err) {
    await copyFile(source, target);
    await unlink(source).catch((err) => { void err; });
    logger.debug({ err }, 'watcher: archive rename fallback to copy');
  }
  return target;
}

async function handleNestpickProcessed(machine: Machine, path: string) {
  try {
    await waitForStableFile(path);
    const raw = await readFile(path, 'utf8');
    const rows = parseCsvContent(raw);
    const bases = extractBases(rows, basename(path));
    let processedAny = false;
    for (const base of bases) {
      const job = await findJobByNcBase(base);
      if (!job) {
        logger.warn({ base, file: path }, 'watcher: nestpick processed job not found');
        continue;
      }
      const lifecycle = await updateLifecycle(job.key, 'NESTPICK_COMPLETE', { machineId: machine.machineId, source: 'nestpick-processed', payload: { file: path } });
      if (lifecycle.ok) {
        await appendJobEvent(job.key, 'nestpick:complete', { file: path }, machine.machineId);
        processedAny = true;

        // Archive completed job files
        logger.info({ jobKey: job.key, status: 'NESTPICK_COMPLETE', folder: job.folder }, 'watcher: archiving completed job');
        const arch = await archiveCompletedJob({
          jobKey: job.key,
          jobFolder: job.folder,
          ncfile: job.ncfile,
          status: 'NESTPICK_COMPLETE',
          sourceFiles: [] // Files will be identified from the job folder
        });
        if (!arch.ok) {
          logger.warn({ jobKey: job.key, error: arch.error }, 'watcher: archive failed');
        } else {
          logger.info({ jobKey: job.key, archiveDir: arch.archivedPath }, 'watcher: archive complete');
        }

        if (machine.nestpickEnabled) {
          emitLifecycleStageMessage('NESTPICK_COMPLETE', job, base, machine, 'nestpick-processed');
        }
      }
    }
    // Check if file still exists before trying to move it (may have been moved by another process)
    if (await fileExists(path)) {
      await moveToArchive(path, join(machine.nestpickFolder, 'archive'));
    } else {
      logger.warn({ file: path }, 'watcher: processed file already moved/deleted, skipping archive');
    }
    recordWatcherEvent(nestpickProcessedWatcherName(machine), {
      label: nestpickProcessedWatcherLabel(machine),
      message: `Processed ${basename(path)}`
    });
    if (processedAny) {
      clearMachineHealthIssue(machine.machineId ?? null, HEALTH_CODES.copyFailure);
    }
  } catch (err) {
    setMachineHealthIssue({
      machineId: machine.machineId ?? null,
      code: HEALTH_CODES.copyFailure,
      message: `Failed to archive Nestpick processed file ${basename(path)}`,
      severity: 'warning',
      context: { file: path, machineId: machine.machineId }
    });
    recordWatcherError(nestpickProcessedWatcherName(machine), err, {
      path,
      machineId: machine.machineId,
      label: nestpickProcessedWatcherLabel(machine)
    });
    logger.error({ err, file: path }, 'watcher: nestpick processed handling failed');
  }
}

async function handleNestpickUnstack(machine: Machine, path: string) {
  try {
    await waitForStableFile(path);
    logger.info({ file: path, machineId: machine.machineId }, 'watcher: unstack processing started');
    const raw = await readFile(path, 'utf8');
    const rows = parseCsvContent(raw);
    if (!rows.length) {
      logger.warn({ file: path }, 'watcher: unstack csv empty');
      await moveToArchive(path, join(machine.nestpickFolder, 'archive'));
      return;
    }

    const jobIdx = 0;
    const sourcePlaceIdx = 1;
    let processedAny = false;
    const unmatched: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.length <= jobIdx || row.length <= sourcePlaceIdx) {
        logger.warn({ file: path, row: i + 1 }, 'watcher: unstack row missing expected columns');
        continue;
      }

      const rawJob = (row[jobIdx] ?? '').trim().replace(/^"|"$/g, '');
      if (!rawJob) continue;

      const base = rawJob;
      const job = await findJobByNcBasePreferStatus(base, ['FORWARDED_TO_NESTPICK']);
      if (!job) {
        logger.warn({ base }, 'watcher: unstack no matching job in FORWARDED_TO_NESTPICK');
        unmatched.push(base);
        continue; // alert later; do not update any job
      }

      const sourcePlaceValue = (row[sourcePlaceIdx] ?? '').trim().replace(/^"|"$/g, '') || null;
      logger.debug({ jobKey: job.key, base, sourcePlace: sourcePlaceValue, row: i + 1 }, 'watcher: unstack updating pallet');
      const ok = await updateJobPallet(job.key, sourcePlaceValue);
      if (ok) {
        await appendJobEvent(
          job.key,
          'nestpick:unstack',
          { pallet: sourcePlaceValue, file: path },
          null
        );
        logger.info({ jobKey: job.key, base, sourcePlace: sourcePlaceValue, row: i + 1 }, 'watcher: unstack row processed');
        // Progress lifecycle to NESTPICK_COMPLETE when unstack is recorded
        // Do NOT override machine assignment here. Unstack is reported by the Nestpick system
        // and does not identify the CNC machine. Leaving machineId unspecified preserves any
        // previously determined CNC machine (from AutoPAC or forwarding) for History display.
        const lifecycle = await updateLifecycle(job.key, 'NESTPICK_COMPLETE', {
          source: 'nestpick-unstack',
          payload: { file: path, sourcePlace: sourcePlaceValue }
        });
        if (!lifecycle.ok) {
          const previous = 'previousStatus' in lifecycle ? lifecycle.previousStatus : undefined;
          logger.warn({ jobKey: job.key, base, previousStatus: previous }, 'watcher: unstack lifecycle not progressed');
        } else {
          // Archive completed job files
          logger.info({ jobKey: job.key, status: 'NESTPICK_COMPLETE', folder: job.folder }, 'watcher: archiving completed job');
          const arch = await archiveCompletedJob({
            jobKey: job.key,
            jobFolder: job.folder,
            ncfile: job.ncfile,
            status: 'NESTPICK_COMPLETE',
            sourceFiles: []
          });
          if (!arch.ok) {
            logger.warn({ jobKey: job.key, error: arch.error }, 'watcher: archive failed');
          } else {
            logger.info({ jobKey: job.key, archiveDir: arch.archivedPath }, 'watcher: archive complete');
          }

          if (machine.nestpickEnabled) {
            const extras: Record<string, unknown> = {};
            if (sourcePlaceValue) extras.pallet = sourcePlaceValue;
            emitLifecycleStageMessage('NESTPICK_COMPLETE', job, base, machine, 'nestpick-unstack', extras);
          }
        }
        processedAny = true;
      } else {
        logger.warn({ jobKey: job.key, base, sourcePlace: sourcePlaceValue, row: i + 1 }, 'watcher: unstack pallet update failed');
      }
    }
    const archiveDir = join(machine.nestpickFolder, 'archive');
    // Check if file still exists before trying to move it (may have been moved by another process)
    if (await fileExists(path)) {
      await moveToArchive(path, archiveDir);
      logger.info({ file: path, archiveDir, processedAny }, 'watcher: unstack archived');
    } else {
      logger.warn({ file: path, archiveDir }, 'watcher: unstack file already moved/deleted, skipping archive');
    }

    if (unmatched.length) {
      postMessageToMain({
        type: 'userAlert',
        title: 'Nestpick Unstack: No Matching Job',
        message: `No job in FORWARDED_TO_NESTPICK for: ${unmatched.join(', ')}`
      });
    }
    recordWatcherEvent(nestpickUnstackWatcherName(machine), {
      label: nestpickUnstackWatcherLabel(machine),
      message: `Processed ${basename(path)}`
    });
    if (processedAny) {
      clearMachineHealthIssue(machine.machineId ?? null, HEALTH_CODES.copyFailure);
    }
  } catch (err) {
    setMachineHealthIssue({
      machineId: machine.machineId ?? null,
      code: HEALTH_CODES.copyFailure,
      message: `Failed to process Nestpick unstack report ${basename(path)}`,
      severity: 'warning',
      context: { file: path, machineId: machine.machineId }
    });
    try {
      await moveToArchive(path, join(machine.nestpickFolder, 'archive'));
    } catch (e) { void e; }
    recordWatcherError(nestpickUnstackWatcherName(machine), err, {
      path,
      machineId: machine.machineId,
      label: nestpickUnstackWatcherLabel(machine)
    });
    logger.error({ err, file: path }, 'watcher: nestpick unstack handling failed');
  }
}

function stableProcess(
  fn: (path: string) => Promise<void>,
  delayMs = 1000,
  options?: { watcherName?: string; watcherLabel?: string }
) {
  const pending = new Map<string, NodeJS.Timeout>();
  return (path: string) => {
    const normalizedPath = normalize(path);
    const watcher = options?.watcherName ?? 'watcher';
    const label = options?.watcherLabel ?? watcher;
    logger.info({ path: normalizedPath, watcher, label }, 'watcher: scan queued');
    if (pending.has(normalizedPath)) clearTimeout(pending.get(normalizedPath)!);
    pending.set(
      normalizedPath,
      setTimeout(() => {
        pending.delete(normalizedPath);
        fn(normalizedPath)
          .then(() => {
            logger.info({ path: normalizedPath, watcher, label }, 'watcher: scan complete');
          })
          .catch((err) => {
            if (options?.watcherName) {
              recordWatcherError(options.watcherName, err, {
                path: normalizedPath,
                label: options.watcherLabel ?? options.watcherName
              });
            } else {
              recordWorkerError('watcher', err, { path: normalizedPath });
            }
            logger.error({ err, path: normalizedPath, watcher, label }, 'watcher error');
          });
      }, delayMs)
    );
  };
}


async function shutdown(reason?: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ reason }, 'watchersWorker: shutting down background services');
  if (jobsIngestInterval) {
    clearInterval(jobsIngestInterval);
    jobsIngestInterval = null;
  }
  if (grundnerTimer) {
    clearInterval(grundnerTimer);
    grundnerTimer = null;
  }
  if (notificationRestartTimer) {
    clearTimeout(notificationRestartTimer);
    notificationRestartTimer = null;
  }
  if (notificationClient) {
    try {
      await notificationClient.query('UNLISTEN grundner_changed');
      await notificationClient.query('UNLISTEN allocated_material_changed');
    } catch (err) {
      logger.warn({ err }, 'watchersWorker: failed to unlisten db notifications');
    } finally {
      try {
        notificationClient.release();
      } catch (err) {
        logger.warn({ err }, 'watchersWorker: failed to release db listener');
      }
      notificationClient = null;
    }
  }
  const watchers = Array.from(fsWatchers);
  for (const watcher of watchers) {
    try {
      await watcher.close();
    } catch (err) {
      logger.warn({ err }, 'watchersWorker: failed to close file watcher');
    } finally {
      fsWatchers.delete(watcher);
    }
  }
}

let testDataProcessedCount = 0;

async function loadTestDataFile(path: string): Promise<TestDataRowPayload[] | null> {
  const baseName = basename(path);
  try {
    const raw = await readFile(path, 'utf8');
    const payloads = parseTestDataPayloads(raw, baseName);
    if (!payloads.length) {
      logger.warn({ file: path }, 'test-data: file contained no payloads');
      return null;
    }
    const rows: TestDataRowPayload[] = [];
    for (let index = 0; index < payloads.length; index++) {
      const upsert = buildTestDataUpsert(payloads[index], baseName);
      if (!upsert) continue;
      rows.push({ row: upsert, index });
    }
    if (!rows.length) {
      const err = new Error('No valid telemetry rows found');
      recordWatcherError(TESTDATA_WATCHER_NAME, err, { path, label: TESTDATA_WATCHER_LABEL });
      logger.warn({ file: path }, 'test-data: skipping file because no valid rows were ingested');
      return null;
    }
    return rows;
  } catch (err) {
    recordWatcherError(TESTDATA_WATCHER_NAME, err, { path, label: TESTDATA_WATCHER_LABEL });
    logger.error({ err, file: path }, 'test-data: failed to ingest file');
    return null;
  }
}

function enqueueTestDataFile(file: string, reason: string) {
  const normalized = normalize(file);
  if (testDataQueued.has(normalized)) {
    logger.debug({ file: normalized, reason }, 'test-data: already queued');
    return;
  }
  testDataQueued.add(normalized);
  testDataQueue.push(normalized);
  logger.info({ file: normalized, reason, queueSize: testDataQueue.length }, 'test-data: queued file');
  void processNextTestData();
}

function takeNextTestDataFile(): string | null {
  let next = testDataQueue.shift() ?? null;
  if (!next && testDataIndexBuilt) {
    while (testDataIndexPos < testDataIndex.length && !next) {
      const candidate = testDataIndex[testDataIndexPos++];
      if (!candidate) continue;
      if (testDataQueued.has(normalize(candidate))) continue;
      if (isTestDataInternalPath(candidate)) continue;
      if (!isTestDataFileName(candidate)) continue;
      next = candidate;
    }
  }
  return next;
}

const TESTDATA_BATCH_SIZE = 250;
const TESTDATA_FILE_READ_CONCURRENCY = 10;
const TESTDATA_UPSERT_CHUNK_SIZE = 100;

interface TestDataRowPayload {
  row: CncStatsUpsert;
  index: number;
}

interface PendingTestDataRow extends TestDataRowPayload {
  file: string;
}

interface TestDataFileState {
  remaining: number;
  successes: number;
}

function finalizeTestDataFile(path: string, state: TestDataFileState | undefined, toDelete: string[]) {
  if (!state) return;
  if (state.successes > 0) {
    toDelete.push(path);
    return;
  }
  const err = new Error('No valid telemetry rows found');
  recordWatcherError(TESTDATA_WATCHER_NAME, err, { path, label: TESTDATA_WATCHER_LABEL });
  logger.warn({ file: path }, 'test-data: skipping file because no valid rows were ingested');
}

function decrementTestDataFileState(
  path: string,
  fileStates: Map<string, TestDataFileState>,
  succeeded: boolean,
  toDelete: string[]
) {
  const state = fileStates.get(path);
  if (!state) return;
  state.remaining -= 1;
  if (succeeded) state.successes += 1;
  if (state.remaining <= 0) {
    fileStates.delete(path);
    finalizeTestDataFile(path, state, toDelete);
  }
}

async function flushPendingTestDataRows(
  client: PoolClient,
  pendingRows: PendingTestDataRow[],
  fileStates: Map<string, TestDataFileState>,
  toDelete: string[],
  force = false
) {
  while (pendingRows.length >= TESTDATA_UPSERT_CHUNK_SIZE || (force && pendingRows.length > 0)) {
    const chunkSize = Math.min(TESTDATA_UPSERT_CHUNK_SIZE, pendingRows.length);
    const chunk = pendingRows.splice(0, chunkSize);
    const rows = chunk.map((entry) => entry.row);
    try {
      await bulkUpsertCncStats(rows, client);
      for (const entry of chunk) {
        decrementTestDataFileState(entry.file, fileStates, true, toDelete);
      }
    } catch (err) {
      logger.warn({ err, chunkSize: chunk.length }, 'test-data: bulk upsert chunk failed; retrying individually');
      for (const entry of chunk) {
        try {
          await bulkUpsertCncStats([entry.row], client);
          decrementTestDataFileState(entry.file, fileStates, true, toDelete);
        } catch (rowErr) {
          recordWorkerError(TESTDATA_WATCHER_NAME, rowErr, {
            path: entry.file,
            key: entry.row.key,
            label: TESTDATA_WATCHER_LABEL,
            index: entry.index
          });
          logger.error(
            { err: rowErr, file: entry.file, key: entry.row.key, index: entry.index },
            'test-data: failed to upsert telemetry entry'
          );
          decrementTestDataFileState(entry.file, fileStates, false, toDelete);
        }
      }
    }
  }
}

async function processNextTestData() {
  if (testDataProcessing) return;
  testDataProcessing = true;
  try {
    let keepRunning = true;
    outer: while (keepRunning) {
      const { pendingRows, fileStates, fileCount } = await collectTestDataBatch();
      if (fileCount === 0) {
        keepRunning = false;
        break outer;
      }
      if (pendingRows.length === 0) {
        continue;
      }

      const toDelete: string[] = [];
      let committed = false;
      try {
        await withClient(async (client) => {
          await client.query('BEGIN');
          try {
            await flushPendingTestDataRows(client, pendingRows, fileStates, toDelete, true);
            await client.query('COMMIT');
            committed = true;
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          }
        });
      } catch (err) {
        logger.warn({ err }, 'test-data: batch failed and was rolled back');
      }

      if (committed && toDelete.length > 0) {
        for (const file of toDelete) {
          try {
            await unlinkWithRetry(file);
          } catch (e) {
            logger.warn({ err: e, file }, 'test-data: failed to delete file after commit');
          }
          testDataProcessedCount += 1;
          if (testDataProcessedCount % 100 === 0) {
            const message = `Processed ${testDataProcessedCount} test-data files`;
            logger.info({ total: testDataProcessedCount }, 'test-data: processed files milestone');
            recordWatcherEvent(TESTDATA_WATCHER_NAME, { label: TESTDATA_WATCHER_LABEL, message });
          }
        }
      }
    }
  } finally {
    testDataProcessing = false;
  }
}

async function collectTestDataBatch(): Promise<{
  pendingRows: PendingTestDataRow[];
  fileStates: Map<string, TestDataFileState>;
  fileCount: number;
}> {
  const pendingRows: PendingTestDataRow[] = [];
  const fileStates = new Map<string, TestDataFileState>();
  let processedFiles = 0;

  while (processedFiles < TESTDATA_BATCH_SIZE) {
    const batchPaths: string[] = [];
    while (
      batchPaths.length < TESTDATA_FILE_READ_CONCURRENCY &&
      processedFiles + batchPaths.length < TESTDATA_BATCH_SIZE
    ) {
      const next = takeNextTestDataFile();
      if (!next) break;
      batchPaths.push(next);
    }
    if (!batchPaths.length) break;

    const loaded = await Promise.all(batchPaths.map((file) => loadTestDataFile(file)));
    for (let i = 0; i < batchPaths.length; i++) {
      const file = batchPaths[i];
      processedFiles += 1;
      testDataQueued.delete(file);
      const rows = loaded[i];
      if (!rows || rows.length === 0) continue;
      fileStates.set(file, { remaining: rows.length, successes: 0 });
      for (const payload of rows) {
        pendingRows.push({ file, row: payload.row, index: payload.index });
      }
    }
  }

  return { pendingRows, fileStates, fileCount: processedFiles };
}

async function collectTestDataFilesNoLog(root: string, depth = 0, maxDepth = 4): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: string[] = [];
  const subdirs: string[] = [];
  for (const entry of entries) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) {
      const lower = entry.name.toLowerCase();
      if (TESTDATA_SKIP_DIRS.has(lower)) continue;
      if (depth < maxDepth) subdirs.push(p);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!isTestDataFileName(p)) continue;
    if (isTestDataInternalPath(p)) continue;
    results.push(p);
  }
  for (const d of subdirs.sort()) {
    const nested = await collectTestDataFilesNoLog(d, depth + 1, maxDepth);
    if (nested.length) results.push(...nested);
  }
  return results;
}

async function buildInitialTestDataIndex(root: string) {
  testDataIndexBuilt = false;
  testDataIndex = await collectTestDataFilesNoLog(root);
  testDataIndexPos = 0;
  testDataIndexBuilt = true;
  logger.info({ folder: root, files: testDataIndex.length }, 'test-data: initial index built');
}

//

function setupTestDataWatcher(root: string) {
  registerWatcher(TESTDATA_WATCHER_NAME, TESTDATA_WATCHER_LABEL);
  const trimmed = root?.trim?.() ?? '';
  if (!trimmed) {
    const err = new Error('Test data folder path is empty');
    recordWatcherError(TESTDATA_WATCHER_NAME, err, { folder: trimmed, label: TESTDATA_WATCHER_LABEL });
    logger.warn('test-data: useTestDataMode enabled but folder path is empty');
    return;
  }
  const normalizedRoot = normalize(trimmed);
  if (!existsSync(normalizedRoot)) {
    const err = new Error('Test data folder does not exist');
    recordWatcherError(TESTDATA_WATCHER_NAME, err, { folder: normalizedRoot, label: TESTDATA_WATCHER_LABEL });
    logger.warn({ folder: normalizedRoot }, 'test-data: folder does not exist');
    return;
  }

  const processIfMatches = (file: string, event: 'add' | 'change') => {
    const matches = isTestDataFileName(file);
    const internal = isTestDataInternalPath(file);
    if (!matches) {
      return;
    }
    if (internal) {
      return;
    }
    if (event === 'add') enqueueTestDataFile(file, 'watcher:add');
  };

  const watcher = chokidar.watch(normalizedRoot, {
    ignoreInitial: true,
    depth: 4
  });
  trackWatcher(watcher);
  watcher.on('add', (file) => processIfMatches(file, 'add'));
  watcher.on('error', (err) => {
    recordWatcherError(TESTDATA_WATCHER_NAME, err, { folder: normalizedRoot, label: TESTDATA_WATCHER_LABEL });
    logger.error({ err, folder: normalizedRoot }, 'test-data: watcher error');
  });
  watcher.on('ready', () => {
    watcherReady(TESTDATA_WATCHER_NAME, TESTDATA_WATCHER_LABEL);
    void (async () => {
      await buildInitialTestDataIndex(normalizedRoot);
      await processNextTestData();
    })();
  });
  logger.info({ folder: normalizedRoot }, 'Test data watcher started');
}

async function collectAutoPacCsvs(root: string, depth = 0, maxDepth = 3): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    logger.warn({ err, dir: root }, 'AutoPAC watcher: failed to read directory during startup scan');
    return [];
  }
  const results: string[] = [];
  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      if (depth < maxDepth) {
        const nested = await collectAutoPacCsvs(entryPath, depth + 1, maxDepth);
        if (nested.length) results.push(...nested);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    if (!isAutoPacCsvFileName(entry.name)) continue;
    results.push(entryPath);
  }
  return results;
}

function setupAutoPacWatcher(dir: string) {
  registerWatcher(AUTOPAC_WATCHER_NAME, AUTOPAC_WATCHER_LABEL);
  const onAdd = stableProcess(handleAutoPacCsv, 250, {
    watcherName: AUTOPAC_WATCHER_NAME,
    watcherLabel: AUTOPAC_WATCHER_LABEL
  });
  const watcher = chokidar.watch(dir, {
    ignoreInitial: true,
    depth: 3,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
  });
  trackWatcher(watcher);
  watcher.on('add', onAdd);
  watcher.on('change', onAdd);
  watcher.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException)?.code;
    setMachineHealthIssue({
      machineId: null,
      code: HEALTH_CODES.copyFailure,
      message: `AutoPAC watcher error${code ? ` (${code})` : ''}`,
      severity: 'critical',
      context: { dir, code }
    });
    recordWatcherError(AUTOPAC_WATCHER_NAME, err, { dir, label: AUTOPAC_WATCHER_LABEL });
    logger.error({ err, dir }, 'watcher: AutoPAC error');
  });
  watcher.on('ready', () => {
    watcherReady(AUTOPAC_WATCHER_NAME, AUTOPAC_WATCHER_LABEL);
    clearMachineHealthIssue(null, HEALTH_CODES.copyFailure);
    void (async () => {
      const existing = await collectAutoPacCsvs(dir);
      if (!existing.length) return;
      logger.info({ dir, count: existing.length }, 'AutoPAC watcher: processing existing CSV files on startup');
      for (const file of existing) {
        onAdd(file);
      }
    })();
  });
  logger.info({ dir }, 'AutoPAC watcher started');
}

async function setupNestpickWatchers() {
  try {
    const machines = await listMachines();
    for (const machine of machines) {
      if (!machine.nestpickEnabled || !machine.nestpickFolder) continue;
      const folder = machine.nestpickFolder;
      const processedDir = join(folder, 'processed');
      const processedWatcherName = nestpickProcessedWatcherName(machine);
      const processedWatcherLabel = nestpickProcessedWatcherLabel(machine);
      registerWatcher(processedWatcherName, processedWatcherLabel);
      const processedWatcher = chokidar.watch(processedDir, {
        ignoreInitial: true,
        depth: 1,
        awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 250 }
      });
      trackWatcher(processedWatcher);
      const handleProcessed = stableProcess(
        (path) => handleNestpickProcessed(machine, path),
        500,
        { watcherName: processedWatcherName, watcherLabel: processedWatcherLabel }
      );
      processedWatcher.on('add', handleProcessed);
      processedWatcher.on('error', (err) => {
        const code = (err as NodeJS.ErrnoException)?.code;
        setMachineHealthIssue({
          machineId: machine.machineId ?? null,
          code: HEALTH_CODES.nestpickShare,
          message: `Processed folder unavailable${code ? ` (${code})` : ''}`,
          severity: 'critical',
          context: { folder: processedDir, machineId: machine.machineId, code }
        });
        recordWatcherError(processedWatcherName, err, {
          folder: processedDir,
          machineId: machine.machineId,
          label: processedWatcherLabel
        });
        logger.error({ err, folder: processedDir }, 'watcher: nestpick processed error');
      });
      processedWatcher.on('ready', () => {
        watcherReady(processedWatcherName, processedWatcherLabel);
        clearMachineHealthIssue(machine.machineId ?? null, HEALTH_CODES.nestpickShare);
      });

      const reportPath = join(folder, NESTPICK_UNSTACK_FILENAME);
      const unstackWatcherName = nestpickUnstackWatcherName(machine);
      const unstackWatcherLabel = nestpickUnstackWatcherLabel(machine);
      registerWatcher(unstackWatcherName, unstackWatcherLabel);
      const reportWatcher = chokidar.watch(reportPath, {
        ignoreInitial: true,
        depth: 0,
        awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 250 }
      });
      trackWatcher(reportWatcher);
      const handleReport = stableProcess(
        (path) => handleNestpickUnstack(machine, path),
        500,
        { watcherName: unstackWatcherName, watcherLabel: unstackWatcherLabel }
      );
      reportWatcher.on('add', handleReport);
      reportWatcher.on('change', handleReport);
      reportWatcher.on('error', (err) => {
        const code = (err as NodeJS.ErrnoException)?.code;
        setMachineHealthIssue({
          machineId: machine.machineId ?? null,
          code: HEALTH_CODES.nestpickShare,
          message: `Nestpick unstack share unreachable${code ? ` (${code})` : ''}`,
          severity: 'critical',
          context: { file: reportPath, machineId: machine.machineId, code }
        });
        recordWatcherError(unstackWatcherName, err, {
          folder: reportPath,
          machineId: machine.machineId,
          label: unstackWatcherLabel
        });
        logger.error({ err, folder: reportPath }, 'watcher: nestpick unstack error');
      });
      reportWatcher.on('ready', () => {
        watcherReady(unstackWatcherName, unstackWatcherLabel);
        clearMachineHealthIssue(machine.machineId ?? null, HEALTH_CODES.nestpickShare);
      });

      logger.info({ folder }, 'Nestpick watcher started');
    }
  } catch (err) {
    logger.error({ err }, 'watcher: failed to initialize nestpick watchers');
  }
}

function normalizeNumber(value: string | undefined): number | null {
  if (value == null) return null;
  const t = value.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function displayNcName(value: string | null | undefined, fallback: string): string {
  const base = value && value.trim() ? value.trim() : fallback;
  return base.toLowerCase().endsWith('.nc') ? base : `${base}.nc`;
}

function normalizeNcName(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.endsWith('.nc') ? trimmed : `${trimmed}.nc`;
}

function markPendingGrundnerRelease(ncName: string) {
  const normalized = normalizeNcName(ncName);
  pendingGrundnerReleases.set(normalized, Date.now() + PENDING_GRUNDNER_RELEASE_TTL_MS);
}

function markPendingGrundnerReleaseMany(ncNames: Iterable<string>) {
  for (const name of ncNames) {
    if (!name) continue;
    markPendingGrundnerRelease(name);
  }
}

function unmarkPendingGrundnerReleaseMany(ncNames: Iterable<string>) {
  for (const name of ncNames) {
    if (!name) continue;
    pendingGrundnerReleases.delete(normalizeNcName(name));
  }
}

function cleanupPendingGrundnerReleases(now = Date.now()) {
  for (const [name, expiry] of pendingGrundnerReleases.entries()) {
    if (expiry <= now) pendingGrundnerReleases.delete(name);
  }
}

function isPendingGrundnerRelease(ncName: string | null | undefined, now = Date.now()): boolean {
  if (!ncName) return false;
  const normalized = normalizeNcName(ncName);
  const expiry = pendingGrundnerReleases.get(normalized);
  if (expiry == null) return false;
  if (expiry <= now) {
    pendingGrundnerReleases.delete(normalized);
    return false;
  }
  return true;
}

function cleanupPendingGrundnerConflicts(now = Date.now()) {
  for (const [material, expiry] of pendingGrundnerConflicts.entries()) {
    if (expiry <= now) pendingGrundnerConflicts.delete(material);
  }
}

function indexOfHeader(header: string[], candidates: string[]): number {
  const lower = header.map((h) => stripCsvCell(h).toLowerCase());
  for (const cand of candidates) {
    const i = lower.findIndex((h) => h === cand.toLowerCase());
    if (i !== -1) return i;
  }
  return -1;
}

function parseGrundnerCsv(raw: string): GrundnerCsvRow[] {
  const rows = parseCsvContent(raw);
  if (!rows.length) return [];
  const header = rows[0];
  const hasHeader = header.some((c) => /[A-Za-z]/.test(c));
  const body = hasHeader ? rows.slice(1) : rows;

  let idxType = -1,
    idxCust = -1,
    idxLen = -1,
    idxWid = -1,
    idxThk = -1,
    idxStock = -1,
    idxAvail = -1,
    idxReserved = -1;
  if (hasHeader) {
    idxType = indexOfHeader(header, ['type_data', 'type']);
    idxCust = indexOfHeader(header, ['customer_id', 'customer']);
    idxLen = indexOfHeader(header, ['length_mm', 'length']);
    idxWid = indexOfHeader(header, ['width_mm', 'width']);
    idxThk = indexOfHeader(header, ['thickness_mm', 'thickness']);
    idxStock = indexOfHeader(header, ['stock']);
    idxAvail = indexOfHeader(header, ['stock_available', 'available']);
    // CSV may label this as 'reserved stock' (with space) or underscores
    idxReserved = indexOfHeader(header, ['reserved_stock', 'reserved stock', 'reserved']);
  } else {
    // Fallback positions if no header present
    idxType = 0;
    idxCust = 1;
    idxLen = 3;
    idxWid = 4;
    idxThk = 5;
    idxStock = 7;
    idxAvail = 8;
    // Grundner CSV spec: column 15 (1-based) => index 14 (0-based)
    idxReserved = 14;
  }

  const out: GrundnerCsvRow[] = [];
  for (const row of body) {
    const typeData = normalizeNumber(row[idxType]);
    const customerIdRaw = idxCust >= 0 ? stripCsvCell(row[idxCust]) : '';
    const customerId = customerIdRaw ? customerIdRaw : null;
    const lengthMm = normalizeNumber(row[idxLen]);
    const widthMm = normalizeNumber(row[idxWid]);
    const thicknessMm = normalizeNumber(row[idxThk]);
    const stock = normalizeNumber(row[idxStock]);
    const stockAvailable = normalizeNumber(row[idxAvail]);
    const reservedStock = normalizeNumber(row[idxReserved]);
    if (typeData == null) continue;
    out.push({ typeData, customerId, lengthMm, widthMm, thicknessMm, stock, stockAvailable, reservedStock });
  }
  return out;
}

async function collectNcBaseNames(root: string): Promise<{ bases: Set<string>; hadError: boolean }> {
  const bases = new Set<string>();
  let hadError = false;
  async function walk(dir: string) {
    let entries: Dirent[] = [] as unknown as Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      hadError = true;
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(p);
      } else if (entry.isFile()) {
        const name = entry.name.toLowerCase();
        if (name.endsWith('.nc')) {
          const base = name.replace(/\.nc$/i, '');
          bases.add(base);
        }
      }
    }
  }
  await walk(root);
  return { bases, hadError };
}

async function stageSanityPollOnce() {
  try {
    // Fetch staged jobs with machine assignment
    const staged = await withClient(async (c) =>
      c
        .query<{ key: string; ncfile: string | null; machine_id: number | null }>(
          `SELECT key, ncfile, machine_id FROM public.jobs WHERE status = 'STAGED' AND machine_id IS NOT NULL`
        )
        .then((r) => r.rows)
    );
    if (!staged.length) return;

    // Group by machineId
    const byMachine = new Map<number, { key: string; nc: string; ncfile: string | null }[]>();
    for (const row of staged) {
      const mid = row.machine_id!;
      const ncBase = (row.ncfile ?? '').toLowerCase().replace(/\.nc$/i, '');
      if (!ncBase) continue;
      const list = byMachine.get(mid) ?? [];
      list.push({ key: row.key, nc: ncBase, ncfile: row.ncfile });
      byMachine.set(mid, list);
    }
    if (!byMachine.size) return;

    // Resolve machines
    const machines = await listMachines();
    let reverted = 0;
    for (const [machineId, items] of byMachine.entries()) {
      const m = machines.find((mm) => mm.machineId === machineId);
      const folder = m?.apJobfolder?.trim?.();
      if (!m || !folder) continue;
      const { bases: present, hadError } = await collectNcBaseNames(folder);
      // If filesystem traversal failed, skip this machine to avoid false negatives
      if (hadError) {
        recordWatcherEvent(STAGE_SANITY_WATCHER_NAME, { label: STAGE_SANITY_WATCHER_LABEL, message: 'Skipped stage sanity (folder traversal error)' });
        continue;
      }
      // Missing items
      const missing = items.filter((it) => !present.has(it.nc));
      const ncNamesToRelease: string[] = [];
      for (const miss of missing) {
        // Revert to PENDING if still STAGED
        const res = await withClient((c) =>
          c.query(
            `UPDATE public.jobs SET status = 'PENDING', machine_id = NULL, staged_at = NULL WHERE key = $1 AND status = 'STAGED'`,
            [miss.key]
          )
        );
        if ((res.rowCount ?? 0) > 0) {
          reverted += 1;
          const name = (miss.ncfile && miss.ncfile.toLowerCase().endsWith('.nc')) ? miss.ncfile : `${miss.nc}.nc`;
          ncNamesToRelease.push(name);
          const folder = miss.key.includes('/') ? miss.key.substring(0, miss.key.lastIndexOf('/')) : '';
          emitAppMessage(
            'job.ready.missing',
            {
              ncFile: name,
              folder
            },
            'stage-sanity'
          );
          try {
            await appendJobEvent(
              miss.key,
              'worklist:revert:missing-nc',
              { reason: 'NC file missing in Ready-To-Run', machineId },
              machineId,
              undefined
            );
          } catch {
            /* ignore appendJobEvent failure when reverting staged job */
          }
        }
      }
      if (ncNamesToRelease.length) {
        markPendingGrundnerReleaseMany(ncNamesToRelease);
        try {
          await appendProductionListDel(machineId, ncNamesToRelease);
        } catch (e) {
          unmarkPendingGrundnerReleaseMany(ncNamesToRelease);
          recordWorkerError(STAGE_SANITY_WATCHER_NAME, e, { machineId, label: STAGE_SANITY_WATCHER_LABEL });
        }
      }
    }
    if (reverted > 0) {
      recordWatcherEvent(STAGE_SANITY_WATCHER_NAME, {
        label: STAGE_SANITY_WATCHER_LABEL,
        message: `Reverted ${reverted} staged job(s) to PENDING due to missing NC in R2R`
      });
    }
  } catch (err) {
    recordWatcherError(STAGE_SANITY_WATCHER_NAME, err, { label: STAGE_SANITY_WATCHER_LABEL });
  }
}

function startStageSanityPoller() {
  registerWatcher(STAGE_SANITY_WATCHER_NAME, STAGE_SANITY_WATCHER_LABEL);
  const run = () => {
    if (shuttingDown) return;
    void stageSanityPollOnce();
  };
  void run();
  stageSanityTimer = setInterval(run, 10_000);
  if (typeof stageSanityTimer.unref === 'function') stageSanityTimer.unref();
  watcherReady(STAGE_SANITY_WATCHER_NAME, STAGE_SANITY_WATCHER_LABEL);
}

async function collectProcessedJobKeys(root: string): Promise<{ keys: Set<string>; hadError: boolean }> {
  const keys = new Set<string>();
  let hadError = false;
  async function walk(dir: string) {
    let entries: Dirent[] = [] as unknown as Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      hadError = true;
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p);
      } else if (e.isFile()) {
        if (e.name.toLowerCase().endsWith('.nc')) {
          // Build job key the same way as ingestProcessedJobsRoot (preserve original case)
          const relPath = relative(root, p).split('\\').join('/');
          const dirOnly = relPath.substring(0, relPath.lastIndexOf('/'));
          const base = e.name.replace(/\.nc$/i, '');
          const folder = dirOnly.split('/').filter(Boolean).pop() ?? '';
          const relFolder = dirOnly || folder;
          const key = `${relFolder}/${base}`.replace(/^\//, '').slice(0, 100);
          keys.add(key);
        }
      }
    }
  }
  await walk(root);
  return { keys, hadError };
}

async function sourceSanityPollOnce() {
  try {
    const cfg = loadConfig();
    const root = cfg.paths.processedJobsRoot?.trim?.() ?? '';
    if (!root || !(await fileExists(root))) return;

    const { keys: presentKeys, hadError } = await collectProcessedJobKeys(root);
    if (hadError) {
      recordWatcherEvent(SOURCE_SANITY_WATCHER_NAME, { label: SOURCE_SANITY_WATCHER_LABEL, message: 'Skipped source sanity (root traversal error)' });
      return;
    }
    // Find PENDING jobs whose key is not present on disk
    const pending = await withClient((c) =>
      c
        .query<{ key: string }>(`SELECT key FROM public.jobs WHERE status = 'PENDING'`)
        .then((r) => r.rows)
    );
    const missing = pending.map((r) => r.key).filter((k) => !presentKeys.has(k));
    if (!missing.length) return;

    // Delete missing PENDING jobs, including pre-reserved or locked ones (business rule)
    let removed = 0;
    for (const k of missing) {
      // Look up material and pre-reserved flag prior to deletion
      const row = await withClient((c) =>
        c
          .query<{ material: string | null; pre_reserved: boolean }>(
            `SELECT material, pre_reserved FROM public.jobs WHERE key = $1 AND status = 'PENDING' LIMIT 1`,
            [k]
          )
          .then((r) => r.rows[0] ?? null)
      );
      if (!row) continue;

      const res = await withClient((c) => c.query(`DELETE FROM public.jobs WHERE key = $1 AND status = 'PENDING'`, [k]));
      if ((res.rowCount ?? 0) > 0) {
        removed += 1;
        try {
          await appendJobEvent(k, 'jobs:prune:missing-source', { reason: 'NC file missing in processed root' }, null, undefined);
        } catch {
          /* ignore appendJobEvent failure during prune */
        }
        try {
          await resyncGrundnerPreReservedForMaterial(row.material ?? null);
        } catch {
          /* ignore grundner resync failure for this row */
        }
      }
    }
    if (removed > 0) {
      recordWatcherEvent(SOURCE_SANITY_WATCHER_NAME, {
        label: SOURCE_SANITY_WATCHER_LABEL,
        message: `Pruned ${removed} PENDING job(s) missing from processed root`
      });
    }
  } catch (err) {
    recordWatcherError(SOURCE_SANITY_WATCHER_NAME, err, { label: SOURCE_SANITY_WATCHER_LABEL });
  }
}

function startSourceSanityPoller() {
  registerWatcher(SOURCE_SANITY_WATCHER_NAME, SOURCE_SANITY_WATCHER_LABEL);
  const run = () => {
    if (shuttingDown) return;
    void sourceSanityPollOnce();
  };
  void run();
  sourceSanityTimer = setInterval(run, 30_000);
  if (typeof sourceSanityTimer.unref === 'function') sourceSanityTimer.unref();
  watcherReady(SOURCE_SANITY_WATCHER_NAME, SOURCE_SANITY_WATCHER_LABEL);
}

async function grundnerPollOnce(folder: string) {
  try {
    cleanupPendingGrundnerReleases();
    const reqPath = join(folder, 'stock_request.csv');
    const stockPath = join(folder, 'stock.csv');

    // If a pending request exists, do nothing and wait for next interval
    if (await fileExists(reqPath)) {
      //recordWatcherEvent(GRUNDNER_WATCHER_NAME, { label: GRUNDNER_WATCHER_LABEL, message: 'Request in flight; skipping' });
      return;
    }

    // 1) Drop request CSV (matching documented example content)
    const tmp = `${reqPath}.tmp-${Date.now()}`;
    await fsp.writeFile(tmp, '0\r\n!E', 'utf8');
    await rename(tmp, reqPath).catch(async () => {
      await fsp.writeFile(reqPath, '0\r\n!E', 'utf8');
    });
    recordWatcherEvent(GRUNDNER_WATCHER_NAME, { label: GRUNDNER_WATCHER_LABEL, message: 'Request dropped' });

    // 2) Wait 3 seconds and check for reply
    await delay(3000);
    if (!(await fileExists(stockPath))) return;
    await waitForStableFile(stockPath);
    if (!(await waitForFileRelease(stockPath))) {
      if (await fileExists(stockPath)) {
        recordWatcherEvent(GRUNDNER_WATCHER_NAME, { label: GRUNDNER_WATCHER_LABEL, message: 'Reply busy; will retry' });
      }
      return;
    }
    await delay(2000);
    let raw = '';
    try {
      raw = await readFile(stockPath, 'utf8');
    } finally {
      await unlinkWithRetry(stockPath);
    }
    const hash = createHash('sha1').update(raw).digest('hex');
    if (grundnerLastHash === hash) return;
    grundnerLastHash = hash;
    // Parse and then filter rows to the configured identity column to avoid
    // creating Grundner records with missing keys (e.g., type-only without customer id in customer_id mode).
    let items = parseGrundnerCsv(raw);
    try {
      const idCol = getGrundnerLookupColumn();
      if (idCol === 'customer_id') {
        items = items.filter((r) => (r.customerId ?? '').trim().length > 0);
      }
    } catch {
      // If settings lookup fails, proceed with unfiltered rows.
    }
    if (!items.length) return;
    const keyFor = (row: { typeData: number | null; customerId: string | null }) =>
      `${row.typeData ?? 'null'}::${row.customerId ?? 'null'}`;
    const uniqueKeys = new Map<string, { typeData: number | null; customerId: string | null }>();
    const itemsByKey = new Map<string, GrundnerCsvRow>();
    for (const item of items) {
      const key = keyFor(item);
      uniqueKeys.set(key, { typeData: item.typeData ?? null, customerId: item.customerId ?? null });
      itemsByKey.set(key, item);
    }
    const preReserved = new Map<string, number | null>();
    if (uniqueKeys.size) {
      const conditions: string[] = [];
      const params: (number | string | null)[] = [];
      let paramIndex = 1;
      for (const value of uniqueKeys.values()) {
        conditions.push(
          `(public.grundner.type_data IS NOT DISTINCT FROM $${paramIndex}::int AND public.grundner.customer_id IS NOT DISTINCT FROM $${paramIndex + 1}::text)`
        );
        params.push(value.typeData, value.customerId);
        paramIndex += 2;
      }
      try {
        const previousRows = await withClient((c) =>
          c
            .query<{ type_data: number | null; customer_id: string | null; reserved_stock: number | null }>(
              `SELECT type_data, customer_id, reserved_stock FROM public.grundner WHERE ${conditions.join(' OR ')}`,
              params
            )
            .then((r) => r.rows)
        );
        for (const row of previousRows) {
          preReserved.set(keyFor({ typeData: row.type_data, customerId: row.customer_id }), row.reserved_stock);
        }
      } catch (err) {
        recordWorkerError('grundner:pre-reserved', err);
      }
    }
    const result = await upsertGrundnerInventory(items);
    if (result.inserted > 0 || result.updated > 0 || result.deleted > 0) {
      scheduleRendererRefresh('grundner');
      scheduleRendererRefresh('allocated-material');
    }

    if (result.changed.length) {
      const changedKeys = new Set(result.changed.map((row) => keyFor(row)));
      for (const item of items) {
        const key = keyFor(item);
        if (!changedKeys.has(key)) continue;
        const oldReserved = preReserved.has(key) ? preReserved.get(key) : null;
        const newReserved = item.reservedStock;
        const materialLabel = item.customerId?.trim() || (item.typeData != null ? String(item.typeData) : 'Unknown');
        emitAppMessage(
          'grundner.stock.updated',
          {
            material: materialLabel,
            oldReserved: oldReserved != null ? oldReserved : 'N/A',
            newReserved: newReserved != null ? newReserved : 'N/A'
          },
          'grundner-poller'
        );
      }
    }

    if (result.changed.length) {
      const now = Date.now();
      cleanupPendingGrundnerReleases(now);
      cleanupPendingGrundnerConflicts(now);
      try {
        const conflicts = await findGrundnerAllocationConflicts(result.changed);
        if (conflicts.length) {
          const byMaterial = new Map<string, { count: number; reserved: number | null }>();
          const materialSet = new Set<string>();
          for (const row of conflicts) {
            const normalizedNc = row.ncfile ? normalizeNcName(row.ncfile) : null;
            if (normalizedNc && isPendingGrundnerRelease(normalizedNc, now)) {
              continue;
            }
            const label = row.material?.trim() || (row.typeData != null ? String(row.typeData) : 'Unknown');
            materialSet.add(label);
            const key = keyFor({ typeData: row.typeData, customerId: row.customerId });
            const reservedValue = itemsByKey.get(key)?.reservedStock ?? null;
            const existing = byMaterial.get(label);
            if (existing) {
              existing.count += 1;
              if (existing.reserved == null && reservedValue != null) {
                existing.reserved = reservedValue;
              }
            } else {
              byMaterial.set(label, { count: 1, reserved: reservedValue });
            }
          }
          if (!byMaterial.size) {
            for (const label of Array.from(pendingGrundnerConflicts.keys())) {
              if (!materialSet.has(label)) pendingGrundnerConflicts.delete(label);
            }
          } else {
            const effectiveConflicts: Array<{ material: string; detail: { count: number; reserved: number | null } }> = [];
            for (const [materialLabel, detail] of byMaterial) {
              const expiry = pendingGrundnerConflicts.get(materialLabel);
              if (!expiry) {
                pendingGrundnerConflicts.set(materialLabel, now + GRUNDNER_CONFLICT_GRACE_MS);
                continue;
              }
              if (expiry > now) {
                continue;
              }
              pendingGrundnerConflicts.delete(materialLabel);
              effectiveConflicts.push({ material: materialLabel, detail });
            }

            for (const label of Array.from(pendingGrundnerConflicts.keys())) {
              if (!materialSet.has(label)) pendingGrundnerConflicts.delete(label);
            }

            if (effectiveConflicts.length) {
              for (const { material, detail } of effectiveConflicts) {
                emitAppMessage(
                  'grundner.conflict',
                  {
                    material,
                    jobCount: detail.count,
                    reserved: detail.reserved != null ? detail.reserved : 'N/A'
                  },
                  'grundner-poller'
                );
              }
              const totalConflicts = effectiveConflicts.reduce((acc, entry) => acc + entry.detail.count, 0);
              const summary = `Grundner stock updated for ${totalConflicts} allocated material(s)`;
              const conflictDetails = effectiveConflicts.map(({ material, detail }) => ({ material, detail }));
              postMessageToMain({
                type: 'appAlert',
                category: 'grundner',
                summary,
                details: { conflicts: conflictDetails }
              });
              recordWatcherEvent(GRUNDNER_WATCHER_NAME, {
                label: GRUNDNER_WATCHER_LABEL,
                message: summary,
                context: { conflicts: conflictDetails }
              });
            }
          }
        } else {
          pendingGrundnerConflicts.clear();
        }
      } catch (err) {
        recordWorkerError('grundner:conflict-check', err);
      }
    }

    recordWatcherEvent(GRUNDNER_WATCHER_NAME, {
      label: GRUNDNER_WATCHER_LABEL,
      message: `Synced Grundner stock (inserted ${result.inserted}, updated ${result.updated}, deleted ${result.deleted})`
    });
  } catch (err) {
    recordWatcherError(GRUNDNER_WATCHER_NAME, err, { label: GRUNDNER_WATCHER_LABEL });
  }
}

function startGrundnerPoller(folder: string) {
  registerWatcher(GRUNDNER_WATCHER_NAME, GRUNDNER_WATCHER_LABEL);
  const trimmed = folder?.trim?.() ?? '';
  if (!trimmed) {
    recordWatcherEvent(GRUNDNER_WATCHER_NAME, { label: GRUNDNER_WATCHER_LABEL, message: 'Disabled (folder not configured)' });
    return;
  }
  const normalizedRoot = normalize(trimmed);
  if (!existsSync(normalizedRoot)) {
    const err = new Error('Grundner folder does not exist');
    recordWatcherError(GRUNDNER_WATCHER_NAME, err, { folder: normalizedRoot, label: GRUNDNER_WATCHER_LABEL });
    return;
  }

  const run = () => {
    if (shuttingDown) return;
    void grundnerPollOnce(normalizedRoot);
  };
  // immediate + interval
  void run();
  grundnerTimer = setInterval(run, 10_000);
  if (typeof grundnerTimer.unref === 'function') grundnerTimer.unref();
  watcherReady(GRUNDNER_WATCHER_NAME, GRUNDNER_WATCHER_LABEL);
}

function startJobsIngestPolling() {
  const INGEST_INTERVAL_MS = 5000; // 5 seconds

  async function runIngest() {
    if (shuttingDown) return;
    try {
      const cfg = loadConfig();
      const root = cfg.paths.processedJobsRoot?.trim?.() ?? '';
      if (!root) {
        if (!processedRootMissingNotified) {
          emitAppMessage(
            'jobsFolder.unreadable',
            { path: '(not configured)', error: 'Jobs folder path is not configured' },
            'jobs-ingest'
          );
          processedRootMissingNotified = true;
        }
        return;
      }
      if (!existsSync(root)) {
        if (!processedRootMissingNotified) {
          emitAppMessage(
            'jobsFolder.unreadable',
            { path: root, error: 'Jobs folder path does not exist' },
            'jobs-ingest'
          );
          processedRootMissingNotified = true;
        }
        return;
      }
      processedRootMissingNotified = false;

      const result = await ingestProcessedJobsRoot();
      for (const job of result.addedJobs ?? []) {
        emitAppMessage('job.detected', { ncFile: job.ncFile, folder: job.folder }, 'jobs-ingest');
      }
      for (const job of result.updatedJobs ?? []) {
        emitAppMessage('job.updated', { ncFile: job.ncFile, folder: job.folder }, 'jobs-ingest');
      }
      const pruned = result.prunedJobs ?? [];
      if (pruned.length) {
        const lockedNames = new Set<string>();
        for (const job of pruned) {
          emitAppMessage('job.removed', { ncFile: job.ncFile, folder: job.folder }, 'jobs-ingest');
          // Only collect locked jobs for unlock trigger
          if (job.isLocked) {
            lockedNames.add(job.ncFile);
          }
        }
        const names = Array.from(lockedNames);
        if (names.length) {
          markPendingGrundnerReleaseMany(names);
          try {
            await appendProductionListDel(0, names);
          } catch (err) {
            unmarkPendingGrundnerReleaseMany(names);
            recordWorkerError('jobs-ingest', err, { count: names.length });
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Jobs ingest poll failed');
    }
  }

  // Run immediately on startup
  void runIngest();

  // Then poll every 5 seconds
  jobsIngestInterval = setInterval(() => {
    void runIngest();
  }, INGEST_INTERVAL_MS);

  if (typeof jobsIngestInterval.unref === 'function') {
    jobsIngestInterval.unref();
  }

  logger.info({ intervalMs: INGEST_INTERVAL_MS }, 'Jobs ingest polling started');
}

// ---------------------------------------------------------------------------------
// NC Cat Jobs Watcher - Watches jobsRoot for new NC files and moves them to processedJobsRoot
// ---------------------------------------------------------------------------------

/**
 * Move an entire folder from source to destination.
 * Tries atomic rename first, falls back to copy+delete for cross-device moves.
 */
async function moveFolderToDestination(source: string, destRoot: string): Promise<{ ok: boolean; newPath?: string; error?: string }> {
  try {
    const folderName = basename(source);
    const destination = join(destRoot, folderName);

    // Ensure destination root exists
    if (!existsSync(destRoot)) {
      mkdirSync(destRoot, { recursive: true });
    }

    // Check if destination already exists - add timestamp suffix
    let finalDest = destination;
    if (existsSync(destination)) {
      finalDest = join(destRoot, `${folderName}_${Date.now()}`);
      logger.warn({ source, destination, finalDest }, 'nccat: destination exists, using timestamped name');
    }

    try {
      // Try atomic rename first
      await rename(source, finalDest);
      return { ok: true, newPath: finalDest };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EXDEV') {
        // Cross-device, need to copy then delete
        await copyFolderRecursive(source, finalDest);
        await deleteFolderRecursive(source);
        return { ok: true, newPath: finalDest };
      }
      throw err;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

async function copyFolderRecursive(src: string, dest: string): Promise<void> {
  if (!existsSync(dest)) {
    mkdirSync(dest, { recursive: true });
  }
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyFolderRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      await copyFile(srcPath, destPath);
    }
  }
}

async function deleteFolderRecursive(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(path, entry.name);
    if (entry.isDirectory()) {
      await deleteFolderRecursive(fullPath);
    } else {
      await unlink(fullPath);
    }
  }
  await fsp.rmdir(path);
}

/**
 * Handle a new NC file detected in jobsRoot.
 * Moves the entire parent folder (job folder) to processedJobsRoot.
 */
async function handleNcCatJobFile(ncFilePath: string) {
  const cfg = loadConfig();
  const processedJobsRoot = cfg.paths.processedJobsRoot;
  const quarantineRoot = cfg.paths.quarantineRoot;

  if (!processedJobsRoot) {
    logger.warn({ ncFilePath }, 'nccat: processedJobsRoot not configured, skipping');
    return;
  }

  // Get the job folder (parent of NC file)
  const jobFolder = join(ncFilePath, '..');
  const normalizedJobFolder = normalize(jobFolder);
  const folderName = basename(normalizedJobFolder);
  const ncFileName = basename(ncFilePath);

  logger.info({ ncFilePath, jobFolder: normalizedJobFolder, folderName }, 'nccat: processing new NC file');

  recordWatcherEvent(NCCAT_WATCHER_NAME, {
    label: NCCAT_WATCHER_LABEL,
    message: `Processing: ${ncFileName}`,
    context: { ncFilePath, folderName }
  });

  // For now, move directly to processedJobsRoot without validation
  // TODO: Add NC Cat validation integration via IPC to main process
  const destRoot = processedJobsRoot;

  const moveResult = await moveFolderToDestination(normalizedJobFolder, destRoot);

  if (!moveResult.ok) {
    logger.error({ ncFilePath, jobFolder: normalizedJobFolder, error: moveResult.error }, 'nccat: failed to move job folder');
    recordWatcherError(NCCAT_WATCHER_NAME, new Error(moveResult.error ?? 'Move failed'), {
      label: NCCAT_WATCHER_LABEL,
      ncFilePath,
      jobFolder: normalizedJobFolder
    });

    // If move failed and quarantine is configured, try to move to quarantine
    if (quarantineRoot) {
      const quarantineResult = await moveFolderToDestination(normalizedJobFolder, quarantineRoot);
      if (quarantineResult.ok) {
        emitAppMessage('ncCat.jobQuarantined', {
          folderName,
          ncFile: ncFileName,
          reason: 'move_failed',
          error: moveResult.error
        }, 'nc-cat-watcher');
      }
    }
    return;
  }

  logger.info(
    { ncFilePath, source: normalizedJobFolder, destination: moveResult.newPath },
    'nccat: job folder moved successfully'
  );

  recordWatcherEvent(NCCAT_WATCHER_NAME, {
    label: NCCAT_WATCHER_LABEL,
    message: `Moved: ${folderName}`,
    context: { source: normalizedJobFolder, destination: moveResult.newPath }
  });

  emitAppMessage('ncCat.jobMoved', {
    folderName,
    ncFile: ncFileName,
    destination: moveResult.newPath
  }, 'nc-cat-watcher');

  // Trigger ingest to pick up the new job
  try {
    const ingestResult = await ingestProcessedJobsRoot();
    logger.info(
      { inserted: ingestResult.inserted, updated: ingestResult.updated },
      'nccat: triggered ingest after move'
    );
  } catch (ingestErr) {
    logger.warn({ err: ingestErr }, 'nccat: ingest failed after move');
  }
}

/**
 * Collect existing NC files in jobsRoot for processing on startup
 */
async function collectExistingNcFiles(dir: string, depth = 0, maxDepth = 3): Promise<string[]> {
  if (depth > maxDepth) return [];
  const results: string[] = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await collectExistingNcFiles(fullPath, depth + 1, maxDepth);
        results.push(...subFiles);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.nc')) {
        results.push(fullPath);
      }
    }
  } catch (err) {
    logger.warn({ err, dir }, 'nccat: failed to scan directory');
  }

  return results;
}

function setupNcCatJobsWatcher(dir: string) {
  registerWatcher(NCCAT_WATCHER_NAME, NCCAT_WATCHER_LABEL);

  const onAdd = stableProcess(handleNcCatJobFile, 2000, {
    watcherName: NCCAT_WATCHER_NAME,
    watcherLabel: NCCAT_WATCHER_LABEL
  });

  const watcher = chokidar.watch(dir, {
    ignoreInitial: false, // Process existing files on startup
    depth: 3, // Watch jobsRoot/FolderName/SubFolder/file.nc
    awaitWriteFinish: {
      stabilityThreshold: 2000, // Wait 2 seconds for file to stabilize
      pollInterval: 250
    }
  });

  trackWatcher(watcher);

  // Only trigger for .nc files
  watcher.on('add', (path) => {
    if (path.toLowerCase().endsWith('.nc')) {
      onAdd(path);
    }
  });

  watcher.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException)?.code;
    setMachineHealthIssue({
      machineId: null,
      code: HEALTH_CODES.copyFailure,
      message: `NC Cat jobs watcher error${code ? ` (${code})` : ''}`,
      severity: 'critical',
      context: { dir, code }
    });
    recordWatcherError(NCCAT_WATCHER_NAME, err, { dir, label: NCCAT_WATCHER_LABEL });
    logger.error({ err, dir }, 'nccat: watcher error');
  });

  watcher.on('ready', () => {
    watcherReady(NCCAT_WATCHER_NAME, NCCAT_WATCHER_LABEL);
    clearMachineHealthIssue(null, HEALTH_CODES.copyFailure);
    logger.info({ dir }, 'nccat: jobs watcher ready');
  });

  logger.info({ dir }, 'nccat: jobs watcher started');
}

// ---------------------------------------------------------------------------------

async function initWatchers() {
  logger.info('watchers: waiting for database readiness before starting');
  await waitForDbReady();
  await startDbNotificationListener();
  const cfg = loadConfig();
  if (cfg.paths.autoPacCsvDir) {
    setupAutoPacWatcher(cfg.paths.autoPacCsvDir);
  }
  if (cfg.paths.grundnerFolderPath) {
    startGrundnerPoller(cfg.paths.grundnerFolderPath);
  }
  if (cfg.test.useTestDataMode) {
    setupTestDataWatcher(cfg.test.testDataFolderPath);
  }
  if (cfg.paths.jobsRoot) {
    setupNcCatJobsWatcher(cfg.paths.jobsRoot);
  }
  void setupNestpickWatchers();
  startJobsIngestPolling();
  startStageSanityPoller();
  startSourceSanityPoller();
}

void initWatchers().catch((err) => {
  recordWorkerError('watchers:init', err);
  logger.error({ err }, 'watchersWorker: failed to initialize watchers');
});

if (channel) {
  channel.on('message', (message: MainToWatcherMessage) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'shutdown') {
      void shutdown(message.reason).finally(() => process.exit(0));
    }
  });
}

process.on('SIGINT', () => {
  void shutdown('SIGINT').finally(() => process.exit(0));
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM').finally(() => process.exit(0));
});

process.on('uncaughtException', (err) => {
  recordWorkerError('watchers-worker', err);
  logger.error({ err }, 'watchersWorker: uncaught exception');
});

process.on('unhandledRejection', (reason) => {
  recordWorkerError('watchers-worker', reason);
  logger.error({ reason }, 'watchersWorker: unhandled rejection');
});
