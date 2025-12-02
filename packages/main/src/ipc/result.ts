import type { IpcMainInvokeEvent } from 'electron';
import { ResultAsync, type Result } from 'neverthrow';
import type { AppError } from '../../../shared/src';
import { makeOk, makeErr, toEnvelope, type ResultEnvelope } from '../../../shared/src';
import { toAppError } from './errors';
import { getIpcMain } from './ipcBridge';
import { requireSession, requireAdminSession } from '../services/authSessions';

export function fromResult<T>(result: Result<T, AppError>): ResultEnvelope<T> {
  return toEnvelope(result);
}

export async function fromPromise<T>(resolver: () => Promise<T>): Promise<ResultEnvelope<T>> {
  const result = await ResultAsync.fromPromise(resolver(), toAppError);
  return toEnvelope(result);
}

export function success<T>(value: T): ResultEnvelope<T> {
  return makeOk(value);
}

export function failure<T>(error: AppError): ResultEnvelope<T> {
  return makeErr<T>(error);
}

type HandlerOptions = {
  requiresAuth?: boolean;
  requiresAdmin?: boolean;
};

export function registerResultHandler<T>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<Result<T, AppError>> | Result<T, AppError>,
  options?: HandlerOptions
) {
  const ipcMain = getIpcMain();
  const requiresAuth = options?.requiresAuth ?? true;
  const requiresAdmin = options?.requiresAdmin ?? false;
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      if (requiresAdmin) {
        await requireAdminSession(event);
      } else if (requiresAuth) {
        await requireSession(event);
      }
      const result = await handler(event, ...args);
      return fromResult(result);
    } catch (error) {
      return failure<T>(toAppError(error));
    }
  });
}
