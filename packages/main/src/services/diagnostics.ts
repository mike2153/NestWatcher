import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import { promises as fsp } from 'fs';
import type { Stats } from 'fs';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import type {
  CopyDiagnosticsLog,
  DiagnosticsLogSummary,
  DiagnosticsLogTailRes,
  DiagnosticsSnapshot,
  MachineHealthCode,
  MachineHealthEntry,
  WatcherStatus,
  WorkerErrorEntry
} from '../../../shared/src';

import { getDbStatus } from './dbWatchdog';
import { getLogDirectory, listLogFiles, logger } from '../logger';

type InternalWatcherStatus = WatcherStatus;

const emitter = new EventEmitter();
const watchers = new Map<string, InternalWatcherStatus>();
const MAX_ERRORS = 200;
const DEFAULT_COPY_LOGS = 3;
const DEFAULT_COPY_LINES = 200;

let recentErrors: WorkerErrorEntry[] = [];
let storePath: string | null = null;
let initialized = false;
const machineHealth = new Map<string, MachineHealthEntry>();

// Live log tailers (push updates)
type LogListener = (lines: string[]) => void;
type Tailer = {
  file: string;
  timer: NodeJS.Timeout | null;
  lastSize: number;
  buf: string; // carry partial line across reads
  listeners: Set<LogListener>;
};

const tailers = new Map<string, Tailer>();

function emitLogLines(file: string, lines: string[]) {
  const t = tailers.get(file);
  if (!t || lines.length === 0) return;
  for (const fn of t.listeners) {
    try { fn(lines); } catch { /* noop */ void 0; }
  }
}

async function pollTailer(t: Tailer) {
  try {
    const stats = await fsp.stat(t.file);
    const size = stats.size;
    if (size < t.lastSize) {
      // rotation or truncate
      t.lastSize = 0;
      t.buf = '';
    }
    if (size > t.lastSize) {
      const fd = await fsp.open(t.file, 'r');
      try {
        const toRead = size - t.lastSize;
        const buffer = Buffer.allocUnsafe(Math.min(toRead, 1024 * 1024)); // cap read chunk
        let offset = t.lastSize;
        let remaining = toRead;
        let acc = '';
        while (remaining > 0) {
          const len = Math.min(buffer.length, remaining);
          const { bytesRead } = await fd.read({ buffer, position: offset, length: len });
          if (bytesRead <= 0) break;
          acc += buffer.subarray(0, bytesRead).toString('utf8');
          offset += bytesRead;
          remaining -= bytesRead;
        }
        t.lastSize = size;
        const combined = t.buf + acc;
        const parts = combined.split(/\r?\n/);
        t.buf = parts.pop() ?? '';
        const lines = parts.filter((s) => s.length > 0);
        if (lines.length) emitLogLines(t.file, lines);
      } finally {
        await fd.close();
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      try { logger.warn({ err, file: t.file }, 'diagnostics: log tailer poll failed'); } catch { /* noop */ void 0; }
    }
  }
}

function startTailer(file: string) {
  let t = tailers.get(file);
  if (!t) {
    t = { file, timer: null, lastSize: 0, buf: '', listeners: new Set() };
    tailers.set(file, t);
  }
  if (!t.timer) {
    // Initialize lastSize to current file size to only stream new lines
    fsp.stat(file).then((st) => { t!.lastSize = st.size; }).catch(() => { t!.lastSize = 0; });
    const id = setInterval(() => { void pollTailer(t!); }, 1000);
    if (typeof id.unref === 'function') id.unref();
    t.timer = id;
  }
  return t;
}

function stopTailerIfIdle(file: string) {
  const t = tailers.get(file);
  if (!t) return;
  if (t.listeners.size === 0) {
    if (t.timer) {
      clearInterval(t.timer);
      t.timer = null;
    }
    tailers.delete(file);
  }
}

export function subscribeLogStream(file: string, listener: (lines: string[]) => void): () => void {
  const t = startTailer(file);
  t.listeners.add(listener);
  return () => {
    t.listeners.delete(listener);
    stopTailerIfIdle(file);
  };
}

function emitUpdate() {
  emitter.emit('update');
}

function makeHealthKey(machineId: number | null, code: MachineHealthCode) {
  return `${machineId ?? 'global'}:${code}`;
}

function sortMachineHealthEntries(entries: MachineHealthEntry[]) {
  const severityWeight = { critical: 3, warning: 2, info: 1 } as const;
  return entries.sort((a, b) => {
    const severityDelta = severityWeight[b.severity] - severityWeight[a.severity];
    if (severityDelta !== 0) return severityDelta;
    if (a.machineId == null && b.machineId != null) return 1;
    if (a.machineId != null && b.machineId == null) return -1;
    if (a.machineId != null && b.machineId != null && a.machineId !== b.machineId) {
      return a.machineId - b.machineId;
    }
    return b.lastUpdatedAt.localeCompare(a.lastUpdatedAt);
  });
}

function getMachineHealthEntries(): MachineHealthEntry[] {
  return sortMachineHealthEntries(Array.from(machineHealth.values()));
}

function ensureWatcher(name: string, label?: string): InternalWatcherStatus {
  const existing = watchers.get(name);
  if (existing) {
    if (label && existing.label !== label) existing.label = label;
    return existing;
  }
  const created: InternalWatcherStatus = {
    name,
    label: label ?? name,
    status: 'idle',
    lastEventAt: null,
    lastEvent: null,
    lastErrorAt: null,
    lastError: null
  };
  watchers.set(name, created);
  return created;
}

async function loadExistingErrors() {
  if (!storePath) return;
  try {
    const raw = await fsp.readFile(storePath, 'utf8');
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-MAX_ERRORS);
    const parsed: WorkerErrorEntry[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as WorkerErrorEntry;
        if (entry && typeof entry.id === 'string' && typeof entry.timestamp === 'string') {
          parsed.push({
            id: entry.id,
            source: entry.source,
            message: entry.message,
            timestamp: entry.timestamp,
            stack: entry.stack ?? undefined,
            context: entry.context
          });
        }
      } catch (err) {
        logger.warn({ err, line }, 'diagnostics: failed to parse stored error entry');
      }
    }
    parsed.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    recentErrors = parsed.slice(0, MAX_ERRORS);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      await fsp.writeFile(storePath, '');
    } else {
      logger.warn({ err }, 'diagnostics: failed to read worker error log');
    }
  }
}

