import chokidar, { type FSWatcher } from 'chokidar';
import { createHash } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { promises as fsp } from 'fs';
import type { Dirent } from 'fs';
import { basename, extname, join, normalize, relative, sep } from 'path';
import type { PoolClient } from 'pg';
import { parentPort } from 'worker_threads';
import type {
  Machine,
  MachineHealthCode,
  NcCatHeadlessValidationFileResult,
  NcCatValidationReport,
  ValidationResult
} from '../../../shared/src';
import { loadConfig } from '../services/config';
import { logger } from '../logger';
import { getPool, testConnection, withClient } from '../services/db';
import { appendJobEvent } from '../repo/jobEventsRepo';
import { upsertGrundnerInventory, type GrundnerCsvRow, findGrundnerAllocationConflicts } from '../repo/grundnerRepo';
import { listMachines } from '../repo/machinesRepo';
import { findJobByNcBase, findJobByNcBasePreferStatus, updateJobPallet, updateLifecycle, resyncGrundnerPreReservedForMaterial } from '../repo/jobsRepo';
import { bulkUpsertCncStats } from '../repo/cncStatsRepo';
import type { CncStatsUpsert } from '../repo/cncStatsRepo';
import { upsertNcStats } from '../repo/ncStatsRepo';
import { getLatestNestpickEnabledForPcIp } from '../repo/nestpickModeRepo';
import type {
  WatcherWorkerToMainMessage,
  MainToWatcherMessage,
  NcCatValidationResponsePayload
} from './watchersMessages';
import { ingestProcessedJobsRoot } from '../services/ingest';
import { appendProductionListDel } from '../services/nestpick';
import { archiveCompletedJob } from '../services/archive';
import { buildNcCatValidationReport } from '../services/ncCatValidationReport';
import { archiveGrundnerReplyFile } from '../services/grundnerArchive';

const { access, copyFile, readFile, readdir, rename, stat, unlink, open } = fsp;

// Windows (and many network shares) deny directory listing for these system folders.
// If a configured root mistakenly points at the drive root (e.g. Z:\), recursive
// scans will hit these and throw EPERM. We skip them to avoid spam + false errors.
const SKIP_TRAVERSAL_DIRS = new Set(['$recycle.bin', 'system volume information']);

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

function recordWatcherBackoff(
  name: string,
  event: { label?: string; message: string; context?: Record<string, unknown> }
) {
  postMessageToMain({ type: 'watcherBackoff', name, label: event.label, message: event.message, context: event.context });
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

const NCCAT_VALIDATION_TIMEOUT_MS = 90_000;
const ncCatValidationPending = new Map<
  string,
  { resolve: (result: NcCatValidationResponsePayload) => void; timeout: NodeJS.Timeout }
>();

function requestNcCatHeadlessValidation(payload: {
  reason: 'ingest' | 'stage';
  folderName: string;
  files: { filename: string; ncContent: string }[];
  machineNameHint?: string | null;
  machineId?: number | null;
}): Promise<NcCatValidationResponsePayload> {
  const requestId = `nccat-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      ncCatValidationPending.delete(requestId);
      resolve({ ok: false, error: 'Headless validation request timed out' });
    }, NCCAT_VALIDATION_TIMEOUT_MS);

    ncCatValidationPending.set(requestId, { resolve, timeout });
    postMessageToMain({
      type: 'ncCatValidationRequest',
      requestId,
      payload
    });
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
let jobsIngestTimer: NodeJS.Timeout | null = null;
let processedRootMissingNotified = false;
let stageSanityTimer: NodeJS.Timeout | null = null;
let sourceSanityTimer: NodeJS.Timeout | null = null;

const autoPacHashes = new Map<string, string>();
const pendingGrundnerReleases = new Map<string, number>();
const PENDING_GRUNDNER_RELEASE_TTL_MS = 60_000;
const pendingGrundnerConflicts = new Map<string, number>();
const GRUNDNER_CONFLICT_GRACE_MS = 120_000;

const NESTPICK_FILENAME = 'Nestpick.csv';
const NESTPICK_ACK_FILENAME = 'Nestpick.erl';
const NESTPICK_UNSTACK_FILENAME = 'Report_FullNestpickUnstack.csv';


const AUTOPAC_WATCHER_NAME = 'watcher:autopac';
const AUTOPAC_WATCHER_LABEL = 'AutoPAC CSV Watcher';
const AUTOPAC_ARCHIVE_DIRNAME = 'archieve';
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

type NestpickOutboundRecord = {
  jobKey: string;
  base: string;
  hash: string;
  normalizedContent: string;
  writtenAt: number;
};

// Tracks the most recent outbound Nestpick payload per machine, so we can validate Nestpick.erl.
const lastNestpickOutboundByMachine = new Map<number, NestpickOutboundRecord>();


type RefreshChannel = 'grundner';
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

function nestpickAckWatcherName(machine: Machine) {
  return `watcher:nestpick-ack:${machine.machineId}`;
}

function nestpickAckWatcherLabel(machine: Machine) {
  return `Nestpick Ack (${machineLabel(machine)})`;
}

function shouldIgnoreShareTempFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (!name) return false;

  // Windows / network share noise.
  if (name === 'thumbs.db') return true;
  if (name === 'desktop.ini') return true;
  if (name === '.ds_store') return true;
  if (name.startsWith('~$')) return true; // Office temp files

  // Network shares often create/delete temp files very quickly.
  // Chokidar can emit lstat errors for these transient paths.
  if (name.endsWith('.tmp')) return true;
  if (name.includes('.tmp-')) return true;
  if (name.endsWith('.swp')) return true;
  if (name.endsWith('.part')) return true;

  // Guard against transient system folders if chokidar probes parent dirs.
  if (name === '$recycle.bin') return true;
  if (name === 'system volume information') return true;

  return false;
}

function isBenignChokidarLstatTempError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return lower.includes('lstat') && lower.includes('.tmp');
}

function shouldIgnoreAutoPacPath(path: string): boolean {
  const lower = toPosixLower(path);
  // When AutoPAC archive is enabled, we move CSVs into an archive folder.
  // Ignore it so we don't re-process archived files.
  if (lower.includes(`/${AUTOPAC_ARCHIVE_DIRNAME.toLowerCase()}/`) || lower.endsWith(`/${AUTOPAC_ARCHIVE_DIRNAME.toLowerCase()}`)) {
    return true;
  }
  return shouldIgnoreShareTempFile(path);
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

// ---------------------------------------------------------------------------------
// Watcher self-heal backoff
//
// Goal: network shares go offline in real shops. A watcher should never spam logs
// or freeze the app. On error we close the watcher, then retry using exponential
// backoff starting at 7.5 seconds and doubling up to 240 seconds.
// ---------------------------------------------------------------------------------

const WATCHER_BACKOFF_INITIAL_MS = 7_500;
const WATCHER_BACKOFF_MAX_MS = 240_000;

type BackoffState = {
  attempt: number;
  offlineSinceMs: number;
  maxDelayReachAtMs: number;
  nextRetryAtMs: number;
};

function computeBackoffDelayMs(attempt: number): number {
  // attempt: 0 => 7.5 seconds
  // attempt: 1 => 15 seconds
  // attempt: 2 => 30 seconds
  // ... capped at 240 seconds
  return Math.min(WATCHER_BACKOFF_MAX_MS, WATCHER_BACKOFF_INITIAL_MS * Math.pow(2, attempt));
}

function computeMaxDelayReachAtMs(offlineSinceMs: number): number {
  // This is the time when the backoff first reaches the max delay.
  // For the configured backoff this is after 5 retries:
  // 7.5 + 15 + 30 + 60 + 120 seconds.
  let total = 0;
  let delayMs = WATCHER_BACKOFF_INITIAL_MS;
  while (delayMs < WATCHER_BACKOFF_MAX_MS) {
    total += delayMs;
    delayMs = Math.min(WATCHER_BACKOFF_MAX_MS, delayMs * 2);
  }
  return offlineSinceMs + total;
}

function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  // Only the first delay is fractional (7.5). Everything else is a whole number.
  if (Number.isInteger(seconds)) {
    return `${seconds} seconds`;
  }
  return `${seconds.toFixed(1)} seconds`;
}

function formatTimeOfDay(ms: number): string {
  const d = new Date(ms);
  let h = d.getHours();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12;
  if (h === 0) h = 12;
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${mm}:${ss}${ampm}`;
}

function buildBackoffStatusMessage(params: {
  delayMs: number;
  nextRetryAtMs: number;
  maxDelayReachAtMs: number;
}): string {
  const nextTime = formatTimeOfDay(params.nextRetryAtMs);
  const capTime = formatTimeOfDay(params.maxDelayReachAtMs);
  return `Still offline. Retrying in ${formatSeconds(params.delayMs)} at ${nextTime}. Trying to connect until ${capTime} then restarting watcher every ${Math.round(WATCHER_BACKOFF_MAX_MS / 1000)} seconds.`;
}

function scheduleBackoffRetry(state: BackoffState, nowMs: number): { delayMs: number; nextRetryAtMs: number } {
  const delayMs = computeBackoffDelayMs(state.attempt);
  const nextRetryAtMs = nowMs + delayMs;
  state.attempt += 1;
  state.nextRetryAtMs = nextRetryAtMs;
  return { delayMs, nextRetryAtMs };
}

function shouldAttemptBackoff(state: BackoffState | undefined, nowMs: number): boolean {
  if (!state) return true;
  return nowMs >= state.nextRetryAtMs;
}

// Generic backoff storage for pollers and per-folder checks.
const backoffByKey = new Map<string, BackoffState>();

function getOrCreateBackoff(key: string, nowMs: number): BackoffState {
  const existing = backoffByKey.get(key);
  if (existing) return existing;
  const state: BackoffState = {
    attempt: 0,
    offlineSinceMs: nowMs,
    maxDelayReachAtMs: computeMaxDelayReachAtMs(nowMs),
    nextRetryAtMs: nowMs
  };
  backoffByKey.set(key, state);
  return state;
}

function clearBackoff(key: string) {
  backoffByKey.delete(key);
}

type ResilientWatcherOptions = {
  name: string;
  label: string;
  createWatcher: () => FSWatcher;
  targetContext?: Record<string, unknown>;
  shouldIgnoreError?: (err: unknown) => boolean;
  onOfflineOnce?: (err: unknown) => void;
  onReady?: () => void;
  onRecovered?: () => void;
};

type ResilientWatcherController = {
  start: () => void;
  stop: () => Promise<void>;
};

const resilientWatchers: ResilientWatcherController[] = [];

function createResilientWatcher(options: ResilientWatcherOptions): ResilientWatcherController {
  let watcher: FSWatcher | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let handlingError = false;
  let backoff: BackoffState | null = null;

  function clearRetryTimer() {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  async function closeWatcherInstance() {
    const current = watcher;
    watcher = null;
    if (!current) return;
    try {
      await current.close();
    } catch {
      // close failures should not crash the worker
    }
  }

  function attachBaseListeners(w: FSWatcher) {
    w.on('ready', () => {
      const wasOffline = backoff != null;
      backoff = null;
      handlingError = false;
      clearRetryTimer();
      watcherReady(options.name, options.label);
      try {
        options.onReady?.();
      } catch {
        // onReady should never crash the watcher loop
      }
      if (wasOffline) {
        recordWatcherEvent(options.name, {
          label: options.label,
          message: 'Recovered'
        });
        try {
          options.onRecovered?.();
        } catch {
          // ignore recovery callback failures
        }
      }
    });

    w.on('error', (err) => {
      if (options.shouldIgnoreError?.(err)) {
        return;
      }
      void handleError(err);
    });
  }

  async function handleError(err: unknown) {
    if (shuttingDown) return;
    if (handlingError) return;
    handlingError = true;

    const now = Date.now();
    if (!backoff) {
      backoff = {
        attempt: 0,
        offlineSinceMs: now,
        maxDelayReachAtMs: computeMaxDelayReachAtMs(now),
        nextRetryAtMs: now
      };
      try {
        options.onOfflineOnce?.(err);
      } catch {
        // onOfflineOnce should never crash the worker loop
      }
      recordWatcherError(options.name, err, { ...(options.targetContext ?? {}), label: options.label });
    }

    // Stop watcher spam at the source.
    await closeWatcherInstance();
    clearRetryTimer();

    const { delayMs, nextRetryAtMs } = scheduleBackoffRetry(backoff, now);
    const message = buildBackoffStatusMessage({
      delayMs,
      nextRetryAtMs,
      maxDelayReachAtMs: backoff.maxDelayReachAtMs
    });

    recordWatcherBackoff(options.name, {
      label: options.label,
      message,
      context: {
        ...(options.targetContext ?? {}),
        delayMs,
        nextRetryAt: new Date(nextRetryAtMs).toISOString(),
        maxDelayReachAt: new Date(backoff.maxDelayReachAtMs).toISOString(),
        attempt: backoff.attempt
      }
    });

    retryTimer = setTimeout(() => {
      retryTimer = null;
      handlingError = false;
      start();
    }, delayMs);
    if (typeof retryTimer.unref === 'function') retryTimer.unref();
  }

  function start() {
    if (shuttingDown) return;
    if (watcher) return;
    try {
      const w = options.createWatcher();
      watcher = w;
      trackWatcher(w);
      attachBaseListeners(w);
    } catch (err) {
      void handleError(err);
    }
  }

  async function stop() {
    clearRetryTimer();
    backoff = null;
    handlingError = false;
    await closeWatcherInstance();
  }

  const controller: ResilientWatcherController = { start, stop };
  resilientWatchers.push(controller);
  return controller;
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
        // Grundner changes are the only live inventory refresh channel.
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

function normalizeNestpickText(content: string): string {
  // Normalize line endings for stable hashing/comparisons across Windows/network shares.
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd() + '\n';
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
    lower.startsWith('cnc_finish') ||
    lower.startsWith('order_saw')
  );
}

async function ensureJobStatusEnumHasRunning() {
  try {
    const exists = await withClient(async (c) =>
      c
        .query(
          `
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON e.enumtypid = t.oid
            WHERE t.typname = 'job_status'
              AND e.enumlabel = 'RUNNING'
            LIMIT 1
          `
        )
        .then((r) => (r.rowCount ?? 0) > 0)
    );
    if (exists) return;

    // Note: ALTER TYPE ... ADD VALUE cannot run inside an explicit transaction.
    await withClient(async (c) => {
      await c.query(`ALTER TYPE job_status ADD VALUE 'RUNNING'`);
    });
    logger.info('watchers: added RUNNING to job_status enum');
  } catch (err) {
    // Best-effort: if this fails, later lifecycle updates to RUNNING will fail too.
    logger.warn({ err }, 'watchers: failed to ensure RUNNING exists in job_status enum');
  }
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

async function findMatchingNpt(root: string, base: string, depth = 0, maxDepth = 3): Promise<string | null> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const targetLower = base.toLowerCase();
    for (const entry of entries) {
      const entryPath = join(root, entry.name);
      if (entry.isFile()) {
        const nameLower = entry.name.toLowerCase();
        if (nameLower === `${targetLower}.npt`) {
          return entryPath;
        }
      }
    }
    if (depth >= maxDepth) return null;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryPath = join(root, entry.name);
      const result = await findMatchingNpt(entryPath, base, depth + 1, maxDepth);
      if (result) return result;
    }
  } catch (err) {
    logger.debug({ err, root }, 'watcher: failed listing directory');
  }
  return null;
}

