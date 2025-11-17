import { ok } from 'neverthrow';
import type { AppError } from '../../../shared/src';
import { RouterListReq } from '../../../shared/src';
import { listMachineJobs } from '../repo/routerRepo';
import { registerResultHandler } from './result';

export function registerRouterIpc() {
  registerResultHandler('router:list', async (_e, raw) => {
    const req = RouterListReq.parse(raw ?? {});
    const items = await listMachineJobs(req);
    return ok<{ items: typeof items }, AppError>({ items });
  });
}
