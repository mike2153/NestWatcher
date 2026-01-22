import { z } from 'zod';
import { err, ok } from 'neverthrow';
import type { AppError, NcCatValidationReportsListRes } from '../../../shared/src';
import { registerResultHandler } from './result';
import { createAppError, toAppError } from './errors';
import { listValidationReports } from '../repo/validationReportsRepo';

const ListReq = z.object({
  limit: z.number().int().min(1).max(200).default(50)
});

export function registerNcCatValidationReportsIpc() {
  registerResultHandler<NcCatValidationReportsListRes>('validation:listHeadlessReports', async (_event, raw) => {
    const parsed = ListReq.safeParse(raw ?? {});
    if (!parsed.success) {
      return err(createAppError('validation.invalidArguments', parsed.error.message));
    }

    try {
      const items = await listValidationReports(parsed.data.limit);
      return ok<NcCatValidationReportsListRes, AppError>({ items });
    } catch (error) {
      return err(toAppError(error));
    }
  });
}