function parseOrderSawChangeCsv(raw: string): Array<{ base: string; machineId: number }> {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const out: Array<{ base: string; machineId: number }> = [];
  for (const line of lines) {
    const delim = line.includes(';') ? ';' : line.includes(',') ? ',' : null;
    if (!delim) continue;
    const parts = line
      .split(delim)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (parts.length < 2) continue;

    const baseRaw = parts[0].replace(/\.nc$/i, '').trim();
    const machineRaw = parts[1].trim();
    const machineId = Number(machineRaw);
    if (!baseRaw) continue;
    if (!Number.isFinite(machineId)) continue;

    out.push({ base: baseRaw, machineId: Math.trunc(machineId) });
  }

  return out;
}

async function waitForSlot(path: string, timeoutMs = 60_000) {
  const start = Date.now();
  while (await fileExists(path)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`File busy timeout: ${path}`);
    }
    await delay(500);
  }
}

async function waitForExists(path: string, timeoutMs = 30_000) {
  const start = Date.now();
  while (!(await fileExists(path))) {
    if (Date.now() - start > timeoutMs) {
      return false;
    }
    await delay(300);
  }
  return true;
}

async function handleAutoPacOrderSawCsv(path: string) {
  const cfg = loadConfig();
  const grundnerRoot = cfg.paths.grundnerFolderPath?.trim() ?? '';
  if (!grundnerRoot) {
    logger.warn({ file: path }, 'watcher: order_saw received but grundner folder not configured');
    return;
  }
  if (!existsSync(grundnerRoot)) {
    logger.warn({ file: path, grundnerRoot }, 'watcher: order_saw received but grundner folder does not exist');
    return;
  }

  try {
    await waitForStableFile(path);

    const raw = await readFile(path, 'utf8');
    const items = parseOrderSawChangeCsv(raw);
    if (items.length === 0) {
      logger.warn({ file: path }, 'watcher: order_saw file had no valid rows');
      return;
    }

    const changeCsvName = 'ChangeMachNr.csv';
    const outCsv = join(grundnerRoot, changeCsvName);
    const outTmp = join(grundnerRoot, 'ChangeMachNr.tmp');
    const outErl = join(grundnerRoot, 'ChangeMachNr.erl');

    // Clear any stale confirmation file
    try { await fsp.unlink(outErl); } catch { /* ignore */ }

    // Ensure we don't overwrite an in-flight request
    await waitForSlot(outCsv).catch((err) => {
      throw new Error(`ChangeMachNr busy: ${(err as Error).message}`);
    });
    await waitForSlot(outTmp).catch((err) => {
      throw new Error(`ChangeMachNr busy: ${(err as Error).message}`);
    });

    // Build canonical CSV content: base;machine;
    const csvLines =
      items
        .map((it) => `${it.base};${it.machineId};`)
        .join('\r\n') +
      '\r\n';

    // Atomic write: tmp then rename
    await fsp.writeFile(outTmp, csvLines, 'utf8');
    await fsp.rename(outTmp, outCsv).catch(async () => {
      await fsp.writeFile(outCsv, csvLines, 'utf8');
    });

    // Wait for confirmation
    const cfg = loadConfig();
    const erlTimeoutMs = cfg.test?.disableErlTimeouts ? Number.POSITIVE_INFINITY : 30_000;
    const confirmed = await waitForExists(outErl, erlTimeoutMs);
    if (!confirmed) {
      logger.warn({ outErl, file: path }, 'watcher: ChangeMachNr.erl not received');
      return;
    }

    await waitForStableFile(outErl);
    const erlRaw = await readFile(outErl, 'utf8');
    const norm = (s: string) => s.replace(/\r\n/g, '\n').trim();
    const ok = norm(erlRaw) === norm(csvLines);

    // Always archive the reply file to avoid stale confirmations.
    // This also makes testing easier: you can inspect archived replies later.
    let archivedAs: string | null = null;
    const archiveRes = await archiveGrundnerReplyFile({ grundnerFolder: grundnerRoot, sourcePath: outErl });
    if (archiveRes.ok) {
      archivedAs = archiveRes.archivedPath;
    } else {
      try { await fsp.unlink(outErl); } catch { /* ignore */ }
    }

    if (cfg.test?.disableErlTimeouts && archivedAs) {
      emitAppMessage(
        ok ? 'grundner.erl.archived' : 'grundner.erl.mismatch',
        {
          fileName: 'ChangeMachNr.erl',
          archivedAs,
          note: ok ? 'Reply matched request.' : 'Reply did not match request.'
        },
        'grundner'
      );
    }

    if (!ok) {
      logger.warn({ file: path }, 'watcher: ChangeMachNr.erl does not match request');
      return;
    }

    // Update lifecycle: STAGED -> RUNNING (per job)
    for (const it of items) {
      const job = await findJobByNcBasePreferStatus(it.base, ['STAGED']);
      if (!job) {
        logger.warn({ base: it.base, file: path }, 'watcher: order_saw change could not find job');
        continue;
      }
      const result = await updateLifecycle(job.key, 'RUNNING', {
        machineId: it.machineId,
        source: 'autopac-order-saw',
        payload: { source: path, dest: outCsv }
      });
      if (!result.ok && result.reason !== 'NO_CHANGE') {
        logger.warn({ jobKey: job.key, reason: result.reason }, 'watcher: failed to update lifecycle to RUNNING');
      }
    }

    // Clean up source CSV after processing
    await unlinkWithRetry(path);
  } catch (err) {
    recordWatcherError(AUTOPAC_WATCHER_NAME, err, { path, label: AUTOPAC_WATCHER_LABEL });
    logger.error({ err, file: path }, 'watcher: order_saw ChangeMachNr processing failed');
  }
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
  let sourceNpt: string | null = null;
  if (await fileExists(preferredDir)) {
    sourceNpt = await findMatchingNpt(preferredDir, baseLower, 0, 2);
  }
  if (!sourceNpt) {
    sourceNpt = await findMatchingNpt(apRoot, baseLower, 0, 2);
  }
  if (!sourceNpt) {
    logger.warn({ job: job.key, apRoot, leaf }, 'watcher: staged NPT not found for nestpick forwarding');
    return;
  }

  try {
    await waitForStableFile(sourceNpt);
    const raw = await readFile(sourceNpt, 'utf8');
    const normalized = normalizeNestpickText(raw);
    const hash = createHash('sha1').update(normalized).digest('hex');

    const outDir = resolvedMachine.nestpickFolder;
    await ensureDir(outDir);
    const outPath = join(outDir, NESTPICK_FILENAME);
    await waitForNestpickSlot(outPath);

    const tempPath = `${outPath}.tmp-${Date.now()}`;
    await fsp.writeFile(tempPath, raw, 'utf8');
    await rename(tempPath, outPath);

    lastNestpickOutboundByMachine.set(resolvedMachine.machineId, {
      jobKey: job.key,
      base,
      hash,
      normalizedContent: normalized,
      writtenAt: Date.now()
    });

    // Do NOT advance lifecycle here.
    // We only set FORWARDED_TO_NESTPICK after receiving a matching Nestpick.erl acknowledgement.
    await appendJobEvent(
      job.key,
      'nestpick:sent',
      { source: sourceNpt, dest: outPath },
      resolvedMachine.machineId
    );

    clearMachineHealthIssue(resolvedMachine.machineId ?? null, HEALTH_CODES.copyFailure);
  } catch (err) {
    setMachineHealthIssue({
      machineId: resolvedMachine?.machineId ?? null,
      code: HEALTH_CODES.copyFailure,
      message: `Failed to send Nestpick payload for ${job?.key ?? base}`,
      severity: 'warning',
      context: {
        jobKey: job?.key,
        sourceNpt,
        destinationFolder: resolvedMachine?.nestpickFolder
      }
    });
    recordWorkerError('nestpick:send', err, {
      jobKey: job.key,
      machineId: resolvedMachine?.machineId,
      sourceNpt,
      destinationFolder: resolvedMachine?.nestpickFolder
    });
    logger.error({ err, job: job.key }, 'watcher: nestpick forward failed');
  }
}

