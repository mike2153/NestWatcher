import type { WebContents, IpcMainInvokeEvent } from 'electron';
import type { AuthSession } from '../../../shared/src';
import { createAppError } from '../ipc/errors';
import { onContentsDestroyed } from '../ipc/onDestroyed';
import { clearSession } from '../repo/userRepo';

type InternalSession = AuthSession & { token: string };

const sessionsByContents = new Map<number, InternalSession>();

export function attachSession(contents: WebContents, session: InternalSession): void {
  const id = contents.id;
  sessionsByContents.set(id, session);
  onContentsDestroyed(contents, () => {
    detachSession(contents).catch(() => {});
  });
}

export async function detachSession(contents: WebContents): Promise<void> {
  const id = contents.id;
  const existing = sessionsByContents.get(id);
  if (!existing) return;
  sessionsByContents.delete(id);
  await clearSession(existing.userId);
}

export function getSession(contents: WebContents): AuthSession | null {
  const raw = sessionsByContents.get(contents.id);
  if (!raw) return null;
  const { token: _token, ...session } = raw;
  return session;
}

export function requireSession(event: IpcMainInvokeEvent): AuthSession {
  const session = getSession(event.sender);
  if (!session) {
    throw createAppError('auth.required', 'Please log in to continue.');
  }
  return session;
}

export function requireAdminSession(event: IpcMainInvokeEvent): AuthSession {
  const session = requireSession(event);
  if (session.role !== 'admin') {
    throw createAppError('auth.forbidden', 'Administrator privileges are required.');
  }
  return session;
}

export function setSessionForEvent(event: IpcMainInvokeEvent, session: InternalSession) {
  attachSession(event.sender, session);
}
