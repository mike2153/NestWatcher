import { beforeEach, describe, expect, it, vi } from 'vitest';
import { err, ok, type Result } from 'neverthrow';
import { ipcMain } from 'electron';

import type { AppError, ResultEnvelope } from '../../packages/shared/src';
import { createAppError } from '../../packages/main/src/ipc/errors';
import { failure, fromPromise, fromResult, registerResultHandler, success } from '../../packages/main/src/ipc/result';

type StoredHandler = (event: unknown, ...args: unknown[]) => unknown;

const handlers = ((globalThis as unknown as { __IPC_HANDLERS__?: Map<string, StoredHandler> }).__IPC_HANDLERS__ ?? new Map<string, StoredHandler>()) as Map<string, StoredHandler>;

describe('ipc result utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
  });

  it('wraps neverthrow results as envelopes', () => {
    const valueEnvelope = fromResult(ok('value'));
    expect(valueEnvelope).toEqual({ ok: true, value: 'value' });

    const appError = createAppError('test.failure', 'nope', { extra: 1 });
    const errorEnvelope = fromResult(err(appError));
    expect(errorEnvelope).toEqual({ ok: false, error: appError });
  });

  it('converts promises into envelopes', async () => {
    const resolver = vi.fn(async () => 42);
    const okEnvelope = await fromPromise(resolver);
    expect(resolver).toHaveBeenCalledOnce();
    expect(okEnvelope).toEqual({ ok: true, value: 42 });

    const appError = createAppError('db.error', 'boom');
    const failureEnvelope = await fromPromise(() => Promise.reject(appError));
    expect(failureEnvelope).toEqual({ ok: false, error: appError });
  });

  it('builds success and failure envelopes directly', () => {
    expect(success('ready')).toEqual({ ok: true, value: 'ready' });

    const appError = createAppError('test.failure', 'kaboom');
    expect(failure(appError)).toEqual({ ok: false, error: appError });
  });

  describe('registerResultHandler', () => {
    it('registers handler and forwards result envelopes', async () => {
      const appError = createAppError('test.failure', 'invalid');
      const okHandler = vi.fn(async () => ok('ok-result'));
      const errHandler = vi.fn(() => err(appError) as Result<string, AppError>);

      registerResultHandler<string>('test:ok', okHandler);
      registerResultHandler<string>('test:err', errHandler);

      expect(ipcMain.handle).toHaveBeenCalledWith('test:ok', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('test:err', expect.any(Function));

      const okRegistered = handlers.get('test:ok');
      expect(typeof okRegistered).toBe('function');
      const okPayload = (await okRegistered!({ sender: { id: 1 } })) as ResultEnvelope<string>;
      expect(okHandler).toHaveBeenCalledWith(expect.objectContaining({ sender: { id: 1 } }));
      expect(okPayload).toEqual({ ok: true, value: 'ok-result' });

      const errRegistered = handlers.get('test:err');
      expect(typeof errRegistered).toBe('function');
      const errPayload = (await errRegistered!({ sender: { id: 2 } })) as ResultEnvelope<string>;
      expect(errHandler).toHaveBeenCalledWith(expect.objectContaining({ sender: { id: 2 } }));
      expect(errPayload).toEqual({ ok: false, error: appError });
    });

    it('maps thrown errors via toAppError', async () => {
      registerResultHandler<string>('test:throw', () => {
        throw new Error('explode');
      });

      const handler = handlers.get('test:throw');
      expect(typeof handler).toBe('function');
      const payload = (await handler!({ sender: {} })) as ResultEnvelope<string>;
      expect(payload.ok).toBe(false);
      if (!payload.ok) {
        expect(payload.error.code).toBe('unknown');
        expect(payload.error.message).toBe('explode');
        expect(payload.error.details).toBeDefined();
      }
    });
  });
});




