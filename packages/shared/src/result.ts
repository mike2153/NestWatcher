import { err, ok, type Result as NeverthrowResult } from 'neverthrow';
import type { AppError } from './ipc';

export type ResultEnvelope<T> = { ok: true; value: T } | { ok: false; error: AppError };
export type ResultPayload<T> = ResultEnvelope<T>;

export const makeOk = <T>(value: T): ResultEnvelope<T> => ({ ok: true, value });
export const makeErr = <T>(error: AppError): ResultEnvelope<T> => ({ ok: false, error });

export const toEnvelope = <T>(result: NeverthrowResult<T, AppError>): ResultEnvelope<T> =>
  result.isOk() ? makeOk(result.value) : makeErr(result.error);

export const fromEnvelope = <T>(payload: ResultEnvelope<T>): NeverthrowResult<T, AppError> =>
  payload.ok ? ok(payload.value) : err(payload.error);

export const toPayload = toEnvelope;
export const fromPayload = fromEnvelope;