export async function initializeDiagnostics(customDir?: string) {
  if (initialized) return;
  initialized = true;
  try {
    const base = customDir ?? (app.isReady() ? app.getPath('userData') : process.cwd());
    storePath = join(base, 'worker-errors.jsonl');
    await fsp.mkdir(dirname(storePath), { recursive: true });
    await loadExistingErrors();
  } catch (err) {
    logger.warn({ err }, 'diagnostics: failed to initialize persistent error store');
    storePath = null;
  }
}

export async function clearRecentErrors(): Promise<void> {
  recentErrors = [];
  if (storePath) {
    try {
      // Truncate the persisted worker error file so errors stay cleared after restart.
      await fsp.writeFile(storePath, '');
    } catch (err) {
      logger.warn({ err, storePath }, 'diagnostics: failed to clear worker error store');
    }
  }
  emitUpdate();
}

function serializeErrorEntry(entry: WorkerErrorEntry) {
  return JSON.stringify(entry) + '\n';
}

function toMessage(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack ?? undefined };
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

export function watcherReady(name: string, label?: string) {
  const watcher = ensureWatcher(name, label);
  watcher.status = 'watching';
  try {
    const lbl = watcher.label ?? name;
    logger.debug({ watcher: name, label: lbl }, `watcher: ready - ${lbl}`);
  } catch { /* noop */ void 0; }
  emitUpdate();
}

export function recordWatcherEvent(
  name: string,
  info?: { label?: string; message?: string; context?: unknown }
) {
  const watcher = ensureWatcher(name, info?.label);
  watcher.status = 'watching';
  watcher.lastEventAt = new Date().toISOString();
  watcher.lastEvent = info?.message ?? null;
  try {
    const lbl = watcher.label ?? name;
    const msg = info?.message ?? 'event';
    logger.info({ watcher: name, label: lbl, context: info?.context }, `watcher:event - ${lbl}: ${msg}`);
  } catch { /* noop */ void 0; }
  emitUpdate();
}

export function recordWatcherError(
  name: string,
  error: unknown,
  context?: Record<string, unknown> & { label?: string }
) {
  const { label, ...rest } = context ?? {};
  const watcher = ensureWatcher(name, label as string | undefined);
  const { message } = toMessage(error);
  watcher.status = 'error';
  watcher.lastErrorAt = new Date().toISOString();
  watcher.lastError = message;
  try {
    const lbl = watcher.label ?? name;
    logger.error({ watcher: name, label: lbl, err: error, context: rest }, `watcher:error - ${lbl}: ${message}`);
  } catch { /* noop */ void 0; }
  recordWorkerError(name, error, rest);
}

export function getDiagnosticsSnapshot(): DiagnosticsSnapshot {
  return {
    dbStatus: getDbStatus(),
    watchers: Array.from(watchers.values()).sort((a, b) => a.label.localeCompare(b.label)),
    recentErrors: recentErrors.slice(0, 50),
    machineHealth: getMachineHealthEntries(),
    lastUpdatedAt: new Date().toISOString()
  };
}

export function subscribeDiagnostics(listener: (snapshot: DiagnosticsSnapshot) => void): () => void {
  const handler = () => listener(getDiagnosticsSnapshot());
  emitter.on('update', handler);
  return () => emitter.off('update', handler);
}

export function registerWatcher(name: string, label: string) {
  const watcher = ensureWatcher(name, label);
  watcher.status = 'idle';
  try {
    logger.debug({ watcher: name, label }, `watcher: register - ${label}`);
  } catch { /* noop */ void 0; }
  emitUpdate();
}

