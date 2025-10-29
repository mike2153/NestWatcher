import chokidar, { type FSWatcher } from 'chokidar';
import { createHash } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { promises as fsp } from 'fs';
import type { Dirent } from 'fs';
import net from 'net';
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
import { upsertCncStats } from '../repo/cncStatsRepo';
import type { CncStatsUpsert } from '../repo/cncStatsRepo';
import { normalizeTelemetryPayload } from './telemetryParser';
import type { WatcherWorkerToMainMessage, MainToWatcherMessage } from './watchersMessages';
import { ingestProcessedJobsRoot } from '../services/ingest';
import { appendProductionListDel } from '../services/nestpick';

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

function trackWatcher(watcher: FSWatcher) {
  fsWatchers.add(watcher);
  watcher.on('close', () => fsWatchers.delete(watcher));
}

let shuttingDown = false;
let jobsIngestInterval: NodeJS.Timeout | null = null;
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
  if (!timestampValue) {
    timestampValue = new Date().toISOString();
    logger.info({ file: fileName, timestamp: timestampValue }, 'test-data: missing timestamp; using current time');
  }

  const apiIp = pickString(
    [record, machineStatus],
    ['CNC_IP', 'cnc_ip', 'api_ip', 'ip']
  );
  // Key is timestamp only (no IP component)
  const key = timestampValue;

  const alarmHistoryRaw = pickCaseInsensitive(record, ['AlarmHistoryDictionary', 'alarmHistory', 'AlarmHistory']);
  const alarmHistory =
    alarmHistoryRaw && typeof alarmHistoryRaw === 'object' && Object.keys(alarmHistoryRaw as Record<string, unknown>).length
      ? JSON.stringify(alarmHistoryRaw)
      : null;

  const upsert: CncStatsUpsert = {
    key,
    apiIp,
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
      ['PowerOnTime_sec', 'powerOnTime', 'power_on', 'PowerOn', 'powerontime']
    ),
    cuttingTime: pickString(
      [timers, record],
      ['CycleCuttingTime_sec', 'cycleCuttingTime', 'AccumulatedCuttingTime_sec', 'cuttingTime', 'cut_time']
    ),
    alarmHistory,
    vacuumTime: pickString([timers, record], ['VacTime_sec', 'vacTime', 'VacuumTime']),
    drillHeadTime: pickString([timers, record], ['DrillTime_sec', 'drillTime', 'DrillHeadTime']),
    spindleTime: pickString([timers, record], ['SpindleTime_sec', 'spindleTime']),
    conveyorTime: pickString([timers, record], ['ConveyorTime_sec', 'conveyorTime']),
    greaseTime: pickString([timers, record], ['GreaseTime_sec', 'greaseTime'])
  };
  logger.info(
    {
      file: fileName,
      key: upsert.key,
      apiIp: upsert.apiIp ?? undefined,
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

      if (lifecycle.ok && to === 'CNC_FINISH') {
        await forwardToNestpick(base, job, machineForJob, machines);
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
      }
    }
    await moveToArchive(path, join(machine.nestpickFolder, 'archive'));
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
          { sourcePlace: sourcePlaceValue, pallet: sourcePlaceValue, file: path },
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
        }
        processedAny = true;
      } else {
        logger.warn({ jobKey: job.key, base, sourcePlace: sourcePlaceValue, row: i + 1 }, 'watcher: unstack pallet update failed');
      }
    }
    const archiveDir = join(machine.nestpickFolder, 'archive');
    await moveToArchive(path, archiveDir);
    logger.info({ file: path, archiveDir, processedAny }, 'watcher: unstack archived');

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

class TelemetryClient {
  private socket: net.Socket | null = null;
  private buffer = '';
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stopped = false;
  private lastSignature: string | null = null;
  private readonly watcherName: string;
  private readonly watcherLabel: string;

  constructor(private readonly machine: Machine) {
    this.watcherName = `watcher:telemetry:${machine.machineId}`;
    this.watcherLabel = `Telemetry (${machineLabel(machine)})`;
    registerWatcher(this.watcherName, this.watcherLabel);
  }

