import type { WebContents, IpcMainInvokeEvent } from 'electron';
import type { AuthSession } from '../../../shared/src';
import { createAppError } from '../ipc/errors';
import { onContentsDestroyed } from '../ipc/onDestroyed';
import { clearSession, getActiveSessionToken } from '../repo/userRepo';

type InternalSession = AuthSession & { token: string };

const sessionsByContents = new Map<number, InternalSession>();

function toAuthSession(raw: InternalSession): AuthSession {
  const { token: _token, ...session } = raw;
  return session;
}

function getInternalSession(contents: WebContents): InternalSession | null {
  const raw = sessionsByContents.get(contents.id);
  return raw ?? null;
}

export function attachSession(contents: WebContents, session: InternalSession): void {
  const id = contents.id;
  sessionsByContents.set(id, session);
  onContentsDestroyed(contents, () => {
    detachSession(contents).catch(() => {});
  });
}

export async function detachSession(contents: WebContents, options?: { clearDb?: boolean }): Promise<void> {
  const id = contents.id;
  const existing = sessionsByContents.get(id);
  if (!existing) return;
  sessionsByContents.delete(id);
  if (options?.clearDb !== false) {
    await clearSession(existing.userId);
  }
}

export function getSession(contents: WebContents): AuthSession | null {
  const raw = sessionsByContents.get(contents.id);
  if (!raw) return null;
  return toAuthSession(raw);
}

export async function requireSession(event: IpcMainInvokeEvent): Promise<AuthSession> {
  const internal = getInternalSession(event.sender);
  if (!internal) {
    throw createAppError('auth.required', 'Please log in to continue.');
  }

  const dbToken = await getActiveSessionToken(internal.userId);
  const tokenMatches = Boolean(dbToken && dbToken === internal.token);
  if (!tokenMatches) {
    // Session was replaced elsewhere; drop local state without clearing DB (keep the new token intact)
    await detachSession(event.sender, { clearDb: false });
    try {
      event.sender.send('auth:revoked');
    } catch {
      // ignore notification failures
    }
    throw createAppError('auth.replaced', 'Your session was signed out because it was opened elsewhere.');
  }

  return toAuthSession(internal);
}

export async function requireAdminSession(event: IpcMainInvokeEvent): Promise<AuthSession> {
  const session = await requireSession(event);
  if (session.role !== 'admin') {
    throw createAppError('auth.forbidden', 'Administrator privileges are required.');
  }
  return session;
}

export function setSessionForEvent(event: IpcMainInvokeEvent, session: InternalSession) {
  attachSession(event.sender, session);
}
