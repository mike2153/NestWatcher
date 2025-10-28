import { BrowserWindow } from 'electron';
import { ok, err } from 'neverthrow';
import type { AppError, WorklistAddResult } from '../../../shared/src';
import { JobEventsReq, JobsListReq, ReserveReq, UnreserveReq, LockReq, UnlockReq, LockBatchReq, UnlockBatchReq } from '../../../shared/src';
import { getJobEvents } from '../repo/jobEventsRepo';
import { listJobFilters, listJobs, reserveJob, unreserveJob, lockJob, unlockJob, lockJobAfterGrundnerConfirmation } from '../repo/jobsRepo';
import { rerunAndStage } from '../services/worklist';
import { withDb } from '../services/db';
import { inArray, eq } from 'drizzle-orm';
import { jobs } from '../db/schema';
import { placeOrderSawCsv } from '../services/orderSaw';
import { placeProductionDeleteCsv } from '../services/productionDelete';
import { rerunJob } from '../services/rerun';
import { addJobToWorklist } from '../services/worklist';
import { ingestProcessedJobsRoot } from '../services/ingest';
import { logger } from '../logger';
import { createAppError } from './errors';
import { registerResultHandler } from './result';

async function unlockJobs(keys: string[]) {
  const seen = new Set<string>();
  const orderedKeys: string[] = [];
  for (const rawKey of keys) {
    if (typeof rawKey !== 'string') continue;
    const key = rawKey.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    orderedKeys.push(key);
  }
  if (!orderedKeys.length) {
    return err(createAppError('jobs.invalidArguments', 'No jobs provided.'));
  }

  const rows = await withDb((db) =>
    db
      .select({ key: jobs.key, ncfile: jobs.ncfile, material: jobs.material })
      .from(jobs)
      .where(inArray(jobs.key, orderedKeys))
  );
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const missing = orderedKeys.filter((key) => !byKey.has(key));
  if (missing.length) {
    const message =
      orderedKeys.length === 1 ? 'Job not found.' : `Jobs not found: ${missing.join(', ')}`;
    return err(createAppError('jobs.notFound', message));
  }
  const missingNc = orderedKeys.filter((key) => {
    const row = byKey.get(key);
    return !row || !row.ncfile;
  });
  if (missingNc.length) {
    const message =
      orderedKeys.length === 1
        ? 'Job or NC file not found.'
        : `NC file not found for: ${missingNc.join(', ')}`;
    return err(createAppError('jobs.notFound', message));
  }

  const items = orderedKeys.map((key) => {
    const row = byKey.get(key)!;
    return { ncfile: row.ncfile, material: row.material };
  });
  const result = await placeProductionDeleteCsv(items);
  if (!result.confirmed) {
    return err(createAppError('grundner.deleteFailed', result.message ?? 'Delete not confirmed by Grundner'));
  }

  const failures: string[] = [];
  for (const key of orderedKeys) {
    const success = await unlockJob(key);
    if (!success) failures.push(key);
  }
  if (failures.length) {
    const message =
      orderedKeys.length === 1
        ? 'Job is not currently locked.'
        : `Failed to unlock ${failures.length} job(s): ${failures.join(', ')}`;
    return err(createAppError('jobs.notLocked', message));
  }
  broadcastAllocatedMaterialRefresh();
  return ok<null, AppError>(null);
}

