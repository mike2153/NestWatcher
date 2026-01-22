import { existsSync } from 'fs';
import { join } from 'path';
import { BrowserWindow, dialog } from 'electron';
import { Worker } from 'worker_threads';
import { logger } from '../logger';
import { pushAppMessage } from './messages';
import { runHeadlessValidationWithRetry } from './ncCatHeadless';
import { broadcastNcCatValidationReport, persistNcCatValidationReport } from './ncCatValidationResults';
import {
  registerWatcher,
  watcherReady,
  recordWatcherEvent,
  recordWatcherError,
  recordWorkerError,
  setMachineHealthIssue,
  clearMachineHealthIssue
} from './diagnostics';
import type {
  WatcherWorkerToMainMessage,
  MainToWatcherMessage,
  SerializableError
} from '../workers/watchersMessages';

let worker: Worker | null = null;
let shuttingDown = false;
let restartTimer: NodeJS.Timeout | null = null;

type StartupWatcherState = {
  name: string;
  label: string;
  status: 'idle' | 'watching' | 'error';
  lastError?: string;
};

let startupMode = false;
let startupLogged = false;
let startupTimer: NodeJS.Timeout | null = null;
let startupDebounceTimer: NodeJS.Timeout | null = null;
let startupStartedAt = 0;
const startupWatchers = new Map<string, StartupWatcherState>();
const STARTUP_DEBOUNCE_MS = 250;
const STARTUP_TIMEOUT_MS = 15_000;

function clearStartupTimers() {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (startupDebounceTimer) {
    clearTimeout(startupDebounceTimer);
    startupDebounceTimer = null;
  }
}

function endStartupMode() {
  startupMode = false;
  startupLogged = false;
  startupStartedAt = 0;
  startupWatchers.clear();
  clearStartupTimers();
}

function scheduleStartupEvaluation() {
  if (!startupMode) return;
  if (!startupStartedAt) {
    startupStartedAt = Date.now();
    startupTimer = setTimeout(() => {
      if (!startupMode || startupLogged) return;

      const idle = Array.from(startupWatchers.values()).filter((w) => w.status === 'idle');
      const errors = Array.from(startupWatchers.values()).filter((w) => w.status === 'error');
      const watching = Array.from(startupWatchers.values()).filter((w) => w.status === 'watching');

      if (idle.length === 0 && errors.length === 0 && watching.length > 0) {
        logger.info({ watcherCount: watching.length }, 'All Watchers Ready');
        startupLogged = true;
        endStartupMode();
        return;
      }

      logger.warn(
        {
          watcherCount: startupWatchers.size,
          ready: watching.length,
          idle: idle.length,
          errors: errors.length
        },
        'Watchers not ready'
      );

      for (const w of errors) {
        logger.warn({ watcher: w.name, label: w.label }, `Watcher ${w.label} error: ${w.lastError ?? 'unknown error'}`);
      }
      for (const w of idle) {
        logger.warn({ watcher: w.name, label: w.label }, `Watcher ${w.label} not ready: no ready signal received`);
      }

      startupLogged = true;
      // Stop suppressing watcher thread logs after timeout so we can troubleshoot.
      startupMode = false;
      clearStartupTimers();
    }, STARTUP_TIMEOUT_MS);
    if (typeof startupTimer.unref === 'function') startupTimer.unref();
  }

  if (startupDebounceTimer) clearTimeout(startupDebounceTimer);
  startupDebounceTimer = setTimeout(() => {
    if (!startupMode || startupLogged) return;

    const idle = Array.from(startupWatchers.values()).filter((w) => w.status === 'idle');
    const errors = Array.from(startupWatchers.values()).filter((w) => w.status === 'error');
    const watching = Array.from(startupWatchers.values()).filter((w) => w.status === 'watching');

    if (idle.length === 0 && errors.length === 0 && watching.length > 0) {
      logger.info({ watcherCount: watching.length }, 'All Watchers Ready');
      startupLogged = true;
      endStartupMode();
    }
  }, STARTUP_DEBOUNCE_MS);
  if (typeof startupDebounceTimer.unref === 'function') startupDebounceTimer.unref();
}

function resolveWorkerPath() {
  const override = process.env.WOODTRON_WATCHERS_WORKER_PATH?.trim();
  if (override) {
    return override;
  }
  const candidates = [
    join(__dirname, 'workers', 'watchersWorker.js'),
    join(__dirname, '..', 'dist', 'workers', 'watchersWorker.js'),
    join(__dirname, '..', 'workers', 'watchersWorker.js')
  ];
  const existing = candidates.find((candidate) => existsSync(candidate));
  return existing ?? candidates[0];
}

function toError(serialized: SerializableError): Error {
  const err = new Error(serialized.message);
  if (serialized.stack) {
    err.stack = serialized.stack;
  }
  return err;
}

