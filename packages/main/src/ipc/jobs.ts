import { ok, err } from 'neverthrow';
import type { AppError, WorklistAddResult } from '../../../shared/src';
import { JobEventsReq, JobsListReq, ReserveReq, UnreserveReq, LockReq, UnlockReq, LockBatchReq, UnlockBatchReq } from '../../../shared/src';
import { getJobEvents } from '../repo/jobEventsRepo';
import { listJobFilters, listJobs, reserveJob, unreserveJob, lockJob, unlockJob, lockJobAfterGrundnerConfirmation } from '../repo/jobsRepo';
import { rerunAndStage } from '../services/worklist';
import { withDb } from '../services/db';
import { inArray, eq, and, not, sql } from 'drizzle-orm';
import { jobs, grundner } from '../db/schema';
import { placeOrderSawCsv } from '../services/orderSaw';
import { rerunJob } from '../services/rerun';
import { addJobToWorklist } from '../services/worklist';
import { ingestProcessedJobsRoot } from '../services/ingest';
import { pushAppMessage } from '../services/messages';
import { createAppError } from './errors';
import { registerResultHandler } from './result';
import { requireSession } from '../services/authSessions';
import { unlockJobs } from './unlockJobs';

function ensureNcExtension(value: string | null | undefined, fallbackBase: string): string {
  const raw = value ?? fallbackBase;
  return raw.toLowerCase().endsWith('.nc') ? raw : `${raw}.nc`;
}

function formatSampleList(values: string[], limit = 3): string {
  if (!values.length) return '';
  const trimmed = values.slice(0, limit);
  return values.length > limit ? `${trimmed.join(', ')}, ...` : trimmed.join(', ');
}

