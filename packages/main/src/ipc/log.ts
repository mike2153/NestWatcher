import { ok } from 'neverthrow';
import type { AppError, LogWriteReq } from '../../../shared/src';
import { LogWriteReq as LogWriteReqSchema } from '../../../shared/src';
import { logger } from '../logger';
import { registerResultHandler } from './result';

export function registerLogIpc() {
  registerResultHandler<null>('log:write', async (_event, raw) => {
    const parsed = LogWriteReqSchema.parse(raw ?? {});
    const { level, msg, context } = parsed as LogWriteReq;
    const safeMsg = `renderer: ${msg}`;
    try {
      switch (level) {
        case 'trace':
          logger.trace({ proc: 'Renderer', source: 'renderer', ...context }, safeMsg);
          break;
        case 'debug':
          logger.debug({ proc: 'Renderer', source: 'renderer', ...context }, safeMsg);
          break;
        case 'info':
          logger.info({ proc: 'Renderer', source: 'renderer', ...context }, safeMsg);
          break;
        case 'warn':
          logger.warn({ proc: 'Renderer', source: 'renderer', ...context }, safeMsg);
          break;
        case 'error':
          logger.error({ proc: 'Renderer', source: 'renderer', ...context }, safeMsg);
          break;
        case 'fatal':
          logger.fatal({ proc: 'Renderer', source: 'renderer', ...context }, safeMsg);
          break;
        default:
          logger.info({ proc: 'Renderer', source: 'renderer', ...context }, safeMsg);
      }
    } catch (err) {
      // Last resort: avoid throwing across IPC
      try { logger.warn({ err }, 'log:write failed'); } catch { /* noop */ void 0; }
    }
    return ok<null, AppError>(null);
  });
}
