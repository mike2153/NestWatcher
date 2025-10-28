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
};

const MAX_MESSAGES = 200;
const emitter = new EventEmitter();
const messages: AppMessageEntry[] = [];

function trimMessages() {
  if (messages.length > MAX_MESSAGES) {
    messages.length = MAX_MESSAGES;
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
    source: options?.source
  };
  messages.unshift(entry);
  trimMessages();
  emitter.emit('update', entry);
  return entry;
}

export function subscribeAppMessages(listener: (entry: AppMessageEntry) => void): () => void {
  emitter.on('update', listener);
  return () => {
    emitter.off('update', listener);
  };
}