export function registerJobsIpc() {
  // Return filters wrapped in an { options } object to match JobsFiltersRes
  registerResultHandler('jobs:filters', async () =>
    ok({ options: await listJobFilters() })
  );

  registerResultHandler('jobs:events', async (_e, raw) => {
    const req = JobEventsReq.parse(raw);
    const events = await getJobEvents(req.key, req.limit ?? 50);
    // Wrap in an object to match JobEventsRes shape expected by the renderer
    return ok({ events });
  });

  registerResultHandler('jobs:list', async (_e, raw) => {
    const req = JobsListReq.parse(raw);
    const res = await listJobs(req);
    return ok(res);
  });

  registerResultHandler('jobs:reserve', async (_e, raw) => {
    const req = ReserveReq.parse(raw);
    const success = await reserveJob(req.key);
    if (!success) {
      return err(createAppError('jobs.alreadyReserved', 'Job is already reserved.'));
    }
    return ok<null, AppError>(null);
  });

  registerResultHandler('jobs:unreserve', async (_e, raw) => {
    const req = UnreserveReq.parse(raw);
    const success = await unreserveJob(req.key);
    if (!success) {
      return err(createAppError('jobs.notReserved', 'Job is not currently reserved.'));
    }
    return ok<null, AppError>(null);
  });

  registerResultHandler('jobs:lock', async (_e, raw) => {
    const req = LockReq.parse(raw);
    const success = await lockJob(req.key);
    if (!success) {
      // Provide a clearer reason when locking fails
      const rows = await withDb((db) =>
        db
          .select({ isLocked: jobs.isLocked, status: jobs.status })
          .from(jobs)
          .where(eq(jobs.key, req.key))
          .limit(1)
      );
      if (!rows.length) {
        return err(createAppError('jobs.notFound', 'Job not found.'));
      }
      const row = rows[0];
      if (row.isLocked) {
        return err(createAppError('jobs.alreadyLocked', 'Job is already locked.'));
      }
      if (row.status !== 'PENDING') {
        return err(
          createAppError(
            'jobs.cannotLockUnlessPending',
            'Job can only be locked when status is PENDING.'
          )
        );
      }
      return err(createAppError('jobs.lockFailed', 'Failed to lock job.'));
    }
    return ok<null, AppError>(null);
  });

  registerResultHandler('jobs:unlock', async (_e, raw) => {
    const req = UnlockReq.parse(raw);
    return unlockJobs([req.key]);
  });

  registerResultHandler('jobs:unlockBatch', async (_e, raw) => {
    const req = UnlockBatchReq.parse(raw);
    return unlockJobs(req.keys);
  });

  registerResultHandler('jobs:lockBatch', async (_e, raw) => {
    const req = LockBatchReq.parse(raw);
    const keys = Array.from(new Set(req.keys));
    if (keys.length === 0) return err(createAppError('jobs.invalidArguments', 'No jobs provided.'));

    // Gather rows for CSV
    const rows = await withDb((db) =>
      db
        .select({ key: jobs.key, ncfile: jobs.ncfile, material: jobs.material })
        .from(jobs)
        .where(inArray(jobs.key, keys))
    );
    if (rows.length === 0) return err(createAppError('jobs.notFound', 'No matching jobs found.'));

    try {
      const result = await placeOrderSawCsv(rows);
      if (!result.confirmed) {
        const message = result.erl ? result.erl : 'Timed out waiting for confirmation (.erl)';
        return err(createAppError('grundner.orderFailed', message));
      }

      // Mark locked after Grundner .erl confirmation
      for (const k of keys) {
        await lockJobAfterGrundnerConfirmation(k);
      }
      broadcastAllocatedMaterialRefresh();
      return ok<null, AppError>(null);
    } catch (ex) {
      return err(createAppError('grundner.orderError', (ex as Error)?.message ?? String(ex)));
    }
  });

  registerResultHandler('jobs:rerun', async (_e, raw) => {
    if (typeof raw !== 'object' || raw === null || typeof (raw as { key?: unknown }).key !== 'string') {
      return err(createAppError('jobs.invalidArguments', 'Invalid arguments supplied.'));
    }
    const key = (raw as { key: string }).key;
    const res = await rerunJob(key);
    if (!res.ok) return err(createAppError('jobs.rerunFailed', res.error));
    return ok<null, AppError>(null);
  });

  registerResultHandler('jobs:addToWorklist', async (_e, raw) => {
    if (typeof raw !== 'object' || raw === null) {
      return err(createAppError('jobs.invalidArguments', 'Invalid arguments supplied.'));
    }
    const { key, machineId } = raw as { key?: unknown; machineId?: unknown };
    if (typeof key !== 'string' || typeof machineId !== 'number') {
      return err(createAppError('jobs.invalidArguments', 'Invalid arguments supplied.'));
    }
    const result = await addJobToWorklist(key, machineId);
    return ok<WorklistAddResult, AppError>(result);
  });

  registerResultHandler('jobs:rerunAndStage', async (_e, raw) => {
    if (typeof raw !== 'object' || raw === null) {
      return err(createAppError('jobs.invalidArguments', 'Invalid arguments supplied.'));
    }
    const { key, machineId } = raw as { key?: unknown; machineId?: unknown };
    if (typeof key !== 'string' || typeof machineId !== 'number') {
      return err(createAppError('jobs.invalidArguments', 'Invalid arguments supplied.'));
    }
    const result = await rerunAndStage(key, machineId);
    return ok<WorklistAddResult, AppError>(result);
  });

  registerResultHandler('jobs:resync', async () => ok(await ingestProcessedJobsRoot()));
}

function broadcastAllocatedMaterialRefresh() {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) {
        win.webContents.send('allocatedMaterial:refresh');
      }
    } catch (err) {
      logger.warn({ err }, 'jobs: failed to broadcast allocated material refresh');
    }
  }
}
