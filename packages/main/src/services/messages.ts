import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

export type AppMessageEntry = {
  id: string;
  createdAt: string;
  title: string;
  body: string;
  source?: string;
};

const MAX_MESSAGES = 200;
const emitter = new EventEmitter();
const messages: AppMessageEntry[] = [];

export function listAppMessages(): AppMessageEntry[] {
  return [...messages];
}

export function pushAppMessage(input: { title: string; body: string; source?: string; timestamp?: string }): AppMessageEntry {
  const entry: AppMessageEntry = {
    id: randomUUID(),
    createdAt: input.timestamp ?? new Date().toISOString(),
    title: input.title,
    body: input.body,
    source: input.source
  };
  messages.unshift(entry);
  if (messages.length > MAX_MESSAGES) {
    messages.length = MAX_MESSAGES;
  }
  emitter.emit('update', entry);
  return entry;
}

export function subscribeAppMessages(listener: (entry: AppMessageEntry) => void): () => void {
  emitter.on('update', listener);
  return () => {
    emitter.off('update', listener);
  };
}
