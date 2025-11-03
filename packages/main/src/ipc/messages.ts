import { ok } from 'neverthrow';
import type { AppError } from '../../../shared/src';
import {
  listAppMessages,
  subscribeAppMessages,
  subscribeMessageCounts,
  markAllMessagesRead,
  getUnreadCount,
  type AppMessageEntry
} from '../services/messages';
import { registerResultHandler } from './result';
import { onContentsDestroyed } from './onDestroyed';

type Subscription = {
  count: number;
  unsubscribe: () => void;
};

const subscribers = new Map<number, Subscription>();
const countSubscribers = new Map<number, Subscription>();

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

function ensureCountSubscription(contents: Electron.WebContents) {
  const id = contents.id;
  const existing = countSubscribers.get(id);
  if (existing) {
    existing.count += 1;
    return;
  }
  const unsubscribe = subscribeMessageCounts((count) => {
    if (!contents.isDestroyed()) {
      contents.send('messages:count', count);
    }
  });
  countSubscribers.set(id, { count: 1, unsubscribe });
  contents.send('messages:count', getUnreadCount());
  onContentsDestroyed(contents, () => releaseCountSubscription(contents));
}

function releaseCountSubscription(contents: Electron.WebContents) {
  const id = contents.id;
  const entry = countSubscribers.get(id);
  if (!entry) return;
  entry.count -= 1;
  if (entry.count <= 0) {
    try {
      entry.unsubscribe();
    } catch {
      /* ignore */
    }
    countSubscribers.delete(id);
  }
}

export function registerMessagesIpc() {
  registerResultHandler('messages:list', async () => {
    const items = listAppMessages();
    return ok<{ items: AppMessageEntry[] }, AppError>({ items });
  });

  registerResultHandler('messages:unreadCount', async () => ok<number, AppError>(getUnreadCount()));

  registerResultHandler('messages:markRead', async () => {
    markAllMessagesRead();
    return ok<null, AppError>(null);
  });

  registerResultHandler('messages:subscribe', async (event) => {
    ensureSubscription(event.sender);
    return ok<null, AppError>(null);
  });

  registerResultHandler('messages:unsubscribe', async (event) => {
    releaseSubscription(event.sender);
    return ok<null, AppError>(null);
  });

  registerResultHandler('messages:subscribeCount', async (event) => {
    ensureCountSubscription(event.sender);
    return ok<null, AppError>(null);
  });

  registerResultHandler('messages:unsubscribeCount', async (event) => {
    releaseCountSubscription(event.sender);
    return ok<null, AppError>(null);
  });
}