function formatUserSuffix(user?: string | null) {
  return user ? ` (by ${user})` : '';
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

  registerResultHandler('jobs:lock', async (event, raw) => {
    const session = await requireSession(event);
    const req = LockReq.parse(raw);
    const success = await lockJob(req.key, session.displayName);
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
    pushAppMessage(
      'lock.success',
      {
        count: 1,
        sampleNcFiles: req.key,
        userSuffix: formatUserSuffix(session.displayName)
      },
      { source: 'jobs' }
    );
    return ok<null, AppError>(null);
  });

  registerResultHandler('jobs:unlock', async (event, raw) => {
    const session = await requireSession(event);
    const req = UnlockReq.parse(raw);
    return unlockJobs([req.key], session.displayName);
  });

  registerResultHandler('jobs:unlockBatch', async (event, raw) => {
    const session = await requireSession(event);
    const req = UnlockBatchReq.parse(raw);
    return unlockJobs(req.keys, session.displayName);
  });

  registerResultHandler('jobs:lockBatch', async (event, raw) => {
    const session = await requireSession(event);
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

    // Check stock availability before proceeding (type_data is the canonical key)
    const typeDataCounts = new Map<number, number>();
    let unknownCount = 0;
    for (const row of rows) {
      const raw = row.material?.trim() || '';
      const typeData = Number(raw);
      if (!raw || !Number.isFinite(typeData)) {
        unknownCount += 1;
        continue;
      }
      typeDataCounts.set(typeData, (typeDataCounts.get(typeData) ?? 0) + 1);
    }

    // Get stock information from Grundner
    const stockShortfalls: Array<{ material: string; required: number; available: number }> = [];
    if (unknownCount > 0) {
      stockShortfalls.push({ material: 'Unknown type data', required: unknownCount, available: 0 });
    }

    for (const [typeData, requiredCount] of typeDataCounts.entries()) {
      // Query Grundner for available stock (by type_data only)
      const stockResult = await withDb((db) =>
        db
          .select({
            stock: sql<number | null>`MAX(${grundner.stock})`,
            stockAvailable: sql<number | null>`MAX(${grundner.stockAvailable})`
          })
          .from(grundner)
          .where(eq(grundner.typeData, typeData))
      );

      const stockRow = stockResult[0];
      const availableStock = stockRow?.stockAvailable ?? stockRow?.stock ?? 0;

      // Check if there's already locked material for this type
      const alreadyLocked = await withDb(async (db) =>
        db
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(jobs)
          .where(
            and(
              sql`TRIM(COALESCE(${jobs.material}, '')) ~ '^[0-9]+$'`,
              sql`TRIM(${jobs.material})::int = ${typeData}`,
              eq(jobs.isLocked, true),
              not(eq(jobs.status, 'NESTPICK_COMPLETE'))
            )
          )
          .then(rows => rows[0]?.count || 0)
      );

      const effectiveAvailable = availableStock - alreadyLocked;

      if (requiredCount > effectiveAvailable) {
        stockShortfalls.push({
          material: String(typeData),
          required: requiredCount,
          available: effectiveAvailable
        });
      }
    }

    // If there are stock shortfalls, prevent locking and show error
    if (stockShortfalls.length > 0) {
      const shortfallMessages = stockShortfalls.map(s =>
        `Cannot allocate ${s.required} sheets of material ${s.material}. Only ${s.available} available in stock.`
      );
      const message = shortfallMessages.join('\n');

      pushAppMessage(
        'lock.failure',
        {
          count: keys.length,
          reason: 'Insufficient stock available',
          details: message ? `: ${message}` : '',
          userSuffix: formatUserSuffix(session.displayName)
        },
        { source: 'jobs' }
      );

      return err(createAppError('jobs.insufficientStock', message));
    }

    const ncNames = rows.map((row) => {
      const base = row.key.includes('/') ? row.key.substring(row.key.lastIndexOf('/') + 1) : row.key;
      return ensureNcExtension(row.ncfile, base);
    });
    const sampleNcFiles = formatSampleList(ncNames);

    try {
      const result = await placeOrderSawCsv(rows);
      if (!result.confirmed) {
        const action = 'Reserve sheets in Grundner';
        const requestFile = 'order_saw.csv';
        const replyFile = 'order_saw.erl';
        const folder = result.folder;

        const reason = result.checked
          ? 'Grundner confirmation did not match request (.erl mismatch)'
          : 'Timed out waiting for Grundner confirmation (.erl)';

        const detailsLines = [
          `Action: ${action}`,
          `Jobs: ${sampleNcFiles}`,
          `Request: ${requestFile} (saw 0 placeholder)`,
          `Waiting for: ${replyFile}`,
          `Grundner folder: ${folder}`,
          result.checked ? 'Reply was received but did not match the request.' : 'Reply was not received before timeout.'
        ];
        const details = `\n${detailsLines.join('\n')}`;
        pushAppMessage(
          'lock.failure',
          {
            count: keys.length,
            sampleNcFiles,
            reason,
            details,
            userSuffix: formatUserSuffix(session.displayName)
          },
          { source: 'jobs' }
        );
        return err(createAppError('grundner.orderFailed', `${reason}${details}`));
      }

      // Mark locked after Grundner .erl confirmation
      for (const k of keys) {
        await lockJobAfterGrundnerConfirmation(k, session.displayName);
      }
      pushAppMessage(
        'lock.success',
        {
          count: keys.length,
          sampleNcFiles,
          userSuffix: formatUserSuffix(session.displayName)
        },
        { source: 'jobs' }
      );
      return ok<null, AppError>(null);
    } catch (ex) {
      const message = (ex as Error)?.message ?? String(ex);
      pushAppMessage(
        'lock.failure',
        {
          count: keys.length,
          sampleNcFiles,
          reason: message,
          userSuffix: formatUserSuffix(session.displayName)
        },
        { source: 'jobs' }
      );
      return err(createAppError('grundner.orderError', message));
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

  registerResultHandler('jobs:addToWorklist', async (event, raw) => {
    const session = await requireSession(event);
    if (typeof raw !== 'object' || raw === null) {
      return err(createAppError('jobs.invalidArguments', 'Invalid arguments supplied.'));
    }
    const { key, machineId } = raw as { key?: unknown; machineId?: unknown };
    if (typeof key !== 'string' || typeof machineId !== 'number') {
      return err(createAppError('jobs.invalidArguments', 'Invalid arguments supplied.'));
    }
    const result = await addJobToWorklist(key, machineId, session.displayName);
    return ok<WorklistAddResult, AppError>(result);
  });

  registerResultHandler('jobs:rerunAndStage', async (event, raw) => {
    const session = await requireSession(event);
    if (typeof raw !== 'object' || raw === null) {
      return err(createAppError('jobs.invalidArguments', 'Invalid arguments supplied.'));
    }
    const { key, machineId } = raw as { key?: unknown; machineId?: unknown };
    if (typeof key !== 'string' || typeof machineId !== 'number') {
      return err(createAppError('jobs.invalidArguments', 'Invalid arguments supplied.'));
    }
    const result = await rerunAndStage(key, machineId, session.displayName);
    return ok<WorklistAddResult, AppError>(result);
  });

  registerResultHandler('jobs:resync', async () => ok(await ingestProcessedJobsRoot()));
}