function handleWorkerMessage(message: WatcherWorkerToMainMessage) {
  switch (message.type) {
    case 'log': {
      if (startupMode && message.level === 'info') {
        break;
      }
      const base = { ...message.context, proc: 'Watchers' };
      const m = String(message.msg ?? '');
      switch (message.level) {
        case 'trace':
          logger.trace(base, m);
          break;
        case 'debug':
          logger.debug(base, m);
          break;
        case 'info':
          logger.info(base, m);
          break;
        case 'warn':
          logger.warn(base, m);
          break;
        case 'error':
          logger.error(base, m);
          break;
        case 'fatal':
          logger.fatal(base, m);
          break;
        default:
          logger.info(base, m);
      }
      break;
    }
    case 'registerWatcher':
      if (startupMode) {
        startupWatchers.set(message.name, { name: message.name, label: message.label, status: 'idle' });
        scheduleStartupEvaluation();
      }
      registerWatcher(message.name, message.label);
      break;
    case 'watcherReady':
      if (startupMode) {
        const existing = startupWatchers.get(message.name);
        startupWatchers.set(message.name, {
          name: message.name,
          label: message.label ?? existing?.label ?? message.name,
          status: 'watching'
        });
        scheduleStartupEvaluation();
      }
      watcherReady(message.name, message.label ?? message.name);
      break;
    case 'watcherEvent':
      if (startupMode) {
        const existing = startupWatchers.get(message.name);
        startupWatchers.set(message.name, {
          name: message.name,
          label: message.label ?? existing?.label ?? message.name,
          status: 'watching'
        });
        scheduleStartupEvaluation();
      }
      recordWatcherEvent(message.name, {
        label: message.label ?? message.name,
        message: message.message,
        context: message.context
      });
      break;
    case 'watcherError': {
      if (startupMode) {
        const existing = startupWatchers.get(message.name);
        startupWatchers.set(message.name, {
          name: message.name,
          label: message.label ?? existing?.label ?? message.name,
          status: 'error',
          lastError: message.error.message
        });
        scheduleStartupEvaluation();
      }
      const context = {
        ...(message.context ?? {}),
        label: message.label ?? message.name
      };
      const offlinePath =
        (message.context as { folder?: string; dir?: string; path?: string } | undefined)?.folder ??
        (message.context as { dir?: string; path?: string } | undefined)?.dir ??
        (message.context as { path?: string } | undefined)?.path;
      if (offlinePath) {
        pushAppMessage(
          'watcher.offline',
          {
            watcherName: message.label ?? message.name,
            path: offlinePath
          },
          { source: 'watchers' }
        );
      }
      recordWatcherError(message.name, toError(message.error), context);
      break;
    }
    case 'userAlert': {
      const { title, message: body } = message;
      void dialog.showMessageBox({ type: 'warning', title, message: body, buttons: ['OK'], defaultId: 0 });
      break;
    }
    case 'workerError':
      recordWorkerError(message.source, toError(message.error), message.context);
      break;
    case 'machineHealthSet':
      setMachineHealthIssue(message.payload);
      break;
    case 'machineHealthClear':
      clearMachineHealthIssue(message.payload.machineId, message.payload.code);
      break;
    case 'dbNotify': {
      const channelName =
        message.channel === 'grundner' ? 'grundner:refresh' : 'allocatedMaterial:refresh';
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          if (!win.isDestroyed()) {
            win.webContents.send(channelName);
          }
        } catch (err) {
          logger.warn({ err, channel: channelName }, 'watchers: failed to broadcast dbNotify');
        }
      }
      break;
    }
    case 'appAlert': {
      const error = new Error(message.summary);
      recordWorkerError(`app-alert:${message.category}`, error, message.details);
      break;
    }
    case 'appMessage': {
      const entry = pushAppMessage(message.event, message.params, {
        source: message.source,
        timestamp: message.timestamp
      });
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          if (!win.isDestroyed()) {
            win.webContents.send('messages:append', entry);
          }
        } catch (err) {
          logger.warn({ err }, 'watchers: failed to push app message to renderer');
        }
      }
      break;
    }
    case 'ncCatValidationReport': {
      void persistNcCatValidationReport(message.report);
      broadcastNcCatValidationReport(message.report);
      break;
    }
    case 'ncCatValidationRequest': {
      void handleNcCatValidationRequest(message.requestId, message.payload);
      break;
    }
    default:
      logger.warn({ message }, 'watchers: received unknown worker message');    
  }
}