function formatArchiveTimestampDdMmHhMmSs(date = new Date()): string {
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const dd = pad2(date.getDate());
  const mm = pad2(date.getMonth() + 1);
  const hh = pad2(date.getHours());
  const min = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  return `${dd}.${mm}_${hh}.${min}.${ss}`;
}

async function archiveAutoPacCsv(sourcePath: string, autoPacDir: string): Promise<string | null> {
  try {
    const archiveDir = join(autoPacDir, AUTOPAC_ARCHIVE_DIRNAME);
    await ensureDir(archiveDir);

    const stamp = formatArchiveTimestampDdMmHhMmSs();
    const base = basename(sourcePath, extname(sourcePath));
    const ext = extname(sourcePath) || '.csv';
    let candidate = join(archiveDir, `${base}_${stamp}${ext}`);

    // Avoid collisions if multiple files land in the same second.
    for (let i = 1; i <= 25 && (await fileExists(candidate)); i++) {
      candidate = join(archiveDir, `${base}_${stamp}_${i}${ext}`);
    }

    try {
      await rename(sourcePath, candidate);
      return candidate;
    } catch (err) {
      await copyFile(sourcePath, candidate);
      await unlink(sourcePath).catch(() => {});
      logger.debug({ err }, 'watcher: AutoPAC archive rename fallback to copy');
      return candidate;
    }
  } catch (err) {
    logger.warn({ err, file: sourcePath }, 'watcher: failed to archive AutoPAC CSV');
    return null;
  }
}

async function disposeAutoPacCsv(sourcePath: string): Promise<void> {
  const cfg = loadConfig();
  const enabled = !!cfg.paths.autoPacArchiveEnabled;
  const autoPacDir = (cfg.paths.autoPacCsvDir ?? '').trim();

  if (enabled && autoPacDir) {
    const archived = await archiveAutoPacCsv(sourcePath, autoPacDir);
    if (archived) {
      logger.info({ file: sourcePath, archived }, 'watcher: archived AutoPAC CSV');
      return;
    }
  }

  // Fallback (default behavior): delete.
  await unlinkWithRetry(sourcePath);
  logger.info({ file: sourcePath }, 'watcher: deleted AutoPAC CSV');
}

