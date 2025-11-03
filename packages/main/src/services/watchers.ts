import { existsSync } from 'fs';
import { join } from 'path';
import { BrowserWindow, dialog } from 'electron';
import { Worker } from 'worker_threads';
import { logger } from '../logger';
import { pushAppMessage } from './messages';
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
      registerWatcher(message.name, message.label);
      break;
    case 'watcherReady':
      watcherReady(message.name, message.label ?? message.name);
      break;
    case 'watcherEvent':
      recordWatcherEvent(message.name, {
        label: message.label ?? message.name,
        message: message.message,
        context: message.context
      });
      break;
    case 'watcherError': {
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
    default:
      logger.warn({ message }, 'watchers: received unknown worker message');
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
    worker = instance;
    instance.on('message', handleWorkerMessage);
    instance.on('error', (err) => {
      recordWorkerError('watchers-worker', err);
      logger.error({ err }, 'watchers: worker thread error');
    });
    instance.on('exit', (code) => {
      worker = null;
      if (shuttingDown) {
        return;
      }
      if (code !== 0) {
        const err = new Error(`Watchers worker exited with code ${code}`);
        recordWorkerError('watchers-worker', err);
        logger.error({ code }, 'watchers: worker exited unexpectedly');
        scheduleRestart();
      }
    });
    logger.info('watchers: worker thread started');
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
    return;
  }
  worker = null;

  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve();
    };

    const timeout = setTimeout(() => {
      current.terminate().then(finish, finish);
    }, 5_000);

    current.once('exit', () => {
      clearTimeout(timeout);
      finish();
    });

    try {
      const message: MainToWatcherMessage = { type: 'shutdown', reason: 'app-quit' };
      current.postMessage(message);
    } catch (err) {
      recordWorkerError('watchers-worker', err);
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
