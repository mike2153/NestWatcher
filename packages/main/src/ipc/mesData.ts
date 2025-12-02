import { z } from 'zod';
import { ok, err } from 'neverthrow';
import type { AppError, ValidationDataRes } from '../../../shared/src';
import { registerResultHandler } from './result';
import { createAppError } from './errors';
import { getNcStats } from '../repo/ncStatsRepo';

const ValidationGetReq = z.object({ key: z.string().min(1) });

export function registerMesDataIpc() {
  registerResultHandler<ValidationDataRes>('validation:getData', async (_event, raw) => {
    const parsed = ValidationGetReq.safeParse(raw ?? {});
    if (!parsed.success) {
      return err(createAppError('mes.invalidArguments', parsed.error.message));
    }
    const record = await getNcStats(parsed.data.key);
    if (!record) {
      return err(createAppError('mes.notFound', 'No MES data found for this job.'));
    }
    return ok<ValidationDataRes, AppError>(record);
  });
}