async function handleNcCatValidationRequest(
  requestId: string,
  payload: {
    reason: 'ingest' | 'stage';
    folderName: string;
    files: { filename: string; ncContent: string }[];
    machineNameHint?: string | null;
    machineId?: number | null;
  }
) {
  const outcome = await runHeadlessValidationWithRetry({
    reason: payload.reason,
    folderName: payload.folderName,
    files: payload.files,
    machineNameHint: payload.machineNameHint ?? null,
    machineId: payload.machineId ?? null
  });

  const response: MainToWatcherMessage = {
    type: 'ncCatValidationResponse',
    requestId,
    result: (() => {
      if (outcome.ok) {
        return {
          ok: true,
          results: outcome.results,
          profileId: outcome.profileId ?? null,
          profileName: outcome.profileName ?? null
        };
      }

      if ('error' in outcome) {
        return { ok: false, error: outcome.error };
      }

      return { ok: false, skipped: true, reason: outcome.reason };
    })()
  };

  try {
    worker?.postMessage(response);
  } catch (err) {
    logger.warn({ err, requestId }, 'watchers: failed to respond to NC-Cat validation request');
  }
}

function scheduleRestart() {
  if (restartTimer || shuttingDown) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    logger.info('watchers: restarting worker after unexpected exit');
    spawnWorker();
  }, 2_000);
  if (typeof restartTimer.unref === 'function') {
    restartTimer.unref();
  }
}

function spawnWorker() {
  try {
    const script = resolveWorkerPath();
    const instance = new Worker(script);
    const threadId = instance.threadId;
    worker = instance;
    startupMode = true;
    startupLogged = false;
    startupStartedAt = 0;
    startupWatchers.clear();
    clearStartupTimers();
    instance.on('message', handleWorkerMessage);
    instance.on('error', (err) => {
      recordWorkerError('watchers-worker', err);
      logger.error({ err, threadId }, 'watchers: worker thread error');
    });
    instance.on('exit', (code) => {
      worker = null;
      if (shuttingDown) {
        logger.info({ code, threadId }, 'watchers: worker thread exited during shutdown');
        return;
      }
      if (code !== 0) {
        const err = new Error(`Watchers worker exited with code ${code}`);
        recordWorkerError('watchers-worker', err);
        logger.error({ code, threadId }, 'watchers: worker exited unexpectedly');
        scheduleRestart();
      }
    });
    logger.info({ threadId }, 'watchers: worker thread started');
  } catch (err) {
    recordWorkerError('watchers-worker', err);
    logger.error({ err }, 'watchers: failed to start worker thread');
  }
}

export function initWatchers() {
  if (worker || shuttingDown) {
    return;
  }
  spawnWorker();
}

export async function shutdownWatchers(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  const current = worker;
  if (!current) {
    logger.info('watchers: shutdown requested with no active worker');
    return;
  }
  const threadId = current.threadId;
  worker = null;

  logger.info({ threadId }, 'watchers: shutdown requested; stopping worker thread');

  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      logger.info({ threadId }, 'watchers: shutdown complete; worker thread destroyed');
      resolve();
    };

    const timeout = setTimeout(() => {
      logger.warn({ threadId }, 'watchers: shutdown timeout; forcing worker termination');
      current.terminate().then(finish, finish);
    }, 5_000);

    current.once('exit', (code) => {
      logger.info({ code, threadId }, 'watchers: worker exit observed during shutdown');
      clearTimeout(timeout);
      finish();
    });

    try {
      const message: MainToWatcherMessage = { type: 'shutdown', reason: 'app-quit' };
      logger.info({ threadId, message }, 'watchers: posting shutdown to worker');
      current.postMessage(message);
    } catch (err) {
      recordWorkerError('watchers-worker', err);
      logger.warn({ err, threadId }, 'watchers: failed to post shutdown; forcing termination');
      clearTimeout(timeout);
      current.terminate().then(finish, finish);
    }
  });
}

export async function restartWatchers(): Promise<{ ok: boolean; error?: string }> {
  try {
    logger.info('watchers: manual restart requested');

    // Gracefully shutdown current worker if running
    const current = worker;
    if (current) {
      worker = null;

      await new Promise<void>((resolve) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          resolve();
        };

        const timeout = setTimeout(() => {
          logger.warn('watchers: restart shutdown timeout, forcing termination');
          current.terminate().then(finish, finish);
        }, 3_000);

        current.once('exit', () => {
          clearTimeout(timeout);
          finish();
        });

        try {
          const message: MainToWatcherMessage = { type: 'shutdown', reason: 'manual-restart' };
          current.postMessage(message);
        } catch (err) {
          logger.warn({ err }, 'watchers: error during restart shutdown');
          clearTimeout(timeout);
          current.terminate().then(finish, finish);
        }
      });
    }

    // Clear restart timer if any
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }

    // Small delay to ensure clean shutdown
    await new Promise(resolve => setTimeout(resolve, 500));

    // Spawn new worker
    spawnWorker();

    logger.info('watchers: manual restart completed');
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ err }, 'watchers: manual restart failed');
    recordWorkerError('watchers-restart', err);
    return { ok: false, error: message };
  }
}
