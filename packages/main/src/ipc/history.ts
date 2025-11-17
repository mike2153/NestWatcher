import { ok, err } from 'neverthrow';
import type { AppError } from '../../../shared/src';
import { HistoryListReq } from '../../../shared/src';
import { getJobTimeline, listHistory } from '../repo/historyRepo';
import { createAppError } from './errors';
import { registerResultHandler } from './result';

export function registerHistoryIpc() {
  registerResultHandler('history:list', async (_event, raw) => {
    const req = HistoryListReq.parse(raw ?? {});
    const items = await listHistory(req);
    return ok({ items });
  });

  registerResultHandler('history:timeline', async (_event, raw) => {
    const key = typeof raw === 'string'
      ? raw
      : typeof raw === 'object' && raw !== null && 'key' in raw
        ? (raw as { key: unknown }).key
        : undefined;
    if (typeof key !== 'string') {
      return err(createAppError('history.invalidRequest', 'Invalid history timeline request'));
    }
    const data = await getJobTimeline(key);
    return ok<typeof data, AppError>(data);
  });
}