export function recordWorkerError(
  source: string,
  error: unknown,
  context?: Record<string, unknown>
): WorkerErrorEntry {
  const { message, stack } = toMessage(error);
  const entry: WorkerErrorEntry = {
    id: randomUUID(),
    source,
    message,
    timestamp: new Date().toISOString(),
    stack: stack ?? undefined,
    context
  };

  recentErrors = [entry, ...recentErrors].slice(0, MAX_ERRORS);

  if (storePath) {
    fsp.appendFile(storePath, serializeErrorEntry(entry)).catch((err) => {
      logger.warn({ err }, 'diagnostics: failed to append worker error entry');
    });
  }

  emitUpdate();
  return entry;
}

async function readLogTail(path: string, maxLines: number): Promise<{ lines: string[]; total: number }> {
  try {
    const raw = await fsp.readFile(path, "utf8");
    const lines = raw.split(/\r?\n/);
    const filtered = lines.filter((line) => line.length > 0);
    const total = filtered.length;
    if (total <= maxLines) {
      return { lines: filtered, total };
    }
    return { lines: filtered.slice(total - maxLines), total };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message, path }, "diagnostics: failed to read log file");
    return { lines: [`[failed to read ${path}: ${message}]`], total: 0 };
  }
}
async function statsForLog(path: string): Promise<Stats | null> {
  try {
    return await fsp.stat(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn({ err, path }, "diagnostics: failed to stat log file");
    }
    return null;
  }
}

function toLogSummary(file: string, stats: Stats | null): DiagnosticsLogSummary {
  return {
    file,
    name: basename(file),
    size: stats ? stats.size : null,
    updatedAt: stats ? stats.mtime.toISOString() : null
  };
}

function resolveLogFilePath(input: string): string {
  const logDir = getLogDirectory();
  const base = resolve(logDir);
  const candidate = resolve(isAbsolute(input) ? input : join(logDir, input));
  if (!candidate.startsWith(base)) {
    throw new Error("Invalid log file path");
  }
  return candidate;
}

function ensureKnownLog(file: string): string {
  const candidate = resolveLogFilePath(file);
  const allowed = new Set(listLogFiles().map((entry) => resolve(entry)));
  if (!allowed.has(candidate)) {
    throw new Error(`Log file not found: ${file}`);
  }
  return candidate;
}




export async function buildDiagnosticsCopyPayload(options?: {
  maxLogs?: number;
  maxLines?: number;
}): Promise<{ snapshot: DiagnosticsSnapshot; logs: CopyDiagnosticsLog[] }> {
  const limitLogs = Math.max(1, options?.maxLogs ?? DEFAULT_COPY_LOGS);
  const limitLines = Math.max(1, options?.maxLines ?? DEFAULT_COPY_LINES);
  const snapshot = getDiagnosticsSnapshot();
  const files = listLogFiles();
  const selected = files.slice(-limitLogs);
  const logs: CopyDiagnosticsLog[] = [];
  for (const file of selected.reverse()) {
    const stats = await statsForLog(file);
    const { lines, total } = await readLogTail(file, limitLines);
    const summary = toLogSummary(file, stats);
    logs.push({ ...summary, lines, available: total });
  }
  return { snapshot, logs };
}

export async function listDiagnosticsLogs(): Promise<DiagnosticsLogSummary[]> {
  const files = listLogFiles();
  const summaries: DiagnosticsLogSummary[] = [];
  for (const file of files) {
    const stats = await statsForLog(file);
    summaries.push(toLogSummary(file, stats));
  }
  return summaries.sort((a, b) => {
    if (a.updatedAt && b.updatedAt && a.updatedAt !== b.updatedAt) {
      return b.updatedAt.localeCompare(a.updatedAt);
    }
    if (a.size != null && b.size != null && a.size !== b.size) {
      return b.size - a.size;
    }
    return b.name.localeCompare(a.name);
  });
}

export async function getDiagnosticsLogTail(file: string, limit: number): Promise<DiagnosticsLogTailRes> {
  const safeLimit = Math.max(10, Math.min(limit, 2000));
  const target = ensureKnownLog(file);
  const stats = await statsForLog(target);
  const { lines, total } = await readLogTail(target, safeLimit);
  return {
    ...toLogSummary(target, stats),
    lines,
    limit: safeLimit,
    available: total
  };
}

export function setMachineHealthIssue(params: {
  machineId: number | null;
  code: MachineHealthCode;
  message: string;
  severity?: MachineHealthEntry['severity'];
  context?: Record<string, unknown>;
}): MachineHealthEntry {
  const key = makeHealthKey(params.machineId, params.code);
  const previous = machineHealth.get(key);
  const entry: MachineHealthEntry = {
    id: key,
    machineId: params.machineId,
    code: params.code,
    severity: params.severity ?? previous?.severity ?? 'warning',
    message: params.message,
    lastUpdatedAt: new Date().toISOString(),
    context: params.context
      ? { ...(previous?.context ?? {}), ...params.context }
      : previous?.context
  };
  machineHealth.set(key, entry);
  emitUpdate();
  return entry;
}

export function clearMachineHealthIssue(machineId: number | null, code: MachineHealthCode) {
  const key = makeHealthKey(machineId, code);
  if (machineHealth.delete(key)) {
    emitUpdate();
  }
}

// getMachineHealthSummary was unused; prefer getMachineHealthEntries()