  start() {
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.clearReconnect();
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }

  private clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(reason: string) {
    if (this.stopped) return;
    this.clearReconnect();
    const delay = Math.min(30_000, Math.pow(2, Math.min(this.attempt, 5)) * 1000);
    recordWatcherEvent(this.watcherName, {
      label: this.watcherLabel,
      message: `${reason}; retrying in ${Math.round(delay / 1000)}s`,
      context: { machineId: this.machine.machineId }
    });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    if (typeof this.reconnectTimer.unref === 'function') {
      this.reconnectTimer.unref();
    }
  }

  private connect() {
    if (this.stopped) return;
    const host = this.machine.pcIp?.trim();
    const port = this.machine.pcPort ?? 0;
    if (!host || !port) {
      recordWatcherEvent(this.watcherName, {
        label: this.watcherLabel,
        message: 'Telemetry disabled (missing PC IP/port)',
        context: { machineId: this.machine.machineId }
      });
      return;
    }

    this.attempt += 1;
    this.clearReconnect();

    this.socket = net.createConnection({ host, port }, () => {
      this.attempt = 0;
      this.buffer = '';
      this.lastSignature = null;
      watcherReady(this.watcherName, this.watcherLabel);
      recordWatcherEvent(this.watcherName, {
        label: this.watcherLabel,
        message: 'Connected to telemetry stream',
        context: { host, port, machineId: this.machine.machineId }
      });
    });

    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk) => this.handleData(chunk));
    this.socket.on('error', (err) => {
      recordWatcherError(this.watcherName, err, {
        host,
        port,
        machineId: this.machine.machineId,
        label: this.watcherLabel
      });
    });
    this.socket.on('close', () => {
      if (this.stopped) return;
      this.socket?.removeAllListeners();
      this.socket = null;
      this.scheduleReconnect('Telemetry connection closed');
    });
  }

  private handleData(chunk: string | Buffer) {
    if (this.stopped) return;
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const raw = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (raw.length > 0) {
        void this.processLine(raw);
      }
      index = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > 64_000) {
      this.buffer = '';
    }
  }

  private async processLine(line: string) {
    try {
      const payload = JSON.parse(line);
      const normalized = normalizeTelemetryPayload(this.machine, payload);
      const signature = JSON.stringify(normalized);
      if (signature === this.lastSignature) {
        return;
      }
      this.lastSignature = signature;
      await upsertCncStats(normalized);
      const statusSummary = normalized.status ? `status=${normalized.status}` : 'status updated';
      recordWatcherEvent(this.watcherName, {
        label: this.watcherLabel,
        message: `Telemetry update (${statusSummary})`,
        context: { machineId: this.machine.machineId }
      });
    } catch (err) {
      recordWatcherError(this.watcherName, err, {
        machineId: this.machine.machineId,
        label: this.watcherLabel,
        sample: line.slice(0, 500)
      });
    }
  }
}

const telemetryClients: TelemetryClient[] = [];

async function startTelemetryClients() {
  try {
    const machines = await listMachines();
    for (const machine of machines) {
      const host = machine.pcIp?.trim();
      const port = machine.pcPort ?? 0;
      if (!host || !port) continue;
      const client = new TelemetryClient(machine);
      telemetryClients.push(client);
      client.start();
    }
    if (telemetryClients.length === 0) {
      logger.debug('watchersWorker: no telemetry endpoints configured');
    }
  } catch (err) {
    recordWorkerError('telemetry:init', err);
    logger.error({ err }, 'watchersWorker: failed to initialize telemetry clients');
  }
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
  for (const client of telemetryClients) {
    try {
      client.stop();
    } catch (err) {
      logger.warn({ err }, 'watchersWorker: failed to stop telemetry client');
    }
  }
  telemetryClients.length = 0;
}

let testDataProcessedCount = 0;

