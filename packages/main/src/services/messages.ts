import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { formatAppMessage } from '../../../shared/src/messages';
import type { MessageParams, MessageTone } from '../../../shared/src/messages';

export type AppMessageEntry = {
  id: string;
  createdAt: string;
  event: string;
  title: string;
  body: string;
  tone: MessageTone;
  params?: MessageParams;
  source?: string;
  read: boolean;
};

const MAX_MESSAGES = 200;
const emitter = new EventEmitter();
const countEmitter = new EventEmitter();
const messages: AppMessageEntry[] = [];
let unreadCount = 0;

function trimMessages() {
  while (messages.length > MAX_MESSAGES) {
    const removed = messages.pop();
    if (removed && !removed.read && unreadCount > 0) {
      unreadCount -= 1;
    }
  }
}

export function listAppMessages(): AppMessageEntry[] {
  return [...messages];
}

export function pushAppMessage(
  event: string,
  params?: MessageParams,
  options?: { source?: string; timestamp?: string }
): AppMessageEntry {
  const { definition, title, body } = formatAppMessage(event, params);
  const entry: AppMessageEntry = {
    id: randomUUID(),
    createdAt: options?.timestamp ?? new Date().toISOString(),
    event,
    title,
    body,
    tone: definition.tone,
    params,
    source: options?.source,
    read: false
  };
  messages.unshift(entry);
  trimMessages();
  unreadCount += 1;
  emitter.emit('update', entry);
  countEmitter.emit('count', unreadCount);
  return entry;
}

export function subscribeAppMessages(listener: (entry: AppMessageEntry) => void): () => void {
  emitter.on('update', listener);
  return () => {
    emitter.off('update', listener);
  };
}

export function subscribeMessageCounts(listener: (count: number) => void): () => void {
  countEmitter.on('count', listener);
  return () => {
    countEmitter.off('count', listener);
  };
}

export function getUnreadCount(): number {
  return unreadCount;
}

export function markAllMessagesRead(): void {
  if (!unreadCount) return;
  for (const entry of messages) {
    entry.read = true;
  }
  unreadCount = 0;
  countEmitter.emit('count', unreadCount);
}
