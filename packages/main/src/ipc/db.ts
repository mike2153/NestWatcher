import type { WebContents } from 'electron';
import type { AppError, DbStatus } from '../../../shared/src';
import { ok } from 'neverthrow';
import { withClient } from '../services/db';
import { getDbStatus, subscribeDbStatus } from '../services/dbWatchdog';
import { registerResultHandler } from './result';
import { onContentsDestroyed } from './onDestroyed';

const statusSubscribers = new Map<number, { unsubscribe: () => void; count: number }>();

function ensureSubscription(contents: WebContents): DbStatus {
  const id = contents.id;
  const existing = statusSubscribers.get(id);
  if (existing) {
    existing.count += 1;
    return getDbStatus();
  }

  const send = (next: DbStatus) => {
    if (!contents.isDestroyed()) {
      contents.send('db:status:update', next);
    }
  };

  const unsubscribe = subscribeDbStatus(send);
  
  // Register destroyed cleanup BEFORE adding to map to prevent race condition
  onContentsDestroyed(contents, () => {
    const entry = statusSubscribers.get(id);
    if (!entry) return; // nil-guard if entry is already absent

    // Use reference counting instead of unconditional cleanup
    entry.count -= 1;
    if (entry.count <= 0) {
      entry.unsubscribe();
      statusSubscribers.delete(id);
    }
  });

  // Check if destroyed after handler registration
  if (contents.isDestroyed()) {
    unsubscribe(); // Clean up immediately if already destroyed
    return getDbStatus();
  }

  statusSubscribers.set(id, { unsubscribe, count: 1 });

  return getDbStatus();
}

function releaseSubscription(contents: WebContents) {
  const id = contents.id;
  const entry = statusSubscribers.get(id);
  if (!entry) return;
  entry.count -= 1;
  if (entry.count <= 0) {
    entry.unsubscribe();
    statusSubscribers.delete(id);
  }
}

export function registerDbIpc() {
  registerResultHandler('db:ping', async () => {
    await withClient((c) => c.query('SELECT 1'));
    return ok<null, AppError>(null);
  });

  registerResultHandler('db:status:get', async () => ok<DbStatus, AppError>(getDbStatus()));

  registerResultHandler('db:status:subscribe', async (event) =>
    ok<DbStatus, AppError>(ensureSubscription(event.sender))
  );

  registerResultHandler('db:status:unsubscribe', async (event) => {
    releaseSubscription(event.sender);
    return ok<null, AppError>(null);
  });
}