async function handleTestDataFile(path: string, client?: PoolClient, options?: { skipDelete?: boolean }): Promise<boolean> {
  const baseName = basename(path);
  try {
    // Rely on chokidar awaitWriteFinish for stability; do not add extra waits here
    const raw = await readFile(path, 'utf8');
    const payloads = parseTestDataPayloads(raw, baseName);
    if (!payloads.length) {
      logger.warn({ file: path }, 'test-data: file contained no payloads');
      return false;
    }

    let processed = 0;
    for (let index = 0; index < payloads.length; index++) {
      const upsert = buildTestDataUpsert(payloads[index], baseName);
      if (!upsert) continue;
      try {
        logger.debug({ file: path, index, key: upsert.key }, 'test-data: upserting telemetry row');
        await upsertCncStats(upsert, client);
        processed += 1;
        logger.debug({ file: path, index, key: upsert.key }, 'test-data: upsert succeeded');
      } catch (err) {
        recordWorkerError(TESTDATA_WATCHER_NAME, err, {
          path,
          key: upsert.key,
          label: TESTDATA_WATCHER_LABEL,
          index
        });
        logger.error({ err, file: path, key: upsert.key }, 'test-data: failed to upsert telemetry entry');
      }
    }

    if (processed > 0) {
      if (!options?.skipDelete) {
        try {
          await unlinkWithRetry(path);
        } catch (e) {
          logger.warn({ err: e, file: path }, 'test-data: failed to delete source file after success');
        }
        testDataProcessedCount += processed;
        if (testDataProcessedCount % 100 === 0) {
          const message = `Processed ${testDataProcessedCount} test-data files`;
          logger.info({ total: testDataProcessedCount }, 'test-data: processed files milestone');
          recordWatcherEvent(TESTDATA_WATCHER_NAME, { label: TESTDATA_WATCHER_LABEL, message });
        }
      }
      if (options?.skipDelete) {
        // When deferring deletion, defer milestone counting as well (outer loop will handle)
      }
      
      return true;
    } else {
      const err = new Error('No valid telemetry rows found');
      recordWatcherError(TESTDATA_WATCHER_NAME, err, { path, label: TESTDATA_WATCHER_LABEL });
      logger.warn({ file: path }, 'test-data: skipping file because no valid rows were ingested');
      return false;
    }
  } catch (err) {
    recordWatcherError(TESTDATA_WATCHER_NAME, err, { path, label: TESTDATA_WATCHER_LABEL });
    logger.error({ err, file: path }, 'test-data: failed to ingest file');
    return false;
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

const TESTDATA_BATCH_SIZE = 100;

async function processNextTestData() {
  if (testDataProcessing) return;
  testDataProcessing = true;
  try {
    await withClient(async (client) => {
  // Batch files per transaction for fewer commits
  let keepRunning = true;
  outer: while (keepRunning) {
        const toDelete: string[] = [];
        let processedInBatch = 0;
        await client.query('BEGIN');
        try {
          while (processedInBatch < TESTDATA_BATCH_SIZE) {
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
            if (!next) break; // End of batch and possibly all work
            try {
              const ok = await handleTestDataFile(next, client, { skipDelete: true });
              if (ok) toDelete.push(next);
            } finally {
              testDataQueued.delete(next!);
            }
            processedInBatch += 1;
          }
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          logger.warn({ err }, 'test-data: batch failed and was rolled back');
        }

        // Delete files after commit to ensure at-least-once semantics
        if (toDelete.length > 0) {
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

        // If batch was empty (no next file), exit
        if (processedInBatch === 0) {
          keepRunning = false;
          break outer;
        }
      }
    });
  } finally {
    testDataProcessing = false;
  }
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
      recordWatcherEvent(GRUNDNER_WATCHER_NAME, { label: GRUNDNER_WATCHER_LABEL, message: 'Request in flight; skipping' });
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
    const items = parseGrundnerCsv(raw);
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
  void setupNestpickWatchers();
  if (cfg.test.useTestDataMode) {
    logger.info('Telemetry disabled: running in test data mode');
  } else {
    void startTelemetryClients();
  }
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
