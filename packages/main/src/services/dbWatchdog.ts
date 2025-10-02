import { logger } from '../logger';
import type { DbStatus } from '../../../shared/src';
import { resetPool, withClient } from './db';

const listeners = new Set<(status: DbStatus) => void>();

let status: DbStatus = {
  online: false,
  checkedAt: new Date(0).toISOString(),
  latencyMs: null,
  error: null
};

let timer: NodeJS.Timeout | null = null;
let running = false;
let rerun = false;

function emit(next: DbStatus) {
  status = next;
  for (const listener of [...listeners]) {
    try {
      listener(status);
    } catch (err) {
      logger.warn({ err }, 'db status listener threw');
    }
  }
}

async function runCheck() {
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  do {
    rerun = false;
    const started = Date.now();
    try {
      await withClient((client) => client.query('SELECT 1'));
      const latencyMs = Date.now() - started;
      emit({
        online: true,
        checkedAt: new Date().toISOString(),
        latencyMs,
        error: null
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: message }, 'Database connectivity check failed');
      await resetPool();
      emit({
        online: false,
        checkedAt: new Date().toISOString(),
        latencyMs: null,
        error: message
      });
    }
  } while (rerun);
  running = false;
}

export function getDbStatus(): DbStatus {
  return status;
}

export function subscribeDbStatus(listener: (status: DbStatus) => void): () => void {
  listeners.add(listener);
  listener(status);
  return () => listeners.delete(listener);
}

export function triggerDbStatusCheck() {
  void runCheck();
}

export function startDbWatchdog(intervalMs = 15000) {
  if (timer) return;
  
  const scheduleNext = async () => {
    await runCheck();
    timer = setTimeout(scheduleNext, intervalMs);
  };
  
  void scheduleNext();
}

export function stopDbWatchdog() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

