import { clipboard, type WebContents } from 'electron';
import { ok, err } from 'neverthrow';
import type { AppError, CopyDiagnosticsResult, DiagnosticsLogSummary, DiagnosticsLogTailRes } from '../../../shared/src';
import { DiagnosticsLogTailReq } from '../../../shared/src';
import { getDiagnosticsSnapshot, subscribeDiagnostics, buildDiagnosticsCopyPayload, listDiagnosticsLogs, getDiagnosticsLogTail } from '../services/diagnostics';
import { logger } from '../logger';
import { createAppError } from './errors';
import { registerResultHandler } from './result';
import { onContentsDestroyed } from './onDestroyed';

type DiagnosticsSubscription = {
  unsubscribe: () => void;
  count: number;
};

const subscribers = new Map<number, DiagnosticsSubscription>();

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
}


