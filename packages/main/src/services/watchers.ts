import { existsSync } from 'fs';
import { join } from 'path';
import { BrowserWindow } from 'electron';
import { Worker } from 'worker_threads';
import { logger } from '../logger';
import { pushAppMessage } from './messages';
import { runHeadlessValidationWithRetry } from './ncCatHeadless';
import { broadcastNcCatValidationReport, persistNcCatValidationReport } from './ncCatValidationResults';
import { enqueueDialog } from './dialogQueue';
import {
  registerWatcher,
  watcherReady,
  recordWatcherEvent,
  recordWatcherBackoff,
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

type OfflineEpisodeState = {
  key: string;
  watcherName: string;
  watcherLabel: string;
  path: string;
  offlineSinceMs: number;
  firstNotified: boolean;
  capNotified: boolean;
  recoveredNotified: boolean;
  status: 'offline' | 'recovered';
};

// Track offline episodes so we can show exactly one message per episode,
// plus an additional notification when we enter long retry mode and when we recover.
const offlineEpisodes = new Map<string, OfflineEpisodeState>();

// Popups are helpful, but multiple machines can go offline at once.
// Throttle popups globally so operators do not get spammed.
const OFFLINE_POPUP_THROTTLE_MS = 5000;
let lastOfflinePopupAtMs = 0;

// Backoff cap defined in watchers worker.
// When we hit this delay we enter "long retry" mode.
const OFFLINE_CAP_DELAY_MS = 60_000;
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

function extractOfflinePath(context: unknown): string | null {
  const ctx = context as {
    folder?: unknown;
    dir?: unknown;
    path?: unknown;
    processedJobsRoot?: unknown;
    apJobfolder?: unknown;
  } | null;
  if (!ctx) return null;
  if (typeof ctx.folder === 'string' && ctx.folder.trim()) return ctx.folder;
  if (typeof ctx.dir === 'string' && ctx.dir.trim()) return ctx.dir;
  if (typeof ctx.path === 'string' && ctx.path.trim()) return ctx.path;
  if (typeof ctx.processedJobsRoot === 'string' && ctx.processedJobsRoot.trim()) return ctx.processedJobsRoot;
  if (typeof ctx.apJobfolder === 'string' && ctx.apJobfolder.trim()) return ctx.apJobfolder;
  return null;
}

function shouldShowOfflinePopupNow(): boolean {
  const now = Date.now();
  if (now - lastOfflinePopupAtMs < OFFLINE_POPUP_THROTTLE_MS) {
    return false;
  }
  lastOfflinePopupAtMs = now;
  return true;
}

function ensureOfflineEpisode(params: { name: string; label: string; path: string; nowMs: number }): OfflineEpisodeState {
  const key = `${params.name}|${params.path}`;
  const existing = offlineEpisodes.get(key);
  if (existing && existing.status === 'offline') {
    return existing;
  }
  const next: OfflineEpisodeState = {
    key,
    watcherName: params.name,
    watcherLabel: params.label,
    path: params.path,
    offlineSinceMs: params.nowMs,
    firstNotified: false,
    capNotified: false,
    recoveredNotified: false,
    status: 'offline'
  };
  offlineEpisodes.set(key, next);
  return next;
}

function markWatcherRecovered(name: string, label: string) {
  for (const ep of offlineEpisodes.values()) {
    if (ep.watcherName !== name) continue;
    if (ep.status !== 'offline') continue;

    ep.status = 'recovered';
    if (ep.recoveredNotified) continue;
    ep.recoveredNotified = true;

    pushAppMessage('watcher.recovered', { watcherName: label, path: ep.path }, { source: 'watchers' });

    if (shouldShowOfflinePopupNow()) {
      enqueueDialog({
        type: 'info',
        title: 'Watcher Recovered',
        message: `Watcher ${label} can access ${ep.path} again. Monitoring resumed.`,
        buttons: ['OK'],
        defaultId: 0
      });
    }
  }
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
      // Treat a ready signal as recovery for any offline episode for this watcher.
      markWatcherRecovered(message.name, message.label ?? message.name);
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

      // Some pollers emit a "Recovered" watcherEvent without a corresponding watcherReady.
      // Treat this as recovery for any offline episode.
      if (message.message === 'Recovered') {
        markWatcherRecovered(message.name, message.label ?? message.name);
      }
      break;
    case 'watcherBackoff': {
      if (startupMode) {
        const existing = startupWatchers.get(message.name);
        startupWatchers.set(message.name, {
          name: message.name,
          label: message.label ?? existing?.label ?? message.name,
          status: 'error',
          lastError: message.message
        });
        scheduleStartupEvaluation();
      }

      // Backoff messages are expected and repeated while a folder is offline.
      // They update the watcher status text, but should not create a new worker error entry.
      recordWatcherBackoff(message.name, {
        label: message.label ?? message.name,
        message: message.message,
        context: message.context
      });

      // Use backoff updates to drive "long retry" notifications.
      // The worker includes delayMs in context for resilient watchers.
      {
        const offlinePath = extractOfflinePath(message.context);
        const ctx = message.context as { delayMs?: unknown } | undefined;
        const delayMs = typeof ctx?.delayMs === 'number' ? ctx.delayMs : null;
        if (offlinePath && delayMs != null) {
          const now = Date.now();
          const label = message.label ?? message.name;
          const ep = ensureOfflineEpisode({ name: message.name, label, path: offlinePath, nowMs: now });

          // Some watcher implementations might only emit watcherBackoff events.
          // Ensure we send the first offline notification once.
          if (!ep.firstNotified) {
            ep.firstNotified = true;
            pushAppMessage('watcher.offline', { watcherName: label, path: offlinePath }, { source: 'watchers' });
            if (shouldShowOfflinePopupNow()) {
              enqueueDialog({
                type: 'warning',
                title: 'Watcher Offline',
                message: `Watcher ${label} cannot access ${offlinePath}.\n\nThe app will retry automatically.`,
                buttons: ['OK'],
                defaultId: 0
              });
            }
          }

          if (!ep.capNotified && delayMs >= OFFLINE_CAP_DELAY_MS) {
            ep.capNotified = true;
            pushAppMessage(
              'watcher.offline_long',
              {
                watcherName: label,
                path: offlinePath,
                intervalSeconds: Math.round(OFFLINE_CAP_DELAY_MS / 1000)
              },
              { source: 'watchers' }
            );
            if (shouldShowOfflinePopupNow()) {
              enqueueDialog({
                type: 'warning',
                title: 'Watcher Still Offline',
                message:
                  `Watcher ${label} is still offline for ${offlinePath}.\n\n` +
                  `The app will now retry every ${Math.round(OFFLINE_CAP_DELAY_MS / 1000)} seconds until it recovers.`,
                buttons: ['OK'],
                defaultId: 0
              });
            }
          }
        }
      }
      break;
    }
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
      const offlinePath = extractOfflinePath(message.context);
      if (offlinePath) {
        const now = Date.now();
        const label = message.label ?? message.name;
        const ep = ensureOfflineEpisode({ name: message.name, label, path: offlinePath, nowMs: now });
        if (!ep.firstNotified) {
          ep.firstNotified = true;
          pushAppMessage('watcher.offline', { watcherName: label, path: offlinePath }, { source: 'watchers' });
          if (shouldShowOfflinePopupNow()) {
            enqueueDialog({
              type: 'warning',
              title: 'Watcher Offline',
              message: `Watcher ${label} cannot access ${offlinePath}.\n\nThe app will retry automatically.`,
              buttons: ['OK'],
              defaultId: 0
            });
          }
        }
      }
      recordWatcherError(message.name, toError(message.error), context);
      break;
    }
    case 'userAlert': {
      const { title, message: body } = message;
      enqueueDialog({ type: 'warning', title, message: body, buttons: ['OK'], defaultId: 0 });
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
      const channelName = 'grundner:refresh';
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
