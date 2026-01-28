import { ok, err } from 'neverthrow';
import { inArray } from 'drizzle-orm';
import type { AppError } from '../../../shared/src';
import { jobs } from '../db/schema';
import { withDb } from '../services/db';
import { createAppError } from './errors';
import { placeProductionDeleteCsv } from '../services/productionDelete';
import { pushAppMessage } from '../services/messages';
import { unlockJob } from '../repo/jobsRepo';

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

// Business rule:
// - If the job has already reached LOAD_FINISH or beyond, the sheet is already loaded.
//   There is nothing to "unreserve" in Grundner, so skip writing get_production.csv.
// - For jobs that are still pending/staged/running, Grundner delete expects machine 0.
const SEND_GRUNDNER_DELETE_STATUSES = new Set(['PENDING', 'STAGED', 'RUNNING']);

export async function unlockJobs(keys: string[], actorName?: string | null) {
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
      .select({ key: jobs.key, ncfile: jobs.ncfile, machineId: jobs.machineId, status: jobs.status, isLocked: jobs.isLocked })
      .from(jobs)
      .where(inArray(jobs.key, orderedKeys))
  );
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const missing = orderedKeys.filter((key) => !byKey.has(key));
  if (missing.length) {
    const message = orderedKeys.length === 1 ? 'Job not found.' : `Jobs not found: ${missing.join(', ')}`;
    return err(createAppError('jobs.notFound', message));
  }

  const missingNc = orderedKeys.filter((key) => {
    const row = byKey.get(key);
    return !row || !row.ncfile;
  });
  if (missingNc.length) {
    const message = orderedKeys.length === 1 ? 'Job or NC file not found.' : `NC file not found for: ${missingNc.join(', ')}`;
    return err(createAppError('jobs.notFound', message));
  }

  const ncNames = orderedKeys.map((key) => {
    const row = byKey.get(key)!;
    const base = key.includes('/') ? key.substring(key.lastIndexOf('/') + 1) : key;
    return ensureNcExtension(row.ncfile, base);
  });
  const sampleNcFiles = formatSampleList(ncNames);

  // Only send Grundner delete for jobs that are still "not loaded".
  // Also, use machineId=0 for the delete request (Grundner spec for unreserve).
  const deleteItems = orderedKeys
    .map((key, index) => {
      const row = byKey.get(key)!;
      const status = String(row.status ?? '').toUpperCase();
      if (!row.isLocked) return null;
      if (!SEND_GRUNDNER_DELETE_STATUSES.has(status)) return null;
      return { ncfile: ncNames[index], machineId: 0 };
    })
    .filter((v): v is { ncfile: string; machineId: number } => v !== null);

  if (deleteItems.length) {
    const result = await placeProductionDeleteCsv(deleteItems);
    const suffix = formatUserSuffix(actorName);
    if (!result.confirmed) {
      pushAppMessage(
        'unlock.failure',
        {
          count: orderedKeys.length,
          sampleNcFiles,
          reason: result.message ?? 'Delete not confirmed by Grundner',
          userSuffix: suffix
        },
        { source: 'jobs' }
      );
      return err(createAppError('grundner.deleteFailed', result.message ?? 'Delete not confirmed by Grundner'));
    }
  }

  const failures: string[] = [];
  for (const key of orderedKeys) {
    const success = await unlockJob(key);
    if (!success) failures.push(key);
  }
  const suffix = formatUserSuffix(actorName);
  if (failures.length) {
    const message =
      orderedKeys.length === 1 ? 'Job is not currently locked.' : `Failed to unlock ${failures.length} job(s): ${failures.join(', ')}`;
    pushAppMessage(
      'unlock.failure',
      {
        count: orderedKeys.length,
        sampleNcFiles,
        reason: message,
        userSuffix: suffix
      },
      { source: 'jobs' }
    );
    return err(createAppError('jobs.notLocked', message));
  }
  pushAppMessage(
    'unlock.success',
    {
      count: orderedKeys.length,
      sampleNcFiles,
      userSuffix: suffix
    },
    { source: 'jobs' }
  );
  return ok<null, AppError>(null);
}
