import { app } from 'electron';
import { createWriteStream, existsSync, mkdirSync, readdirSync, unlinkSync, type WriteStream } from 'fs';
import { join } from 'path';
import { Writable } from 'stream';
import pino, { multistream, type Level, type StreamEntry } from 'pino';

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

class RotatingFileStream extends Writable {
  private currentDate: string | null = null;
  private stream: WriteStream | null = null;
  private cleanupScheduled = false;

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
        console.warn('logger: failed to enumerate log directory', err);
      }
    }, 1_000);
    if (typeof timer.unref === 'function') timer.unref();
  }

  private rotateIfNeeded(dateKey: string) {
    if (this.currentDate === dateKey && this.stream) return;
    this.stream?.end();
    const destination = join(this.directory, `${dateKey}.log`);
    this.stream = createWriteStream(destination, { flags: 'a' });
    this.currentDate = dateKey;
    this.scheduleCleanup();
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    try {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      let time = Date.now();
      try {
        const parsed = JSON.parse(buffer.toString('utf8')) as { time?: number };
        if (typeof parsed?.time === 'number') time = parsed.time;
      } catch {
        // Ignore parse errors; fall back to current time.
      }
      const dateKey = this.formatDateKey(time);
      this.rotateIfNeeded(dateKey);
      if (!this.stream) throw new Error('logger: rotation stream unavailable');
      if (!this.stream.write(buffer)) {
        this.stream.once('drain', callback);
      } else {
        callback();
      }
    } catch (err) {
      callback(err as Error);
    }
  }

  override _final(callback: (error?: Error | null) => void) {
    if (this.stream) {
      this.stream.end(callback);
    } else {
      callback();
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
        [key: string]: unknown;
      };

      const levelMap: Record<number, string> = {
        10: 'TRACE',
        20: 'DEBUG',
        30: 'INFO',
        40: 'WARNING',
        50: 'ERROR',
        60: 'FATAL'
      };

      const date = new Date(logEntry.time);
      const time = date.toLocaleTimeString('en-GB', { hour12: false });
      const dateStr = date.toLocaleDateString('en-GB');
      const levelLabel = levelMap[logEntry.level] || 'UNKNOWN';

      let message = `${levelLabel} ${time} ${dateStr} ${logEntry.msg}`;

      if (logEntry.err?.message) {
        message += ` - ${logEntry.err.message}`;
      }

      console.log(message);
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

export const logger = pino({ level }, multistream(streams));

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
