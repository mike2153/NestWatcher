import { ok } from 'neverthrow';
import type { AppError } from '../../../shared/src';
import { GrundnerListReq, GrundnerUpdateReq, GrundnerResyncReq } from '../../../shared/src';
import { listGrundner, updateGrundnerRow, resyncGrundnerReserved } from '../repo/grundnerRepo';
import { pushAppMessage } from '../services/messages';
import { registerResultHandler } from './result';

export function registerGrundnerIpc() {
  registerResultHandler('grundner:list', async (_e, raw) => {
    const req = GrundnerListReq.parse(raw ?? {});
    const items = await listGrundner(req);
    return ok({ items });
  });

  registerResultHandler('grundner:update', async (_e, raw) => {
    const req = GrundnerUpdateReq.parse(raw);
    const res = await updateGrundnerRow(req);
    return ok(res);
  });

  registerResultHandler('grundner:resync', async (_e, raw) => {
    const req = GrundnerResyncReq.parse(raw ?? {});
    const updated = await resyncGrundnerReserved(req.id);
    pushAppMessage(
      'grundner.resync',
      {
        user: 'UI',
        mode: req.id != null ? 'single' : 'all'
      },
      { source: 'grundner' }
    );
    return ok<{ updated: number }, AppError>({ updated });
  });
}