async function handleAutoPacCsv(path: string) {
  const fileName = basename(path);
  // Enforce naming:
  // - load_finish<machine>.csv
  // - label_finish<machine>.csv
  // - cnc_finish<machine>.csv
  // - order_saw<machine>.csv  (AutoPAC worklist "send order saw" request)
  const lower = fileName.toLowerCase();
  if (!lower.endsWith('.csv')) {
    logger.debug({ file: path }, 'watcher: ignoring non-CSV AutoPAC file');
    return;
  }

  if (lower.startsWith('order_saw')) {
    await handleAutoPacOrderSawCsv(path);
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

    const preview = raw
      .split(/\r?\n/)
      .slice(0, 10)
      .map((line) => line.slice(0, 200))
      .join('\n');

    const expected =
      "Expected a .csv file with comma or semicolon delimiters, at least 2 columns per row, the machine token from the filename present somewhere in the CSV, and the NC base in column 1 (with or without .nc). Spaces are allowed in the base name.";

    const reportFormatError = async (params: { reason: string; found: string }) => {
      const message =
        `File: ${fileName}\n` +
        `Machine token: ${machineToken}\n\n` +
        `Reason: ${params.reason}\n\n` +
        `Expected: ${expected}\n\n` +
        `Found: ${params.found}\n\n` +
        `CSV Preview:\n${preview}`;

      // Modal dialog (immediate operator feedback)
      postMessageToMain({
        type: 'userAlert',
        title: 'AutoPAC CSV Format Error',
        message
      });

      // Messages page (red box, persistent)
      emitAppMessage(
        'autopac.csv.format_error',
        {
          message
        },
        'autopac'
      );

      // This is a file-format error, not a watcher connectivity issue.
      // Record a watcher *event* (not error) so we don't trigger Watcher Offline.
      recordWatcherEvent(AUTOPAC_WATCHER_NAME, {
        label: AUTOPAC_WATCHER_LABEL,
        message: `Rejected ${fileName}: ${params.reason} (found: ${params.found})`,
        context: {
          file: path,
          fileName,
          machineToken,
          reason: params.reason,
          expected,
          found: params.found,
          preview
        }
      });

      await disposeAutoPacCsv(path);
      autoPacHashes.delete(path);
    };

    // Validate CSV format before parsing
    const lines = raw.split(/\r?\n/).filter(line => line.trim().length > 0);
    if (lines.length === 0) {
      logger.warn({ file: path, machineToken }, 'watcher: autopac CSV file is empty');
      await reportFormatError({
        reason: 'File is empty',
        found: '0 non-empty lines'
      });
      return;
    }

    // Check if CSV has proper delimiter (comma or semicolon)
    const hasDelimiters = lines.some(line => line.includes(',') || line.includes(';'));
    if (!hasDelimiters) {
      logger.warn({ file: path, machineToken, lineCount: lines.length, sampleLine: lines[0]?.slice(0, 100) }, 'watcher: autopac CSV has no delimiters (comma or semicolon)');
      await reportFormatError({
        reason: 'No delimiters found',
        found: `No ',' or ';' found in any of ${lines.length} line(s)`
      });
      return;
    }

    const rows = parseCsvContent(raw);

    // Validate parsed rows have multiple columns
    const validRows = rows.filter(row => row.length > 1);
    if (validRows.length === 0) {
      logger.warn({ file: path, machineToken, totalRows: rows.length, sampleRow: rows[0] }, 'watcher: autopac CSV has no multi-column rows');
      await reportFormatError({
        reason: 'No multi-column rows',
        found: `Parsed ${rows.length} row(s), but all rows had 0 or 1 column`
      });
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
      await reportFormatError({
        reason: 'Machine token mismatch',
        found: `Filename expects '${machineToken}', but CSV does not contain a matching token`
      });
      setMachineHealthIssue({
        machineId: null,
        code: HEALTH_CODES.copyFailure,
        message: `AutoPAC machine mismatch: file=${fileName} expects '${machineToken}', CSV does not contain matching machine`,
        severity: 'warning',
        context: { file: path, expected: machineToken }
      });
      return;
    }
    // Strict: first column is NC, only accept base or base.nc
    const bases = (() => {
      const set = new Set<string>();
      for (const row of rows) {
        if (!row.length) continue;
        const cell = row[0]?.trim() ?? '';
        if (!cell) continue;
        // Allow spaces in the base name. AutoPAC sometimes outputs names like "JOB 123".
        // We still keep it conservative: only letters/numbers/underscore/dot/hyphen/space.
        const m = cell.match(/^([A-Za-z0-9_. -]+?)(?:\.nc)?$/i);
        if (m && m[1]) set.add(m[1].trim());
      }
      return Array.from(set);
    })();
    if (!bases.length) {
      logger.warn({ file: path, machineToken, rowCount: rows.length, sampleFirstColumn: rows.slice(0, 3).map(r => r[0]) }, 'watcher: autopac file had no identifiable bases');
      await reportFormatError({
        reason: 'No identifiable bases found in column 1',
        found: `First column values did not match base or base.nc (allowed chars: A-Z a-z 0-9 _ . -)`
      });
      setMachineHealthIssue({
        machineId: null,
        code: HEALTH_CODES.noParts,
        message: `No parts found in AutoPAC CSV ${basename(path)}`,
        severity: 'warning',
        context: { file: path }
      });
      return;
    }

    const machines = await listMachines();
    // Resolve machine strictly from filename token (matches by name or numeric id)
    const wanted = sanitizeToken(machineToken);
    const machine = machines.find((m) => sanitizeToken(m.name) === wanted || sanitizeToken(String(m.machineId)) === wanted);
    if (!machine) {
      logger.warn({ file: path, machineToken }, 'watcher: autopac file specifies unknown machine');
      await reportFormatError({
        reason: 'Unknown machine token',
        found: `No configured machine matched token '${machineToken}' (from filename ${fileName})`
      });
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
        let shouldUseNestpick = false;

        if (machineForJob.nestpickEnabled) {
          const pcIp = (machineForJob.pcIp ?? '').trim();
          if (!pcIp) {
            // If we can't map telemetry rows to this machine, treat Nestpick mode as OFF.
            // This avoids jobs getting stuck waiting for Nestpick when we have no live signal.
            logger.warn({ machineId: machineForJob.machineId }, 'watcher: nestpick mode check skipped (machine pcIp missing)');
          } else {
            const latest = await getLatestNestpickEnabledForPcIp(pcIp);
            shouldUseNestpick = latest.enabled === true;
            logger.debug(
              {
                machineId: machineForJob.machineId,
                pcIp,
                nestpickEnabledTelemetry: latest.enabled,
                lastSeenAt: latest.lastSeenAt
              },
              'watcher: resolved nestpick mode from telemetry'
            );
          }
        }

        if (machineForJob.nestpickEnabled && shouldUseNestpick) {
          // Nestpick-capable machine + operator has Nestpick mode ON for this run.
          await forwardToNestpick(base, job, machineForJob, machines);
        } else {
          // Either not Nestpick-capable, or Nestpick mode is OFF for this run.
          // Treat CNC_FINISH as completion and archive now.
          // Keep existing UX behavior:
          // - Non-Nestpick machines use the "cnc.completion" message.
          // - Nestpick-capable machines already emit the "status.cnc_finish" message above.
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
          }

          logger.info(
            {
              jobKey: job.key,
              status: 'CNC_FINISH',
              folder: job.folder,
              nestpickCapable: machineForJob.nestpickEnabled,
              nestpickMode: shouldUseNestpick
            },
            'watcher: archiving completed job'
          );
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
      // Archive/delete the source CSV after successful processing
      try {
        await disposeAutoPacCsv(path);
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

// Archive queue with backoff to avoid losing files when shares are unavailable
const archiveQueue: Array<{
  source: string;
  archiveDir: string;
  watcherName: string;
  watcherLabel: string;
  machineId: number | null;
  attempts: number;
}> = [];
let archiveQueueRunning = false;

function enqueueArchiveTask(task: {
  source: string;
  archiveDir: string;
  watcherName: string;
  watcherLabel: string;
  machineId: number | null;
  attempts?: number;
}) {
  archiveQueue.push({ ...task, attempts: task.attempts ?? 0 });
  void processArchiveQueue();
}

async function processArchiveQueue() {
  if (archiveQueueRunning || shuttingDown) return;
  archiveQueueRunning = true;
  try {
    while (archiveQueue.length && !shuttingDown) {
      const task = archiveQueue.shift()!;
      const backoffMs = Math.min(30_000, task.attempts === 0 ? 0 : Math.pow(2, task.attempts) * 1000);
      if (backoffMs > 0) {
        await delay(backoffMs);
      }
      try {
        await moveToArchive(task.source, task.archiveDir);
        clearMachineHealthIssue(task.machineId, HEALTH_CODES.copyFailure);
        recordWatcherEvent(task.watcherName, {
          label: task.watcherLabel,
          message: `Archived ${basename(task.source)}${task.attempts ? ' after retry' : ''}`
        });
      } catch (err) {
        const attempts = task.attempts + 1;
        setMachineHealthIssue({
          machineId: task.machineId,
          code: HEALTH_CODES.copyFailure,
          message: `Archive failed for ${basename(task.source)} (attempt ${attempts})`,
          severity: 'warning',
          context: { file: task.source, archiveDir: task.archiveDir, attempts }
        });
        recordWatcherError(task.watcherName, err, {
          path: task.source,
          archiveDir: task.archiveDir,
          label: task.watcherLabel,
          attempts
        });
        archiveQueue.push({ ...task, attempts });
      }
    }
  } finally {
    archiveQueueRunning = false;
  }
}

async function handleNestpickAck(machine: Machine, path: string) {
  try {
    await waitForStableFile(path);
    const raw = await readFile(path, 'utf8');
    const normalized = normalizeNestpickText(raw);
    const hash = createHash('sha1').update(normalized).digest('hex');

    const outbound = lastNestpickOutboundByMachine.get(machine.machineId);
    let matchesOutbound = outbound?.hash === hash;

    // Fallback: if the app restarted and we lost in-memory state, attempt to
    // compare against the current Nestpick.csv content (if it still exists).
    if (!matchesOutbound) {
      const csvPath = join(machine.nestpickFolder, NESTPICK_FILENAME);
      if (await fileExists(csvPath)) {
        await waitForStableFile(csvPath);
        const csvRaw = await readFile(csvPath, 'utf8');
        const csvHash = createHash('sha1').update(normalizeNestpickText(csvRaw)).digest('hex');
        matchesOutbound = csvHash === hash;
      }
    }

    if (!matchesOutbound) {
      setMachineHealthIssue({
        machineId: machine.machineId ?? null,
        code: HEALTH_CODES.copyFailure,
        message: `Nestpick.erl did not match last outbound payload (${machineLabel(machine)})`,
        severity: 'warning',
        context: { file: path, machineId: machine.machineId }
      });
      recordWatcherError(nestpickAckWatcherName(machine), new Error('Nestpick.erl mismatch'), {
        path,
        machineId: machine.machineId,
        label: nestpickAckWatcherLabel(machine)
      });
      logger.warn({ file: path, machineId: machine.machineId }, 'watcher: nestpick ack mismatch');
      return;
    }

    const rows = parseCsvContent(raw);
    let bases = extractBases(rows, basename(path));
    if (!bases.length && outbound?.base) {
      bases = [outbound.base];
    }

    let updatedAny = false;
    for (const base of bases) {
      const job = await findJobByNcBasePreferStatus(base, ['CNC_FINISH']);
      if (!job) {
        logger.warn({ base, file: path }, 'watcher: nestpick ack could not find job in CNC_FINISH');
        continue;
      }

      const lifecycle = await updateLifecycle(job.key, 'FORWARDED_TO_NESTPICK', {
        machineId: machine.machineId,
        source: 'nestpick-ack',
        payload: { file: path }
      });

      if (lifecycle.ok || lifecycle.reason === 'NO_CHANGE') {
        updatedAny = true;
      }

      await appendJobEvent(job.key, 'nestpick:ack', { file: path, hash }, machine.machineId);
    }

    // Archive the ack file (best-effort, with retry) so the share stays clean.
    if (await fileExists(path)) {
      enqueueArchiveTask({
        source: path,
        archiveDir: join(machine.nestpickFolder, 'archive'),
        watcherName: nestpickAckWatcherName(machine),
        watcherLabel: nestpickAckWatcherLabel(machine),
        machineId: machine.machineId ?? null
      });
    }

    recordWatcherEvent(nestpickAckWatcherName(machine), {
      label: nestpickAckWatcherLabel(machine),
      message: `Processed ${basename(path)}`
    });

    if (updatedAny) {
      clearMachineHealthIssue(machine.machineId ?? null, HEALTH_CODES.copyFailure);
    }
  } catch (err) {
    setMachineHealthIssue({
      machineId: machine.machineId ?? null,
      code: HEALTH_CODES.copyFailure,
      message: `Failed to process Nestpick ack file ${basename(path)}`,
      severity: 'warning',
      context: { file: path, machineId: machine.machineId }
    });
    recordWatcherError(nestpickAckWatcherName(machine), err, {
      path,
      machineId: machine.machineId,
      label: nestpickAckWatcherLabel(machine)
    });
    logger.error({ err, file: path }, 'watcher: nestpick ack handling failed');
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
      enqueueArchiveTask({
        source: path,
        archiveDir: join(machine.nestpickFolder, 'archive'),
        watcherName: nestpickUnstackWatcherName(machine),
        watcherLabel: nestpickUnstackWatcherLabel(machine),
        machineId: machine.machineId ?? null
      });
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
    // Queue archive with retry to avoid losing files if share is down
    if (await fileExists(path)) {
      enqueueArchiveTask({
        source: path,
        archiveDir,
        watcherName: nestpickUnstackWatcherName(machine),
        watcherLabel: nestpickUnstackWatcherLabel(machine),
        machineId: machine.machineId ?? null
      });
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
    enqueueArchiveTask({
      source: path,
      archiveDir: join(machine.nestpickFolder, 'archive'),
      watcherName: nestpickUnstackWatcherName(machine),
      watcherLabel: nestpickUnstackWatcherLabel(machine),
      machineId: machine.machineId ?? null
    });

    recordWatcherError(nestpickUnstackWatcherName(machine), err, {
      path,
      machineId: machine.machineId,
      label: nestpickUnstackWatcherLabel(machine)
    });
    logger.error({ err, file: path }, 'watcher: nestpick unstack handling failed');
  }
}

type Awaitable<T> = T | Promise<T>;

function stableProcess(
  fn: (path: string) => Awaitable<void>,
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
        Promise.resolve()
          .then(() => fn(normalizedPath))
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
  if (jobsIngestTimer) {
    clearTimeout(jobsIngestTimer);
    jobsIngestTimer = null;
  }
  if (stageSanityTimer) {
    clearTimeout(stageSanityTimer);
    stageSanityTimer = null;
  }
  if (sourceSanityTimer) {
    clearTimeout(sourceSanityTimer);
    sourceSanityTimer = null;
  }
  if (grundnerTimer) {
    clearTimeout(grundnerTimer);
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

  // Stop any backoff retry timers before closing FS watchers.
  for (const ctrl of resilientWatchers) {
    try {
      await ctrl.stop();
    } catch {
      // ignore shutdown failures
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

  const ctrl = createResilientWatcher({
    name: TESTDATA_WATCHER_NAME,
    label: TESTDATA_WATCHER_LABEL,
    targetContext: { folder: normalizedRoot },
    createWatcher: () => {
      const w = chokidar.watch(normalizedRoot, {
        ignoreInitial: true,
        depth: 4
      });
      w.on('add', (file) => processIfMatches(file, 'add'));
      return w;
    },
    onReady: () => {
      void (async () => {
        await buildInitialTestDataIndex(normalizedRoot);
        await processNextTestData();
      })();
    }
  });
  ctrl.start();
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
      if (entry.name.toLowerCase() === AUTOPAC_ARCHIVE_DIRNAME.toLowerCase()) {
        continue;
      }
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

  const ctrl = createResilientWatcher({
    name: AUTOPAC_WATCHER_NAME,
    label: AUTOPAC_WATCHER_LABEL,
    targetContext: { dir },
    createWatcher: () => {
      const w = chokidar.watch(dir, {
        ignoreInitial: true,
        depth: 3,
        ignored: shouldIgnoreAutoPacPath,
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
      });
      w.on('add', onAdd);
      w.on('change', onAdd);
      return w;
    },
    onOfflineOnce: (err) => {
      const code = (err as NodeJS.ErrnoException)?.code;
      setMachineHealthIssue({
        machineId: null,
        code: HEALTH_CODES.copyFailure,
        message: `AutoPAC watcher error${code ? ` (${code})` : ''}`,
        severity: 'critical',
        context: { dir, code }
      });
    },
    onReady: () => {
      clearMachineHealthIssue(null, HEALTH_CODES.copyFailure);
      void (async () => {
        const existing = await collectAutoPacCsvs(dir);
        if (!existing.length) return;
        logger.info({ dir, count: existing.length }, 'AutoPAC watcher: processing existing CSV files on startup');
        for (const file of existing) {
          onAdd(file);
        }
      })();
    },
    onRecovered: () => {
      clearMachineHealthIssue(null, HEALTH_CODES.copyFailure);
    }
  });

  ctrl.start();
  logger.info({ dir }, 'AutoPAC watcher started');
}

async function setupNestpickWatchers() {
  try {
    const machines = await listMachines();
    for (const machine of machines) {
      if (!machine.nestpickEnabled || !machine.nestpickFolder) continue;
      const folder = machine.nestpickFolder;

      // Watch only two explicit files on the Nestpick share:
      // - Nestpick.erl (acknowledgement)
      // - Report_FullNestpickUnstack.csv (completion report)
      const ackPath = join(folder, NESTPICK_ACK_FILENAME);
      const ackWatcherName = nestpickAckWatcherName(machine);
      const ackWatcherLabel = nestpickAckWatcherLabel(machine);
      registerWatcher(ackWatcherName, ackWatcherLabel);

      const handleAck = stableProcess(
        (path) => handleNestpickAck(machine, path),
        500,
        { watcherName: ackWatcherName, watcherLabel: ackWatcherLabel }
      );

      const ackCtrl = createResilientWatcher({
        name: ackWatcherName,
        label: ackWatcherLabel,
        targetContext: { folder: ackPath, machineId: machine.machineId },
        shouldIgnoreError: isBenignChokidarLstatTempError,
        createWatcher: () => {
          const w = chokidar.watch(ackPath, {
            ignoreInitial: true,
            depth: 0,
            disableGlobbing: true,
            ignored: shouldIgnoreShareTempFile,
            awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 250 }
          });
          w.on('add', handleAck);
          w.on('change', handleAck);
          return w;
        },
        onOfflineOnce: (err) => {
          const code = (err as NodeJS.ErrnoException)?.code;
          setMachineHealthIssue({
            machineId: machine.machineId ?? null,
            code: HEALTH_CODES.nestpickShare,
            message: `Nestpick share unreachable${code ? ` (${code})` : ''}`,
            severity: 'critical',
            context: { file: ackPath, machineId: machine.machineId, code }
          });
        },
        onReady: () => {
          clearMachineHealthIssue(machine.machineId ?? null, HEALTH_CODES.nestpickShare);
        },
        onRecovered: () => {
          clearMachineHealthIssue(machine.machineId ?? null, HEALTH_CODES.nestpickShare);
        }
      });
      ackCtrl.start();


      const reportPath = join(folder, NESTPICK_UNSTACK_FILENAME);
      const unstackWatcherName = nestpickUnstackWatcherName(machine);
      const unstackWatcherLabel = nestpickUnstackWatcherLabel(machine);
      registerWatcher(unstackWatcherName, unstackWatcherLabel);
      const handleReport = stableProcess(
        (path) => handleNestpickUnstack(machine, path),
        500,
        { watcherName: unstackWatcherName, watcherLabel: unstackWatcherLabel }
      );

      const reportCtrl = createResilientWatcher({
        name: unstackWatcherName,
        label: unstackWatcherLabel,
        targetContext: { folder: reportPath, machineId: machine.machineId },
        shouldIgnoreError: isBenignChokidarLstatTempError,
        createWatcher: () => {
          const w = chokidar.watch(reportPath, {
            ignoreInitial: true,
            depth: 0,
            disableGlobbing: true,
            ignored: shouldIgnoreShareTempFile,
            awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 250 }
          });
          w.on('add', handleReport);
          w.on('change', handleReport);
          return w;
        },
        onOfflineOnce: (err) => {
          const code = (err as NodeJS.ErrnoException)?.code;
          setMachineHealthIssue({
            machineId: machine.machineId ?? null,
            code: HEALTH_CODES.nestpickShare,
            message: `Nestpick unstack share unreachable${code ? ` (${code})` : ''}`,
            severity: 'critical',
            context: { file: reportPath, machineId: machine.machineId, code }
          });
        },
        onReady: () => {
          clearMachineHealthIssue(machine.machineId ?? null, HEALTH_CODES.nestpickShare);
        },
        onRecovered: () => {
          clearMachineHealthIssue(machine.machineId ?? null, HEALTH_CODES.nestpickShare);
        }
      });
      reportCtrl.start();

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

function parseGrundnerCsv(raw: string): GrundnerCsvRow[] {
  const rows = parseCsvContent(raw);
  if (!rows.length) return [];
  // Grundner stock.csv has no headers; all indices are 0-based.
  // Format (semicolon-delimited):
  //  0 type_data
  //  1 material name
  //  2 length
  //  3 width
  //  4 thickness
  //  5 material number
  //  6 stock
  //  7 stock av
  //  14 reserved stock
  //  15 customer ID
  const out: GrundnerCsvRow[] = [];
  for (const row of rows) {
    const typeData = normalizeNumber(row[0]);
    const materialNameRaw = stripCsvCell(row[1] ?? '');
    const materialName = materialNameRaw ? materialNameRaw : null;
    const materialNumber = normalizeNumber(row[5]);
    const customerIdRaw = stripCsvCell(row[15] ?? '');
    const customerId = customerIdRaw ? customerIdRaw : null;
    const lengthMm = normalizeNumber(row[2]);
    const widthMm = normalizeNumber(row[3]);
    const thicknessMm = normalizeNumber(row[4]);
    const stock = normalizeNumber(row[6]);
    const stockAvailable = normalizeNumber(row[7]);
    const reservedStock = normalizeNumber(row[14]);
    if (typeData == null) continue;
    out.push({
      typeData,
      customerId,
      materialName,
      materialNumber,
      lengthMm,
      widthMm,
      thicknessMm,
      stock,
      stockAvailable,
      reservedStock
    });
  }
  return out;
}

async function collectNcBaseNames(
  root: string
): Promise<{ bases: Set<string>; hadError: boolean; error?: { dir: string; message: string; code?: string } }> {
  const bases = new Set<string>();
  let hadError = false;
  let error: { dir: string; message: string; code?: string } | undefined;
  async function walk(dir: string) {
    let entries: Dirent[] = [] as unknown as Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      hadError = true;
      if (!error) {
        const e = err as NodeJS.ErrnoException;
        error = { dir, message: e?.message ?? String(err), code: e?.code };
      }
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (SKIP_TRAVERSAL_DIRS.has(lower)) {
          continue;
        }
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
  return { bases, hadError, ...(error ? { error } : {}) };
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

      // If a folder is offline, do not hit it every 10 seconds.
      const now = Date.now();
      const folderBackoffKey = `stage-sanity:machine:${machineId}`;
      const folderBackoff = backoffByKey.get(folderBackoffKey);
      if (!shouldAttemptBackoff(folderBackoff, now)) {
        continue;
      }

      const { bases: present, hadError, error } = await collectNcBaseNames(folder);
      // If filesystem traversal failed, skip this machine to avoid false negatives.
      // Also apply backoff so we do not spam logs on dead shares.
      if (hadError) {
        const existing = backoffByKey.get(folderBackoffKey);
        const state = existing ?? getOrCreateBackoff(folderBackoffKey, now);
        const { delayMs, nextRetryAtMs } = scheduleBackoffRetry(state, now);

        const machineLabel = m.name ?? `Machine ${machineId}`;
        const errSuffix = error ? ` (dir=${error.dir}, code=${error.code ?? 'unknown'})` : '';
        logger.warn(
          { machineId, machine: machineLabel, apJobfolder: folder, error },
          'stage-sanity: folder traversal error'
        );

        recordWatcherBackoff(STAGE_SANITY_WATCHER_NAME, {
          label: STAGE_SANITY_WATCHER_LABEL,
          message: `Skipped stage sanity (machine=${machineLabel}, folder=${folder})${errSuffix}. ${buildBackoffStatusMessage({
            delayMs,
            nextRetryAtMs,
            maxDelayReachAtMs: state.maxDelayReachAtMs
          })}`,
          context: { machineId, folder, error, delayMs }
        });
        continue;
      }

      // Folder is readable again.
      clearBackoff(folderBackoffKey);
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
    throw err;
  }
}

function startStageSanityPoller() {
  registerWatcher(STAGE_SANITY_WATCHER_NAME, STAGE_SANITY_WATCHER_LABEL);

  const baseIntervalMs = 10_000;
  const backoffKey = `poller:${STAGE_SANITY_WATCHER_NAME}`;

  const scheduleNext = (delayMs: number) => {
    if (shuttingDown) return;
    if (stageSanityTimer) {
      clearTimeout(stageSanityTimer);
      stageSanityTimer = null;
    }
    stageSanityTimer = setTimeout(() => {
      stageSanityTimer = null;
      void loop();
    }, delayMs);
    if (typeof stageSanityTimer.unref === 'function') stageSanityTimer.unref();
  };

  const loop = async () => {
    if (shuttingDown) return;
    const now = Date.now();
    const hadBackoff = backoffByKey.has(backoffKey);
    try {
      await stageSanityPollOnce();
      if (hadBackoff) {
        recordWatcherEvent(STAGE_SANITY_WATCHER_NAME, { label: STAGE_SANITY_WATCHER_LABEL, message: 'Recovered' });
      }
      clearBackoff(backoffKey);
      scheduleNext(baseIntervalMs);
    } catch (err) {
      const existing = backoffByKey.get(backoffKey);
      const state = existing ?? getOrCreateBackoff(backoffKey, now);
      if (!existing) {
        recordWatcherError(STAGE_SANITY_WATCHER_NAME, err, { label: STAGE_SANITY_WATCHER_LABEL });
      }
      const { delayMs, nextRetryAtMs } = scheduleBackoffRetry(state, now);
      recordWatcherBackoff(STAGE_SANITY_WATCHER_NAME, {
        label: STAGE_SANITY_WATCHER_LABEL,
        message: buildBackoffStatusMessage({
          delayMs,
          nextRetryAtMs,
          maxDelayReachAtMs: state.maxDelayReachAtMs
        }),
        context: { delayMs }
      });
      scheduleNext(delayMs);
    }
  };

  watcherReady(STAGE_SANITY_WATCHER_NAME, STAGE_SANITY_WATCHER_LABEL);
  void loop();
}

async function collectProcessedJobKeys(
  root: string
): Promise<{ keys: Set<string>; hadError: boolean; error?: { dir: string; message: string; code?: string } }> {
  const keys = new Set<string>();
  let hadError = false;
  let error: { dir: string; message: string; code?: string } | undefined;
  async function walk(dir: string) {
    let entries: Dirent[] = [] as unknown as Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      hadError = true;
      if (!error) {
        const e = err as NodeJS.ErrnoException;
        error = { dir, message: e?.message ?? String(err), code: e?.code };
      }
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        const lower = e.name.toLowerCase();
        if (SKIP_TRAVERSAL_DIRS.has(lower)) {
          continue;
        }
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
  return { keys, hadError, ...(error ? { error } : {}) };
}

async function sourceSanityPollOnce() {
  try {
    const cfg = loadConfig();
    const root = cfg.paths.processedJobsRoot?.trim?.() ?? '';
    if (!root || !(await fileExists(root))) return;

    const now = Date.now();
    const rootBackoffKey = 'source-sanity:processedJobsRoot';
    const rootBackoff = backoffByKey.get(rootBackoffKey);
    if (!shouldAttemptBackoff(rootBackoff, now)) {
      return;
    }

    const { keys: presentKeys, hadError, error } = await collectProcessedJobKeys(root);
    if (hadError) {
      const existing = backoffByKey.get(rootBackoffKey);
      const state = existing ?? getOrCreateBackoff(rootBackoffKey, now);
      const { delayMs, nextRetryAtMs } = scheduleBackoffRetry(state, now);
      const errSuffix = error ? ` (dir=${error.dir}, code=${error.code ?? 'unknown'})` : '';
      logger.warn({ processedJobsRoot: root, error }, 'source-sanity: root traversal error');
      recordWatcherBackoff(SOURCE_SANITY_WATCHER_NAME, {
        label: SOURCE_SANITY_WATCHER_LABEL,
        message: `Skipped source sanity (root=${root})${errSuffix}. ${buildBackoffStatusMessage({
          delayMs,
          nextRetryAtMs,
          maxDelayReachAtMs: state.maxDelayReachAtMs
        })}`,
        context: { processedJobsRoot: root, error, delayMs }
      });
      return;
    }

    clearBackoff(rootBackoffKey);
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
    throw err;
  }
}

function startSourceSanityPoller() {
  registerWatcher(SOURCE_SANITY_WATCHER_NAME, SOURCE_SANITY_WATCHER_LABEL);

  const baseIntervalMs = 30_000;
  const backoffKey = `poller:${SOURCE_SANITY_WATCHER_NAME}`;

  const scheduleNext = (delayMs: number) => {
    if (shuttingDown) return;
    if (sourceSanityTimer) {
      clearTimeout(sourceSanityTimer);
      sourceSanityTimer = null;
    }
    sourceSanityTimer = setTimeout(() => {
      sourceSanityTimer = null;
      void loop();
    }, delayMs);
    if (typeof sourceSanityTimer.unref === 'function') sourceSanityTimer.unref();
  };

  const loop = async () => {
    if (shuttingDown) return;
    const now = Date.now();
    const hadBackoff = backoffByKey.has(backoffKey);
    try {
      await sourceSanityPollOnce();
      if (hadBackoff) {
        recordWatcherEvent(SOURCE_SANITY_WATCHER_NAME, { label: SOURCE_SANITY_WATCHER_LABEL, message: 'Recovered' });
      }
      clearBackoff(backoffKey);
      scheduleNext(baseIntervalMs);
    } catch (err) {
      const existing = backoffByKey.get(backoffKey);
      const state = existing ?? getOrCreateBackoff(backoffKey, now);
      if (!existing) {
        recordWatcherError(SOURCE_SANITY_WATCHER_NAME, err, { label: SOURCE_SANITY_WATCHER_LABEL });
      }
      const { delayMs, nextRetryAtMs } = scheduleBackoffRetry(state, now);
      recordWatcherBackoff(SOURCE_SANITY_WATCHER_NAME, {
        label: SOURCE_SANITY_WATCHER_LABEL,
        message: buildBackoffStatusMessage({
          delayMs,
          nextRetryAtMs,
          maxDelayReachAtMs: state.maxDelayReachAtMs
        }),
        context: { delayMs }
      });
      scheduleNext(delayMs);
    }
  };

  watcherReady(SOURCE_SANITY_WATCHER_NAME, SOURCE_SANITY_WATCHER_LABEL);
  void loop();
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

    // 2) Wait 5 seconds and check for reply
    await delay(5000);
    if (!(await fileExists(stockPath))) {
      recordWatcherEvent(GRUNDNER_WATCHER_NAME, { label: GRUNDNER_WATCHER_LABEL, message: 'Reply missing; will retry' });
      return;
    }
    await waitForStableFile(stockPath);
    if (!(await waitForFileRelease(stockPath))) {
      if (await fileExists(stockPath)) {
        recordWatcherEvent(GRUNDNER_WATCHER_NAME, { label: GRUNDNER_WATCHER_LABEL, message: 'Reply busy; will retry' });
      }
      return;
    }
    await delay(10000);
    if (!(await fileExists(stockPath))) {
      recordWatcherEvent(GRUNDNER_WATCHER_NAME, { label: GRUNDNER_WATCHER_LABEL, message: 'Reply vanished before read; will retry' });
      return;
    }
    let raw = '';
    try {
      raw = await readFile(stockPath, 'utf8');
      recordWatcherEvent(GRUNDNER_WATCHER_NAME, {
        label: GRUNDNER_WATCHER_LABEL,
        message: 'Reply read',
        context: { bytes: raw.length }
      });
    } finally {
      await unlinkWithRetry(stockPath, 3, 2000);
    }
    const hash = createHash('sha1').update(raw).digest('hex');
    if (grundnerLastHash === hash) return;
    grundnerLastHash = hash;
    // Parse Grundner stock.csv rows.
    // Canonical identity is type_data; customer_id is optional display metadata.
    const parsed = parseGrundnerCsv(raw).filter((r) => r.typeData != null);
    if (!parsed.length) return;

    // If multiple rows share a type_data, keep the one with a non-empty customer_id.
    // This prevents "blank" customer IDs from shadowing a real one.
    const itemsByType = new Map<number, GrundnerCsvRow>();
    for (const item of parsed) {
      const typeData = item.typeData as number;
      const existing = itemsByType.get(typeData);
      if (!existing) {
        itemsByType.set(typeData, item);
        continue;
      }
      const existingCustomer = (existing.customerId ?? '').trim();
      const nextCustomer = (item.customerId ?? '').trim();
      if (!existingCustomer && nextCustomer) {
        itemsByType.set(typeData, item);
      }
    }

    const items = Array.from(itemsByType.values());
    const typeDataValues = Array.from(itemsByType.keys());

    // Snapshot previous reserved_stock so we can report meaningful changes.
    const preReserved = new Map<number, number | null>();
    if (typeDataValues.length) {
      try {
        const previousRows = await withClient((c) =>
          c
            .query<{ type_data: number; reserved_stock: number | null }>(
              `SELECT type_data, reserved_stock FROM public.grundner WHERE type_data = ANY($1::int[])`,
              [typeDataValues]
            )
            .then((r) => r.rows)
        );
        for (const row of previousRows) {
          preReserved.set(row.type_data, row.reserved_stock);
        }
      } catch (err) {
        recordWorkerError('grundner:pre-reserved', err);
      }
    }

    const result = await upsertGrundnerInventory(items);
    if (result.inserted > 0 || result.updated > 0 || result.deleted > 0) {
      scheduleRendererRefresh('grundner');
      // Grundner changes are the only live inventory refresh channel.
    }

    if (result.changed.length) {
      const changedTypes = new Set(
        result.changed
          .map((row) => row.typeData)
          .filter((value): value is number => typeof value === 'number')
      );

      for (const [typeData, item] of itemsByType.entries()) {
        if (!changedTypes.has(typeData)) continue;
        const oldReserved = preReserved.has(typeData) ? preReserved.get(typeData) : null;
        const newReserved = item.reservedStock;
        const materialLabel = item.customerId?.trim() || String(typeData);
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
            const reservedValue = row.typeData != null ? itemsByType.get(row.typeData)?.reservedStock ?? null : null;
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
    throw err;
  }
}

function startGrundnerPoller(folder: string) {
  registerWatcher(GRUNDNER_WATCHER_NAME, GRUNDNER_WATCHER_LABEL);
  const baseIntervalMs = 30_000;
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

  const backoffKey = `poller:${GRUNDNER_WATCHER_NAME}`;

  const scheduleNext = (delayMs: number) => {
    if (shuttingDown) return;
    if (grundnerTimer) {
      clearTimeout(grundnerTimer);
      grundnerTimer = null;
    }
    grundnerTimer = setTimeout(() => {
      grundnerTimer = null;
      void loop();
    }, delayMs);
    if (typeof grundnerTimer.unref === 'function') grundnerTimer.unref();
  };

  const loop = async () => {
    if (shuttingDown) return;
    const now = Date.now();
    const hadBackoff = backoffByKey.has(backoffKey);
    try {
      await grundnerPollOnce(normalizedRoot);
      if (hadBackoff) {
        recordWatcherEvent(GRUNDNER_WATCHER_NAME, { label: GRUNDNER_WATCHER_LABEL, message: 'Recovered' });
      }
      clearBackoff(backoffKey);
      scheduleNext(baseIntervalMs);
    } catch (err) {
      const existing = backoffByKey.get(backoffKey);
      const state = existing ?? getOrCreateBackoff(backoffKey, now);
      if (!existing) {
        recordWatcherError(GRUNDNER_WATCHER_NAME, err, { folder: normalizedRoot, label: GRUNDNER_WATCHER_LABEL });
      }
      const { delayMs, nextRetryAtMs } = scheduleBackoffRetry(state, now);
      recordWatcherBackoff(GRUNDNER_WATCHER_NAME, {
        label: GRUNDNER_WATCHER_LABEL,
        message: buildBackoffStatusMessage({
          delayMs,
          nextRetryAtMs,
          maxDelayReachAtMs: state.maxDelayReachAtMs
        }),
        context: { folder: normalizedRoot, delayMs }
      });
      scheduleNext(delayMs);
    }
  };

  watcherReady(GRUNDNER_WATCHER_NAME, GRUNDNER_WATCHER_LABEL);
  void loop();
}

function startJobsIngestPolling() {
  const INGEST_INTERVAL_MS = 5000; // 5 seconds
  const backoffKey = 'poller:jobs-ingest';

  async function runIngestOnce(): Promise<boolean> {
    if (shuttingDown) return true;
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
        return true;
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
        return true;
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
      return true;
    } catch (err) {
      logger.error({ err }, 'Jobs ingest poll failed');
      return false;
    }
  }

  const scheduleNext = (delayMs: number) => {
    if (shuttingDown) return;
    if (jobsIngestTimer) {
      clearTimeout(jobsIngestTimer);
      jobsIngestTimer = null;
    }
    jobsIngestTimer = setTimeout(() => {
      jobsIngestTimer = null;
      void loop();
    }, delayMs);
    if (typeof jobsIngestTimer.unref === 'function') {
      jobsIngestTimer.unref();
    }
  };

  const loop = async () => {
    if (shuttingDown) return;
    const now = Date.now();
    const ok = await runIngestOnce();
    if (ok) {
      clearBackoff(backoffKey);
      scheduleNext(INGEST_INTERVAL_MS);
      return;
    }

    const state = getOrCreateBackoff(backoffKey, now);
    const { delayMs, nextRetryAtMs } = scheduleBackoffRetry(state, now);
    const message = buildBackoffStatusMessage({
      delayMs,
      nextRetryAtMs,
      maxDelayReachAtMs: state.maxDelayReachAtMs
    });
    logger.warn({ nextRetryAt: new Date(nextRetryAtMs).toISOString() }, `jobs-ingest: ${message}`);
    scheduleNext(delayMs);
  };

  // Run immediately on startup and then self-schedule.
  void loop();
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

    // Check if destination already exists - add random suffix
    let finalDest = destination;
    if (existsSync(destination)) {
      const maxAttempts = 200;
      let candidate: string | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const suffix = randomFourDigits();
        const next = join(destRoot, `${folderName}_${suffix}`);
        if (!existsSync(next)) {
          candidate = next;
          break;
        }
      }
      if (!candidate) {
        return { ok: false, error: `Destination collision: unable to allocate unique folder name for ${folderName}` };
      }
      finalDest = candidate;
      logger.warn({ source, destination, finalDest }, 'nccat: destination exists, using random suffix');
    }

    const tryRename = async (): Promise<void> => {
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= 8; attempt++) {
        try {
          await rename(source, finalDest);
          return;
        } catch (err) {
          lastErr = err;
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') {
            throw err;
          }
          await delay(150 * attempt);
        }
      }
      throw lastErr;
    };

    try {
      // Prefer atomic rename.
      await tryRename();
      return { ok: true, newPath: finalDest };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EXDEV' || code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
        // Cross-device or Windows file-lock edge cases: copy then delete.
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
      const ok = await unlinkWithRetry(fullPath, 6, 150);
      if (!ok) {
        throw new Error(`Failed to delete file during folder cleanup: ${fullPath}`);
      }
    }
  }

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await fsp.rmdir(path);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY' && code !== 'ENOTEMPTY') {
        throw err;
      }
      await delay(150 * attempt);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}


const NCCAT_STABILITY_THRESHOLD_MS = 10_000;
const NCCAT_REQUEUE_DELAY_MS = 2_000;

type NcCatJobUnit = {
  kind: 'folder' | 'loose';
  sourcePath: string;
  baseName: string;
  jobsRoot: string;
};

const ncCatQueue: NcCatJobUnit[] = [];
const ncCatQueuedKeys = new Set<string>();
let ncCatQueueActive = false;

function randomFourDigits(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function buildLooseFolderName(baseNoExt: string): string {
  return `${baseNoExt}_${randomFourDigits()}`;
}

function getNcCatQueueKey(unit: NcCatJobUnit): string {
  return `${unit.kind}:${unit.sourcePath}`;
}

async function getLatestMtime(path: string): Promise<number> {
  try {
    const stats = await stat(path);
    if (stats.isFile()) {
      return stats.mtimeMs;
    }
    if (!stats.isDirectory()) return stats.mtimeMs;
    const entries = await readdir(path, { withFileTypes: true });
    let latest = stats.mtimeMs;
    for (const entry of entries) {
      const childPath = join(path, entry.name);
      const childMtime = await getLatestMtime(childPath);
      if (childMtime > latest) latest = childMtime;
    }
    return latest;
  } catch (err) {
    logger.warn({ err, path }, 'nccat: failed to read mtime');
    return Date.now();
  }
}

async function isFolderStable(path: string): Promise<boolean> {
  const latest = await getLatestMtime(path);
  return Date.now() - latest >= NCCAT_STABILITY_THRESHOLD_MS;
}

type NcFileEntry = { path: string; relativeName: string };

async function collectNcFiles(root: string): Promise<NcFileEntry[]> {
  const out: NcFileEntry[] = [];
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        if (extname(entry.name).toLowerCase() === '.nc') {
          const rel = relative(root, fullPath).replace(/\\/g, '/');
          out.push({ path: fullPath, relativeName: rel });
        }
      }
    }
  };
  await walk(root);
  return out;
}

async function moveFileToDestination(
  source: string,
  destRoot: string
): Promise<{ ok: boolean; newPath?: string; error?: string }> {
  try {
    if (!existsSync(destRoot)) {
      mkdirSync(destRoot, { recursive: true });
    }
    const fileName = basename(source);
    let destPath = join(destRoot, fileName);
    if (existsSync(destPath)) {
      const ext = extname(fileName);
      const base = basename(fileName, ext);
      const maxAttempts = 200;
      let candidate: string | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const suffix = randomFourDigits();
        const next = join(destRoot, `${base}_${suffix}${ext}`);
        if (!existsSync(next)) {
          candidate = next;
          break;
        }
      }
      if (!candidate) {
        return { ok: false, error: `Destination collision: unable to allocate unique file name for ${fileName}` };
      }
      destPath = candidate;
      logger.warn({ source, destPath }, 'nccat: destination exists, using random suffix');
    }
    const tryRename = async (): Promise<void> => {
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= 8; attempt++) {
        try {
          await rename(source, destPath);
          return;
        } catch (err) {
          lastErr = err;
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') {
            throw err;
          }
          await delay(150 * attempt);
        }
      }
      throw lastErr;
    };

    try {
      await tryRename();
      return { ok: true, newPath: destPath };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EXDEV' || code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
        await copyFile(source, destPath);
        await unlinkWithRetry(source, 6, 150);
        return { ok: true, newPath: destPath };
      }
      throw err;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

function isMatchingLooseName(filename: string, baseNoExt: string): boolean {
  const base = basename(filename, extname(filename));
  const baseLower = base.toLowerCase();
  const target = baseNoExt.toLowerCase();
  return baseLower === target || baseLower.startsWith(`${target}_`);
}

async function collectLooseCandidates(jobsRoot: string, baseNoExt: string): Promise<string[]> {
  const candidates = new Map<string, { path: string; depth: number }>();
  const dirs = [jobsRoot, join(jobsRoot, baseNoExt)];

  for (const dir of dirs) {
    try {
      if (!existsSync(dir)) continue;
      const stats = await stat(dir);
      if (!stats.isDirectory()) continue;
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!isMatchingLooseName(entry.name, baseNoExt)) continue;
        const fullPath = join(dir, entry.name);
        const rel = relative(jobsRoot, fullPath);
        const depth = rel.split(/[\\/]+/).length;
        const existing = candidates.get(entry.name);
        if (!existing || depth < existing.depth) {
          candidates.set(entry.name, { path: fullPath, depth });
        }
      }
    } catch (err) {
      logger.warn({ err, dir }, 'nccat: failed to scan loose candidates');
    }
  }

  return Array.from(candidates.values()).map((entry) => entry.path);
}

