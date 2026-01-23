import { clipboard, type WebContents } from 'electron';
import { ok, err } from 'neverthrow';
import type { AppError, CopyDiagnosticsResult, DiagnosticsLogSummary, DiagnosticsLogTailRes, DiagnosticsLogStreamReq } from '../../../shared/src';
import { DiagnosticsLogTailReq, DiagnosticsLogStreamReq as DiagnosticsLogStreamReqSchema } from '../../../shared/src';
import {
  getDiagnosticsSnapshot,
  subscribeDiagnostics,
  buildDiagnosticsCopyPayload,
  listDiagnosticsLogs,
  getDiagnosticsLogTail,
  subscribeLogStream,
  clearRecentErrors
} from '../services/diagnostics';
import { restartWatchers } from '../services/watchers';
import { logger } from '../logger';
import { createAppError } from './errors';
import { registerResultHandler } from './result';
import { onContentsDestroyed } from './onDestroyed';

type DiagnosticsSubscription = {
  unsubscribe: () => void;
  count: number;
};

const subscribers = new Map<number, DiagnosticsSubscription>();
const logSubscribers = new Map<number, { file: string; unsubscribe: () => void }>();

function pushSnapshot(contents: WebContents) {
  if (contents.isDestroyed()) return;
  contents.send('diagnostics:update', getDiagnosticsSnapshot());
}

function ensureSubscription(contents: WebContents) {
  const id = contents.id;
  const existing = subscribers.get(id);
  if (existing) {
    existing.count += 1;
    return;
  }

  const handler = () => pushSnapshot(contents);
  const unsubscribe = subscribeDiagnostics(handler);

  subscribers.set(id, { unsubscribe, count: 1 });

  onContentsDestroyed(contents, () => releaseSubscription(contents));
  handler();
}

function releaseSubscription(contents: WebContents) {
  const id = contents.id;
  const entry = subscribers.get(id);
  if (!entry) return;
  entry.count -= 1;
  if (entry.count <= 0) {
    entry.unsubscribe();
    subscribers.delete(id);
  }
}

export function registerDiagnosticsIpc() {
  registerResultHandler('diagnostics:get', async () => ok(getDiagnosticsSnapshot()));

  registerResultHandler('diagnostics:subscribe', async (event) => {
    ensureSubscription(event.sender);
    return ok<null, AppError>(null);
  });

  registerResultHandler('diagnostics:unsubscribe', async (event) => {
    releaseSubscription(event.sender);
    return ok<null, AppError>(null);
  });

  registerResultHandler('diagnostics:errors:clear', async () => {
    try {
      await clearRecentErrors();
      return ok<null, AppError>(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error }, 'diagnostics: failed to clear recent errors');
      return err(createAppError('DIAGNOSTICS_CLEAR_ERRORS_FAILED', message));
    }
  });

  registerResultHandler('diagnostics:logs:list', async () => {
    try {
      const items = await listDiagnosticsLogs();
      return ok<{ items: DiagnosticsLogSummary[] }, AppError>({ items });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error }, 'diagnostics: failed to list log files');
      return err(createAppError('DIAGNOSTICS_LOGS_LIST_FAILED', message));
    }
  });

  registerResultHandler('diagnostics:logs:tail', async (_event, raw) => {
    try {
      const req = DiagnosticsLogTailReq.parse(raw ?? {});
      const log = await getDiagnosticsLogTail(req.file, req.limit);
      return ok<DiagnosticsLogTailRes, AppError>(log);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error, raw }, 'diagnostics: failed to read log file');
      return err(createAppError('DIAGNOSTICS_LOG_TAIL_FAILED', message));
    }
  });

  registerResultHandler('diagnostics:copy', async () => {
    try {
      const { snapshot, logs } = await buildDiagnosticsCopyPayload();
      const payload = {
        copiedAt: new Date().toISOString(),
        snapshot,
        logs
      };
      const serialized = JSON.stringify(payload, null, 2);
      clipboard.writeText(serialized);
      const result: CopyDiagnosticsResult = {
        ok: true,
        copiedAt: payload.copiedAt,
        bytes: Buffer.byteLength(serialized, 'utf8'),
        logCount: logs.length,
        logs,
        snapshot
      };
      return ok<CopyDiagnosticsResult, AppError>(result);
    } catch (error) {
      logger.error({ error }, 'diagnostics: failed to copy diagnostics bundle');
      const message = error instanceof Error ? error.message : String(error);
      return err(createAppError('diagnostics.copyFailed', message));
    }
  });

  registerResultHandler('diagnostics:log:subscribe', async (event, raw) => {
    try {
      const req = DiagnosticsLogStreamReqSchema.parse(raw ?? {}) as DiagnosticsLogStreamReq;
      const file = String(req.file ?? '');
      if (!file) throw new Error('file is required');
      const contents = event.sender;
      const id = contents.id;

      // Clean up previous subscription for this contents
      const prev = logSubscribers.get(id);
      if (prev) {
        try { prev.unsubscribe(); } catch { /* noop */ void 0; }
        logSubscribers.delete(id);
      }

      const unsubscribe = subscribeLogStream(file, (lines) => {
        if (!contents.isDestroyed()) contents.send('diagnostics:log:update', { file, lines });
      });
      logSubscribers.set(id, { file, unsubscribe });

      onContentsDestroyed(contents, () => {
        const entry = logSubscribers.get(id);
        if (entry) {
          try { entry.unsubscribe(); } catch { /* noop */ void 0; }
          logSubscribers.delete(id);
        }
      });
      return ok<null, AppError>(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err({ code: 'DIAGNOSTICS_LOG_SUBSCRIBE_FAILED', message } as AppError);
    }
  });

  registerResultHandler('diagnostics:log:unsubscribe', async (event) => {
    const contents = event.sender;
    const id = contents.id;
    const entry = logSubscribers.get(id);
    if (entry) {
      try { entry.unsubscribe(); } catch { /* noop */ void 0; }
      logSubscribers.delete(id);
    }
    return ok<null, AppError>(null);
  });

  registerResultHandler('diagnostics:restart-watchers', async () => {
    try {
      logger.info('diagnostics: watchers restart requested via IPC');
      const result = await restartWatchers();
      if (result.ok) {
        return ok<{ ok: true }, AppError>({ ok: true });
      } else {
        return err(createAppError('WATCHERS_RESTART_FAILED', result.error ?? 'Unknown error'));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error }, 'diagnostics: watchers restart failed');
      return err(createAppError('WATCHERS_RESTART_FAILED', message));
    }
  });
}


