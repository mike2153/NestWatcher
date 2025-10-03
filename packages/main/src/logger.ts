import { app } from 'electron';
import { createWriteStream, existsSync, mkdirSync, readdirSync, unlinkSync, type WriteStream } from 'fs';
import { join } from 'path';
import { Writable } from 'stream';
import pino, { multistream, type Level, type StreamEntry } from 'pino';
import { isMainThread, parentPort } from 'worker_threads';

const FALLBACK_LOG_DIR = join(process.cwd(), 'logs');
const DEFAULT_RETENTION_DAYS = 14;

function resolveLogDirectory(): string {
  const envDir = process.env.WOODTRON_LOG_DIR?.trim();
  if (envDir) return envDir;
  try {
    return join(app.getPath('userData'), 'logs');
  } catch {
    return FALLBACK_LOG_DIR;
  }
}

function resolveRetentionDays(): number {
  const fromEnv = Number.parseInt(process.env.WOODTRON_LOG_RETENTION ?? '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_RETENTION_DAYS;
}

const logDir = resolveLogDirectory();
if (!existsSync(logDir)) {
  mkdirSync(logDir, { recursive: true });
}

const retentionDays = resolveRetentionDays();
const VALID_LEVELS: Level[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];

function resolveLogLevel(): Level {
  const requested = (process.env.LOG_LEVEL ?? '').toLowerCase();
  if (VALID_LEVELS.includes(requested as Level)) {
    return requested as Level;
  }
  return process.env.NODE_ENV === 'development' ? 'debug' : 'info';
}

// Avoid empty catch blocks: provide resilient fallbacks for warnings/logging
function safeWarn(...args: unknown[]) {
  try {
    // eslint-disable-next-line no-console
    console.warn(...args);
  } catch {
    try {
      const text = args.map((a) => (a instanceof Error ? a.stack || a.message : String(a))).join(' ');
      process.stderr.write(`[WARN] ${text}\n`);
    } catch {
      /* noop */
    }
  }
}

function safeLog(...args: unknown[]) {
  try {
    // eslint-disable-next-line no-console
    console.log(...args);
  } catch {
    try {
      const text = args.map((a) => (a instanceof Error ? a.stack || a.message : String(a))).join(' ');
      process.stdout.write(`${text}\n`);
    } catch {
      /* noop */
    }
  }
}

class RotatingFileStream extends Writable {
  private currentDate: string | null = null;
  private stream: WriteStream | null = null;
  private cleanupScheduled = false;
  private pending: Buffer[] = [];
  private opening = false;

  constructor(private readonly directory: string, private readonly retention: number) {
    super();
  }

  private formatDateKey(epochMs: number) {
    const date = new Date(epochMs);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  private scheduleCleanup() {
    if (this.cleanupScheduled) return;
    this.cleanupScheduled = true;
    const timer = setTimeout(() => {
      this.cleanupScheduled = false;
      try {
        const entries = readdirSync(this.directory)
          .filter((name) => name.endsWith('.log'))
          .sort();
        const allowed = Math.max(this.retention, 1);
        if (entries.length > allowed) {
          const excess = entries.slice(0, entries.length - allowed);
          for (const file of excess) {
            try {
              unlinkSync(join(this.directory, file));
            } catch (err) {
              console.warn('logger: failed to prune log file', err);
            }
          }
        }
      } catch (err) {
        safeWarn('logger: failed to enumerate log directory', err);
      }
    }, 1_000);
    if (typeof timer.unref === 'function') timer.unref();
  }

  private attachStreamHandlers(target: WriteStream) {
    target.on('error', (err) => {
      safeWarn('logger: file stream error; attempting reopen', err);
      this.stream = null;
      this.opening = false;
    });
  }

  private openStream(dateKey: string) {
    if (this.opening) return;
    this.opening = true;
    try {
      const destination = join(this.directory, `${dateKey}.log`);
      const s = createWriteStream(destination, { flags: 'a' });
      this.attachStreamHandlers(s);
      this.stream = s;
      this.currentDate = dateKey;
      this.scheduleCleanup();
    } catch (err) {
      safeWarn('logger: failed to open log file', err);
      this.stream = null;
    } finally {
      this.opening = false;
    }
  }

  private rotateIfNeeded(dateKey: string) {
    if (this.currentDate === dateKey && this.stream) return;
    try {
      this.stream?.end();
    } catch (err) {
      safeWarn('logger: failed to close previous log stream', err);
    }
    this.openStream(dateKey);
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    try {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      let time = Date.now();
      let line: string | null = null;
      try {
        const parsed = JSON.parse(buffer.toString('utf8')) as {
          time?: number;
          level?: number;
          msg?: string;
          err?: { message?: string } | unknown;
          pid?: number;
          proc?: string;
          [key: string]: unknown;
        };
        if (typeof parsed?.time === 'number') time = parsed.time;
        const levelMap: Record<number, string> = {
          10: 'TRACE',
          20: 'DEBUG',
          30: 'INFO',
          40: 'WARN',
          50: 'ERROR',
          60: 'FATAL'
        };
        const date = new Date(time);
        const hhmmss = date.toLocaleTimeString('en-GB', { hour12: false });
        const day = String(date.getDate()).padStart(2, '0');
        const mon = date.toLocaleString('en-GB', { month: 'short' });
      const levelLabel = typeof parsed?.level === 'number' ? (levelMap[parsed.level] || 'INFO') : 'INFO';
      const proc = typeof parsed?.proc === 'string' ? parsed.proc : (isMainThread ? 'Main' : 'Watchers');
        const message = parsed?.msg ?? '';
        const e = parsed?.err;
        const errMsg = (e && typeof e === 'object' && 'message' in (e as Record<string, unknown>) && typeof (e as { message?: unknown }).message === 'string')
          ? ` - ${(e as { message: string }).message}`
          : '';
        line = `${levelLabel} ${proc} | ${hhmmss} ${day} ${mon} | ${message}${errMsg}`;
      } catch {
        // Fallback: write raw text if parsing fails
        line = buffer.toString('utf8');
      }
      const dateKey = this.formatDateKey(time);
      this.rotateIfNeeded(dateKey);
      if (!this.stream) {
        this.openStream(dateKey);
      }
      const toWrite = Buffer.from((line ?? '') + (line?.endsWith('\n') ? '' : '\n'), 'utf8');
      const writeOrBuffer = (buf: Buffer) => {
        if (this.stream) {
          const ok = this.stream.write(buf);
          if (!ok) this.stream.once('drain', () => this.flushPending());
        } else {
          this.pending.push(buf);
        }
      };
      writeOrBuffer(toWrite);
      this.flushPending();
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }

  override _final(callback: (error?: Error | null) => void) {
    try {
      this.flushPending();
      if (this.stream) {
        this.stream.end(callback);
      } else {
        callback();
      }
    } catch (err) {
      callback(err as Error);
    }
  }

  private flushPending() {
    if (!this.stream || this.pending.length === 0) return;
    try {
      while (this.pending.length > 0 && this.stream) {
        const buf = this.pending.shift()!;
        const ok = this.stream.write(buf);
        if (!ok) {
          this.stream.once('drain', () => this.flushPending());
          break;
        }
      }
    } catch (err) {
      safeWarn('logger: flush failed', err);
    }
  }
}

const level = resolveLogLevel();

class CleanConsoleStream extends Writable {
  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    try {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      const logEntry = JSON.parse(buffer.toString('utf8')) as {
        level: number;
        time: number;
        msg: string;
        err?: { message?: string };
        proc?: string;
        [key: string]: unknown;
      };

      const levelMap: Record<number, string> = {
        10: 'TRACE',
        20: 'DEBUG',
        30: 'INFO',
        40: 'WARN',
        50: 'ERROR',
        60: 'FATAL'
      };

      const date = new Date(logEntry.time);
      const hhmmss = date.toLocaleTimeString('en-GB', { hour12: false });
      const day = String(date.getDate()).padStart(2, '0');
      const mon = date.toLocaleString('en-GB', { month: 'short' });
      const levelLabel = levelMap[logEntry.level] || 'INFO';
      const proc = typeof logEntry?.proc === 'string' ? logEntry.proc : (isMainThread ? 'Main' : 'Watchers');

      let message = `${proc} | ${hhmmss} ${day} ${mon} | ${logEntry.msg}`;
      if (logEntry.err?.message) {
        message += ` - ${logEntry.err.message}`;
      }
      // Include level prefix for console visibility
      console.log(`${levelLabel} ${message}`);
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }
}

const streams: StreamEntry[] = [
  { stream: new CleanConsoleStream(), level },
  { stream: new RotatingFileStream(logDir, retentionDays), level }
];

// In worker threads, proxy logs to main via parentPort so all logs go through unified writer
function makeWorkerProxyLogger() {
  const post = (lvl: Level, msg: string, context?: Record<string, unknown>) => {
    try {
      parentPort?.postMessage({ type: 'log', level: lvl, msg, context });
    } catch {
      // Fallback if parentPort is missing
      safeLog(`[${lvl.toUpperCase()}] ${msg}`);
    }
  };
  const asCtx = (v: unknown): Record<string, unknown> | undefined =>
    v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  const emit = (lvl: Level, a: unknown, b?: unknown) => {
    if (typeof a === 'string' && typeof b === 'undefined') return post(lvl, a);
    if (typeof b === 'string') return post(lvl, b, asCtx(a));
    return post(lvl, String(b ?? a ?? ''));
  };
  return {
    trace: (a: unknown, b?: unknown) => emit('trace', a, b),
    debug: (a: unknown, b?: unknown) => emit('debug', a, b),
    info: (a: unknown, b?: unknown) => emit('info', a, b),
    warn: (a: unknown, b?: unknown) => emit('warn', a, b),
    error: (a: unknown, b?: unknown) => emit('error', a, b),
    fatal: (a: unknown, b?: unknown) => emit('fatal', a, b)
  } as unknown as ReturnType<typeof pino>;
}

export const logger = isMainThread ? pino({ level }, multistream(streams)) : makeWorkerProxyLogger();

export function getLogDirectory() {
  return logDir;
}

export function listLogFiles(): string[] {
  try {
    return readdirSync(logDir)
      .filter((name) => name.endsWith('.log'))
      .map((name) => join(logDir, name))
      .sort();
  } catch {
    return [];
  }
}
