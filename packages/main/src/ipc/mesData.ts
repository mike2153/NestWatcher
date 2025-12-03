import { z } from 'zod';
import { ok, err } from 'neverthrow';
import type { AppError, ValidationDataRes, AggregatedValidationDataRes } from '../../../shared/src';
import { registerResultHandler } from './result';
import { createAppError } from './errors';
import { getAggregatedNcStats, getNcStats } from '../repo/ncStatsRepo';

const ValidationGetReq = z.object({ key: z.string().min(1) });
const AggregatedValidationGetReq = z.object({ keys: z.array(z.string().min(1)).min(1) });

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

  registerResultHandler<AggregatedValidationDataRes>('validation:getAggregatedData', async (_event, raw) => {
    const parsed = AggregatedValidationGetReq.safeParse(raw ?? {});
    if (!parsed.success) {
      return err(createAppError('mes.invalidArguments', parsed.error.message));
    }
    const record = await getAggregatedNcStats(parsed.data.keys);
    if (!record) {
      return err(createAppError('mes.notFound', 'No MES data found for these jobs.'));
    }
    return ok<AggregatedValidationDataRes, AppError>(record);
  });
}
