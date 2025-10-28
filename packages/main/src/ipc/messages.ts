import { ok } from 'neverthrow';
import type { AppError } from '../../../shared/src';
import { listAppMessages, subscribeAppMessages, type AppMessageEntry } from '../services/messages';
import { registerResultHandler } from './result';
import { onContentsDestroyed } from './onDestroyed';

type Subscription = {
  count: number;
  unsubscribe: () => void;
};

const subscribers = new Map<number, Subscription>();

function ensureSubscription(contents: Electron.WebContents) {
  const id = contents.id;
  const existing = subscribers.get(id);
  if (existing) {
    existing.count += 1;
    return;
  }
  const unsubscribe = subscribeAppMessages((entry) => {
    if (!contents.isDestroyed()) {
      contents.send('messages:append', entry);
    }
  });
  subscribers.set(id, { count: 1, unsubscribe });
  onContentsDestroyed(contents, () => releaseSubscription(contents));
}

function releaseSubscription(contents: Electron.WebContents) {
  const id = contents.id;
  const entry = subscribers.get(id);
  if (!entry) return;
  entry.count -= 1;
  if (entry.count <= 0) {
    try {
      entry.unsubscribe();
    } catch {
      /* ignore */
    }
    subscribers.delete(id);
  }
}

export function registerMessagesIpc() {
  registerResultHandler('messages:list', async () => {
    const items = listAppMessages();
    return ok<{ items: AppMessageEntry[] }, AppError>({ items });
  });

  registerResultHandler('messages:subscribe', async (event) => {
    ensureSubscription(event.sender);
    return ok<null, AppError>(null);
  });

  registerResultHandler('messages:unsubscribe', async (event) => {
    releaseSubscription(event.sender);
    return ok<null, AppError>(null);
  });
}