async function gatherLooseJobFiles(jobsRoot: string, baseNoExt: string, ncFilePath: string): Promise<{
  files: string[];
  ncFiles: string[];
}> {
  const allFiles = await collectLooseCandidates(jobsRoot, baseNoExt);
  const fileSet = new Set(allFiles.map((p) => normalize(p)));
  if (!fileSet.has(normalize(ncFilePath))) {
    allFiles.unshift(ncFilePath);
    fileSet.add(normalize(ncFilePath));
  }
  const ncFiles = allFiles.filter((filePath) => extname(filePath).toLowerCase() === '.nc');
  return { files: allFiles, ncFiles };
}

function findMachineNameSuffix(name: string, machines: Machine[]): string | null {
  const lower = name.toLowerCase();
  for (const machine of machines) {
    const suffix = `_${machine.name}`.toLowerCase();
    if (lower.endsWith(suffix)) {
      return machine.name;
    }
  }
  return null;
}

function buildValidationSummaryText(report: NcCatValidationReport): string {
  const lines: string[] = [];
  lines.push(`Folder: ${report.folderName}`);
  lines.push(`Status: ${report.overallStatus}`);
  lines.push(`Processed: ${report.processedAt}`);
  if (report.profileName) {
    lines.push(`Profile: ${report.profileName}`);
  }
  lines.push('');

  for (const file of report.files) {
    lines.push(`File: ${file.filename}`);
    lines.push(`Status: ${file.status}`);
    if (file.errors.length) {
      lines.push('Errors:');
      for (const err of file.errors) {
        lines.push(`- ${err}`);
      }
    }
    if (file.warnings.length) {
      lines.push('Warnings:');
      for (const warn of file.warnings) {
        lines.push(`- ${warn}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function writeValidationSummary(folderPath: string, report: NcCatValidationReport): Promise<void> {
  const summaryPath = join(folderPath, 'validation_summary.txt');
  try {
    await fsp.writeFile(summaryPath, buildValidationSummaryText(report), 'utf8');
  } catch (err) {
    logger.warn({ err, summaryPath }, 'nccat: failed to write validation summary');
  }
}

function getNcCatJobUnit(ncFilePath: string, jobsRoot: string): NcCatJobUnit | null {
  const normalizedRoot = normalize(jobsRoot);
  const normalizedFile = normalize(ncFilePath);
  const rel = relative(normalizedRoot, normalizedFile);
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) {
    return null;
  }
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  if (segments.length <= 1) {
    const baseNoExt = basename(normalizedFile, extname(normalizedFile));
    return {
      kind: 'loose',
      sourcePath: normalizedFile,
      baseName: baseNoExt,
      jobsRoot: normalizedRoot
    };
  }
  const folderName = segments[0];
  const folderPath = join(normalizedRoot, folderName);
  return {
    kind: 'folder',
    sourcePath: folderPath,
    baseName: folderName,
    jobsRoot: normalizedRoot
  };
}

async function processNcCatJobUnit(unit: NcCatJobUnit) {
  const cfg = loadConfig();
  const processedJobsRoot = cfg.paths.processedJobsRoot;
  const quarantineRoot = cfg.paths.quarantineRoot;

  if (!processedJobsRoot) {
    logger.warn({ unit }, 'nccat: processedJobsRoot not configured, skipping');
    return;
  }

  const machines = await listMachines();

  if (unit.kind === 'folder') {
    const jobFolder = normalize(unit.sourcePath);
    if (!existsSync(jobFolder)) {
      logger.warn({ jobFolder }, 'nccat: job folder missing, skipping');

      return;
    }

    const folderName = basename(jobFolder);
    const machineNameHint = findMachineNameSuffix(folderName, machines);

    if (!(await isFolderStable(jobFolder))) {
      logger.info({ folderName }, 'nccat: folder not stable yet, requeueing');
      setTimeout(() => enqueueNcCatJobUnit(unit), NCCAT_REQUEUE_DELAY_MS);
      return;
    }

    const ncFiles = await collectNcFiles(jobFolder);
    if (!ncFiles.length) {
      logger.warn({ jobFolder }, 'nccat: no .nc files found, skipping');
      return;
    }

    recordWatcherEvent(NCCAT_WATCHER_NAME, {
      label: NCCAT_WATCHER_LABEL,
      message: `Validating: ${folderName}`,
      context: { folderName, ncFiles: ncFiles.length }
    });

    const fileInputs = await Promise.all(
      ncFiles.map(async (file) => ({
        filename: file.relativeName,
        ncContent: await readFile(file.path, 'utf8')
      }))
    );

    const validationResult = await requestNcCatHeadlessValidation({
      reason: 'ingest',
      folderName,
      files: fileInputs,
      machineNameHint
    });

    if (!validationResult.ok) {
      if (validationResult.skipped) {
        emitAppMessage(
          'ncCat.validationSkipped',
          { folderName, reason: validationResult.reason ?? 'Validation skipped' },
          'nc-cat-watcher'
        );
      } else {
        emitAppMessage(
          'ncCat.validationUnavailable',
          { folderName, error: validationResult.error ?? 'Validation failed' },
          'nc-cat-watcher'
        );
      }
    }

    const report =
      validationResult.ok
        ? buildNcCatValidationReport({
            reason: 'ingest',
            folderName,
            profileName: validationResult.profileName ?? null,
            results: validationResult.results
          })
        : null;
    const shouldQuarantine = report?.overallStatus === 'errors';

    if (shouldQuarantine) {
      if (!quarantineRoot) {
        logger.warn({ folderName }, 'nccat: quarantineRoot not configured; leaving job in place');
        return;
      }
      const moveResult = await moveFolderToDestination(jobFolder, quarantineRoot);
      if (!moveResult.ok) {
        recordWatcherError(NCCAT_WATCHER_NAME, new Error(moveResult.error ?? 'Move failed'), {
          label: NCCAT_WATCHER_LABEL,
          folderName,
          jobFolder
        });
        return;
      }
      if (report) {
        await writeValidationSummary(moveResult.newPath ?? jobFolder, report);
        postMessageToMain({ type: 'ncCatValidationReport', report });
      }
      emitAppMessage(
        'ncCat.jobQuarantined',
        { folderName, destination: moveResult.newPath, reason: 'validation_errors' },
        'nc-cat-watcher'
      );
      return;
    }

    const moveResult = await moveFolderToDestination(jobFolder, processedJobsRoot);
    if (!moveResult.ok) {
      recordWatcherError(NCCAT_WATCHER_NAME, new Error(moveResult.error ?? 'Move failed'), {
        label: NCCAT_WATCHER_LABEL,
        folderName,
        jobFolder
      });
      return;
    }

    if (report) {
      postMessageToMain({ type: 'ncCatValidationReport', report });
    }

    emitAppMessage(
      'ncCat.jobMoved',
      { folderName, destination: moveResult.newPath },
      'nc-cat-watcher'
    );

    try {
      const ingestResult = await ingestProcessedJobsRoot();
      logger.info({ inserted: ingestResult.inserted, updated: ingestResult.updated }, 'nccat: triggered ingest after move');
      if (validationResult.ok) {
        await upsertNcStatsFromHeadlessResults(folderName, validationResult.results);
      }
    } catch (ingestErr) {
      logger.warn({ err: ingestErr }, 'nccat: ingest failed after move');
    }
    return;
  }

  const ncFilePath = normalize(unit.sourcePath);
  if (!existsSync(ncFilePath)) {
    logger.warn({ ncFilePath }, 'nccat: loose NC file missing, skipping');
    return;
  }

  const baseNoExt = unit.baseName;
  const machineNameHint = findMachineNameSuffix(baseNoExt, machines);

  const looseFolderName = (() => {
    const rootsToCheck = [processedJobsRoot, quarantineRoot].filter((root): root is string => !!root);
    const maxAttempts = 200;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const name = buildLooseFolderName(baseNoExt);
      const hasCollision = rootsToCheck.some((root) => existsSync(join(root, name)));
      if (!hasCollision) return name;
    }
    logger.error({ baseNoExt, rootsToCheck }, 'nccat: unable to allocate unique loose folder name');
    return null;
  })();

  if (!looseFolderName) {
    return;
  }

  const gathered = await gatherLooseJobFiles(unit.jobsRoot, baseNoExt, ncFilePath);
  if (!gathered.files.length) {
    logger.warn({ ncFilePath }, 'nccat: no loose files found for NC file');
    return;
  }

  const latestMtime = await Promise.all(gathered.files.map((file) => getLatestMtime(file)));
  if (latestMtime.some((mtime) => Date.now() - mtime < NCCAT_STABILITY_THRESHOLD_MS)) {
    logger.info({ baseNoExt }, 'nccat: loose files not stable yet, requeueing');
    setTimeout(() => enqueueNcCatJobUnit(unit), NCCAT_REQUEUE_DELAY_MS);
    return;
  }

  const ncFiles = gathered.ncFiles;
  if (!ncFiles.length) {
    logger.warn({ ncFilePath }, 'nccat: no .nc files found for loose job');
    return;
  }

  const validationInputs = await Promise.all(
    ncFiles.map(async (file) => ({
      filename: basename(file),
      ncContent: await readFile(file, 'utf8')
    }))
  );

  const validationResult = await requestNcCatHeadlessValidation({
    reason: 'ingest',
    folderName: looseFolderName,
    files: validationInputs,
    machineNameHint
  });

  if (!validationResult.ok) {
    if (validationResult.skipped) {
      emitAppMessage(
        'ncCat.validationSkipped',
        { folderName: looseFolderName, reason: validationResult.reason ?? 'Validation skipped' },
        'nc-cat-watcher'
      );
    } else {
      emitAppMessage(
        'ncCat.validationUnavailable',
        { folderName: looseFolderName, error: validationResult.error ?? 'Validation failed' },
        'nc-cat-watcher'
      );
    }
  }

  const report =
    validationResult.ok
      ? buildNcCatValidationReport({
          reason: 'ingest',
          folderName: looseFolderName,
          profileName: validationResult.profileName ?? null,
          results: validationResult.results
        })
      : null;
  const shouldQuarantine = report?.overallStatus === 'errors';
  const destinationRoot = shouldQuarantine ? quarantineRoot : processedJobsRoot;

  if (!destinationRoot) {
    logger.warn({ looseFolderName }, 'nccat: destination root missing; skipping move');
    return;
  }

  const destinationFolder = join(destinationRoot, looseFolderName);
  if (!existsSync(destinationFolder)) {
    mkdirSync(destinationFolder, { recursive: true });
  }

  let moveFailure = false;
  for (const filePath of gathered.files) {
    const moveResult = await moveFileToDestination(filePath, destinationFolder);
    if (!moveResult.ok) {
      moveFailure = true;
      recordWatcherError(NCCAT_WATCHER_NAME, new Error(moveResult.error ?? 'Move failed'), {
        label: NCCAT_WATCHER_LABEL,
        source: filePath,
        destination: destinationFolder
      });
    }
  }

  if (moveFailure) {
    return;
  }

  if (report) {
    postMessageToMain({ type: 'ncCatValidationReport', report });
  }

  if (shouldQuarantine) {
    if (report) {
      await writeValidationSummary(destinationFolder, report);
    }
    emitAppMessage(
      'ncCat.jobQuarantined',
      { folderName: looseFolderName, destination: destinationFolder, reason: 'validation_errors' },
      'nc-cat-watcher'
    );
    return;
  }

  emitAppMessage(
    'ncCat.jobMoved',
    { folderName: looseFolderName, destination: destinationFolder },
    'nc-cat-watcher'
  );

  try {
    const ingestResult = await ingestProcessedJobsRoot();
    logger.info({ inserted: ingestResult.inserted, updated: ingestResult.updated }, 'nccat: triggered ingest after move');
    if (validationResult.ok) {
      await upsertNcStatsFromHeadlessResults(looseFolderName, validationResult.results);
    }
  } catch (ingestErr) {
    logger.warn({ err: ingestErr }, 'nccat: ingest failed after move');
  }
}

function enqueueNcCatJobUnit(unit: NcCatJobUnit) {
  const key = getNcCatQueueKey(unit);
  if (ncCatQueuedKeys.has(key)) return;
  ncCatQueuedKeys.add(key);
  ncCatQueue.push(unit);
  void processNcCatQueue();
}

function buildJobKeyFromNcCatFolder(folderName: string, filename: string): string {
  const normalized = filename.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/').filter(Boolean);
  const base = segments.pop() ?? normalized;
  const baseNoExt = basename(base, extname(base)) || base;
  const dir = segments.length ? `${segments.join('/')}/` : '';
  return `${folderName}/${dir}${baseNoExt}`.slice(0, 100);
}

async function upsertNcStatsFromHeadlessResults(folderName: string, results: NcCatHeadlessValidationFileResult[]): Promise<void> {
  for (const file of results) {
    // Only store stats for jobs with no errors. Warnings are allowed.
    if (file.validation.status === 'errors') continue;
    if (!file.stats) continue;

    const jobKey = buildJobKeyFromNcCatFolder(folderName, file.filename);
    const stats = file.stats;

    try {
      await upsertNcStats({
        jobKey,
        ncEstRuntime: Number.isFinite(stats.ncEstRuntime) ? Math.round(stats.ncEstRuntime) : null,
        yieldPercentage: Number.isFinite(stats.yieldPercentage) ? stats.yieldPercentage : null,
        wasteOffcutM2: Number.isFinite(stats.wasteOffcutM2) ? stats.wasteOffcutM2 : null,
        wasteOffcutDustM3: Number.isFinite(stats.wasteOffcutDustM3) ? stats.wasteOffcutDustM3 : null,
        totalToolDustM3: Number.isFinite(stats.TotalToolDustM3) ? stats.TotalToolDustM3 : null,
        totalDrillDustM3: Number.isFinite(stats.TotalDrillDustM3) ? stats.TotalDrillDustM3 : null,
        sheetTotalDustM3: Number.isFinite(stats.SheetTotalDustM3) ? stats.SheetTotalDustM3 : null,
        cuttingDistanceMeters: Number.isFinite(stats.cuttingDistanceMeters) ? stats.cuttingDistanceMeters : null,
        usableOffcuts: stats.usableOffcuts ?? [],
        toolUsage: stats.toolUsage ?? [],
        drillUsage: stats.drillUsage ?? [],
        validation: file.validation as ValidationResult,
        nestPick: null,
        mesOutputVersion: null
      });
    } catch (err) {
      logger.warn({ err, jobKey, folderName }, 'nccat: failed to upsert nc_stats from headless stats');
    }
  }
}

async function processNcCatQueue() {
  if (ncCatQueueActive) return;
  ncCatQueueActive = true;
  while (ncCatQueue.length > 0) {
    const unit = ncCatQueue.shift();
    if (!unit) continue;
    ncCatQueuedKeys.delete(getNcCatQueueKey(unit));
    try {
      await processNcCatJobUnit(unit);
    } catch (err) {
      recordWatcherError(NCCAT_WATCHER_NAME, err, { label: NCCAT_WATCHER_LABEL });
      logger.error({ err, unit }, 'nccat: failed to process job unit');
    }
  }
  ncCatQueueActive = false;
}

function enqueueNcCatJobFile(ncFilePath: string, jobsRoot: string) {
  const unit = getNcCatJobUnit(ncFilePath, jobsRoot);
  if (!unit) {
    logger.debug({ ncFilePath }, 'nccat: ignored file outside jobsRoot');
    return;
  }
  enqueueNcCatJobUnit(unit);
}

function setupNcCatJobsWatcher(dir: string) {
  registerWatcher(NCCAT_WATCHER_NAME, NCCAT_WATCHER_LABEL);

  const onAdd = stableProcess((path: string) => enqueueNcCatJobFile(path, dir), 2000, {
    watcherName: NCCAT_WATCHER_NAME,
    watcherLabel: NCCAT_WATCHER_LABEL
  });


  const ctrl = createResilientWatcher({
    name: NCCAT_WATCHER_NAME,
    label: NCCAT_WATCHER_LABEL,
    targetContext: { dir },
    createWatcher: () => {
      const w = chokidar.watch(dir, {
        ignoreInitial: false, // Process existing files on startup
        depth: 10, // Allow deeper nesting under jobsRoot
        awaitWriteFinish: {
          stabilityThreshold: 2000, // Wait 2 seconds for file to stabilize
          pollInterval: 250
        }
      });
      // Only trigger for .nc files
      w.on('add', (path) => {
        if (path.toLowerCase().endsWith('.nc')) {
          onAdd(path);
        }
      });
      return w;
    },
    onOfflineOnce: (err) => {
      const code = (err as NodeJS.ErrnoException)?.code;
      setMachineHealthIssue({
        machineId: null,
        code: HEALTH_CODES.copyFailure,
        message: `NC Cat jobs watcher error${code ? ` (${code})` : ''}`,
        severity: 'critical',
        context: { dir, code }
      });
    },
    onReady: () => {
      clearMachineHealthIssue(null, HEALTH_CODES.copyFailure);
      logger.info({ dir }, 'nccat: jobs watcher ready');
    },
    onRecovered: () => {
      clearMachineHealthIssue(null, HEALTH_CODES.copyFailure);
    }
  });

  ctrl.start();
  logger.info({ dir }, 'nccat: jobs watcher started');
}

// ---------------------------------------------------------------------------------

async function initWatchers() {
  logger.info('watchers: waiting for database readiness before starting');
  await waitForDbReady();
  await ensureJobStatusEnumHasRunning();
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
    } else if (message.type === 'ncCatValidationResponse') {
      const pending = ncCatValidationPending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      ncCatValidationPending.delete(message.requestId);
      pending.resolve(message.result);
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
