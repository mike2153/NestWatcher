import { ok, err } from 'neverthrow';
import type { AppError, WorklistAddResult } from '../../../shared/src';
import { JobEventsReq, JobsListReq, ReserveReq, UnreserveReq } from '../../../shared/src';
import { getJobEvents } from '../repo/jobEventsRepo';
import { listJobFilters, listJobs, reserveJob, unreserveJob } from '../repo/jobsRepo';
import { addJobToWorklist } from '../services/worklist';
import { ingestProcessedJobsRoot } from '../services/ingest';
import { createAppError } from './errors';
import { registerResultHandler } from './result';

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

  registerResultHandler('jobs:resync', async () => ok(await ingestProcessedJobsRoot()));
}
