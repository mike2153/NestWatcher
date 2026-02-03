import { ok } from 'neverthrow';
import type { AppError } from '../../../shared/src';
import { LifecycleReq, ManualLifecycleReq } from '../../../shared/src';
import { updateLifecycle } from '../repo/jobsRepo';
import { registerResultHandler } from './result';
import { requireSession } from '../services/authSessions';

export function registerLifecycleIpc() {
  registerResultHandler('jobs:lifecycle', async (_e, raw) => {
    const req = LifecycleReq.parse(raw);
    const options: { machineId?: number | null; source?: string; payload?: unknown } = {};
    if (Object.prototype.hasOwnProperty.call(req, 'machineId')) {
      options.machineId = req.machineId ?? null;
    }
    if (req.source) {
      options.source = req.source;
    }
    if (Object.prototype.hasOwnProperty.call(req, 'payload')) {
      options.payload = req.payload;
    }
    const result = await updateLifecycle(req.key, req.to, options);
    return ok<typeof result, AppError>(result);
  });

  registerResultHandler('jobs:lifecycleManual', async (event, raw) => {
    const session = await requireSession(event);
    const req = ManualLifecycleReq.parse(raw);
    const result = await updateLifecycle(req.key, req.to, {
      source: 'router-manual',
      actorName: session.displayName,
      payload: { reason: req.reason }
    });
    return ok<typeof result, AppError>(result);
  });
}
