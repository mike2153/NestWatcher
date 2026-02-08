import { and, asc, desc, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import type { JobStatus, JobsFilterOptions, JobsListReq } from '../../../shared/src';
import { appendJobEvent } from './jobEventsRepo';

import { withDb, type AppDb } from '../services/db';
import { grundner, jobs, jobEvents } from '../db/schema';

type SqlExpression = NonNullable<SQL>;

type LifecycleUpdateOptions = {
  machineId?: number | null;
  source?: string;
  payload?: unknown;
  actorName?: string | null;
};

type LifecycleUpdateResult =
  | {
      ok: true;
      status: JobStatus;
      previousStatus: JobStatus;
      machineId: number | null;
      stagedAt: string | null;
      cutAt: string | null;
      nestpickCompletedAt: string | null;
      updatedAt: string | null;
    }
  | { ok: false; reason: 'NOT_FOUND' }
  | { ok: false; reason: 'INVALID_TRANSITION'; previousStatus: JobStatus }
  | {
      ok: false;
      reason: 'NO_CHANGE';
      previousStatus: JobStatus;
      stagedAt: string | null;
      cutAt: string | null;
      nestpickCompletedAt: string | null;
      updatedAt: string | null;
    };

type JobLookupRow = {
  key: string;
  folder: string | null;
  ncfile: string | null;
  machineId: number | null;
  status: JobStatus;
  isLocked: boolean;
};

const ALLOWED_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  PENDING: ['PENDING'],
  STAGED: ['PENDING', 'STAGED'],
  RUNNING: ['STAGED', 'RUNNING'],
  LOAD_FINISH: ['PENDING', 'STAGED', 'RUNNING', 'LOAD_FINISH'],
  LABEL_FINISH: ['STAGED', 'RUNNING', 'LOAD_FINISH', 'LABEL_FINISH'],
  CNC_FINISH: ['STAGED', 'RUNNING', 'LOAD_FINISH', 'LABEL_FINISH', 'CNC_FINISH'],
  FORWARDED_TO_NESTPICK: ['CNC_FINISH', 'FORWARDED_TO_NESTPICK'],
  NESTPICK_COMPLETE: ['FORWARDED_TO_NESTPICK', 'NESTPICK_COMPLETE']
};

const RESETTABLE_STATUSES: JobStatus[] = ['CNC_FINISH', 'FORWARDED_TO_NESTPICK', 'NESTPICK_COMPLETE'];

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function combineClauses(clauses: SqlExpression[]): SqlExpression {
  if (clauses.length === 0) return sql`true`;
  if (clauses.length === 1) return clauses[0];
  const [first, second, ...rest] = clauses as [SqlExpression, SqlExpression, ...SqlExpression[]];
  const initial = and(first, second) as SqlExpression;
  return rest.reduce<SqlExpression>((acc, clause) => and(acc, clause) as SqlExpression, initial);
}

export async function listJobFilters(): Promise<JobsFilterOptions> {
  return withDb(async (db) => {
    const materialsRes = await db
      .selectDistinct({ material: jobs.material })
      .from(jobs)
      .where(sql`TRIM(COALESCE(${jobs.material}, '')) <> ''`)
      .orderBy(asc(jobs.material));

    const statusesRes = await db
      .selectDistinct({ status: jobs.status })
      .from(jobs)
      .orderBy(asc(jobs.status));

    const materials = materialsRes
      .map((row) => row.material?.trim())
      .filter((value): value is string => !!value);

    const statuses = statusesRes.map((row) => row.status as JobStatus);

    return { materials, statuses };
  });
}

export async function listJobs(req: JobsListReq) {
  const { search, sortBy, sortDir, limit, cursor, filter, hideCompletedFolders } = req;
  const safeLimit = Math.max(1, Math.min(limit ?? 50, 200));

  const conditions: SqlExpression[] = [];

  if (filter.folder) {
    conditions.push(eq(jobs.folder, filter.folder));
  }
  if (filter.material) {
    conditions.push(eq(jobs.material, filter.material));
  }
  if (filter.materialIn && filter.materialIn.length) {
    conditions.push(inArray(jobs.material, filter.materialIn));
  }
  if (filter.size) {
    conditions.push(eq(jobs.size, filter.size));
  }
  if (filter.thickness) {
    conditions.push(eq(jobs.thickness, filter.thickness));
  }
  if (filter.status && filter.status !== 'all') {
    if (filter.status === 'cut') conditions.push(sql`${jobs.cutAt} IS NOT NULL`);
    if (filter.status === 'uncut') conditions.push(sql`${jobs.cutAt} IS NULL`);
  }
  if (filter.statusIn && filter.statusIn.length) {
    conditions.push(inArray(jobs.status, filter.statusIn as JobStatus[]));
  }
  if (filter.machineId != null) {
    conditions.push(eq(jobs.machineId, filter.machineId));
  }

  // Jobs table requirement: hide completed jobs, but only after the entire folder group is complete.
  // Folder group is job.folder.
  if (hideCompletedFolders) {
    conditions.push(
      sql`(
        ${jobs.folder} IS NULL OR
        ${jobs.folder} NOT IN (
          SELECT j2.folder
          FROM public.jobs j2
          LEFT JOIN public.machines m2 ON m2.machine_id = j2.machine_id
          WHERE j2.folder IS NOT NULL
          GROUP BY j2.folder
          HAVING bool_and(
            CASE
              WHEN COALESCE(m2.nestpick_enabled, false) THEN j2.status = 'NESTPICK_COMPLETE'::public.job_status
              ELSE j2.status IN ('CNC_FINISH'::public.job_status, 'FORWARDED_TO_NESTPICK'::public.job_status, 'NESTPICK_COMPLETE'::public.job_status)
            END
          )
        )
      )`
    );
  }
  // Filter completed jobs by timeframe
  if (filter.completedTimeframe && filter.completedTimeframe !== 'all') {
    const now = new Date();
    let cutoffDate: Date;
    switch (filter.completedTimeframe) {
      case '1day':
        cutoffDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case '3days':
        cutoffDate = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
        break;
      case '7days':
        cutoffDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '1month':
        cutoffDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      default:
        cutoffDate = new Date(0); // No filter
    }
    // Only apply timeframe filter to completed jobs
    conditions.push(
      sql`(${jobs.status} <> 'NESTPICK_COMPLETE' OR ${jobs.nestpickCompletedAt} >= ${cutoffDate.toISOString()})`
    );
  }
  if (search && search.trim()) {
    const term = `%${search.trim()}%`;
    conditions.push(
      sql`(${jobs.folder} ILIKE ${term} OR ${jobs.ncfile} ILIKE ${term} OR ${jobs.material} ILIKE ${term} OR ${jobs.parts} ILIKE ${term} OR ${jobs.size} ILIKE ${term} OR ${jobs.thickness} ILIKE ${term} OR ${jobs.dateAdded}::text ILIKE ${term})`
    );
  }
  if (cursor) {
    conditions.push(lt(jobs.key, cursor));
  }

  const orderColumn = (() => {
    switch (sortBy) {
      case 'folder':
        return jobs.folder;
      case 'ncfile':
        return jobs.ncfile;
      case 'material':
        return jobs.material;
      case 'parts':
        return jobs.parts;
      case 'size':
        return jobs.size;
      case 'thickness':
        return jobs.thickness;
      case 'locked':
        return jobs.isLocked;
      case 'dateadded':
      default:
        return jobs.dateAdded;
    }
  })();

  const orderFn = sortDir === 'asc' ? asc : desc;

  const rows = await withDb((db) => {
    const baseQuery = db
      .select({
        key: jobs.key,
        folder: jobs.folder,
        ncfile: jobs.ncfile,
        material: jobs.material,
        parts: jobs.parts,
        size: jobs.size,
        thickness: jobs.thickness,
        dateAdded: jobs.dateAdded,
        isLocked: jobs.isLocked,
        status: jobs.status,
        machineId: jobs.machineId,
        stagedAt: jobs.stagedAt,
        allocatedAt: jobs.allocatedAt,
        lockedBy: jobs.lockedBy,
        stagedBy: jobs.stagedBy,
        processingSeconds: sql<number | null>`CASE 
          WHEN ${jobs.nestpickCompletedAt} IS NULL OR ${jobs.stagedAt} IS NULL THEN NULL
          ELSE EXTRACT(EPOCH FROM (${jobs.nestpickCompletedAt} - ${jobs.stagedAt}))::int
        END`
      })
      .from(jobs);

    const whereClause = combineClauses(conditions);

    const filteredQuery = baseQuery.where(whereClause);

    return filteredQuery.orderBy(orderFn(orderColumn), desc(jobs.key)).limit(safeLimit + 1);
  });

  const items = rows.slice(0, safeLimit).map((row) => ({
    key: row.key,
    folder: row.folder,
    ncfile: row.ncfile,
    material: row.material,
    parts: row.parts,
    size: row.size,
    thickness: row.thickness,
    dateadded: row.dateAdded ? row.dateAdded.toISOString() : null,
    locked: !!row.isLocked,
    status: row.status as JobStatus,
    machineId: row.machineId ?? null,
    processingSeconds: row.processingSeconds ?? null,
    stagedAt: row.stagedAt ? row.stagedAt.toISOString() : null,
    allocatedAt: row.allocatedAt ? row.allocatedAt.toISOString() : null,
    lockedBy: row.lockedBy ?? null,
    stagedBy: row.stagedBy ?? null
  }));

  const nextCursor = rows.length > safeLimit ? rows[safeLimit].key : null;
  return { items, nextCursor };
}

export async function lockJob(key: string, actor?: string) {
  const actorName = actor?.trim() || null;
  return withDb((db) =>
    db.transaction(async (tx) => {
      const updated = await tx
        .update(jobs)
        .set({
          isLocked: true,
          lockedBy: actorName,
          updatedAt: sql<Date>`now()` as unknown as Date,
          allocatedAt: sql<Date>`CASE WHEN ${jobs.allocatedAt} IS NULL THEN now() ELSE ${jobs.allocatedAt} END` as unknown as Date
        })
        // Only allow manual locking when not already locked and status is PENDING
        .where(and(eq(jobs.key, key), eq(jobs.isLocked, false), eq(jobs.status, 'PENDING')))
        .returning({ key: jobs.key, material: jobs.material });

      if (!updated.length) {
        return false;
      }
      return true;
    })
  );
}

// Use ONLY after Grundner .erl confirmation to enforce lock regardless of status.
// This prevents generic UI/manual locking of STAGED jobs but still locks when
// we have a positive confirmation from Grundner.
export async function lockJobAfterGrundnerConfirmation(key: string, actor?: string) {
  const actorName = actor?.trim() || null;
  return withDb((db) =>
    db.transaction(async (tx) => {
      const updated = await tx
        .update(jobs)
        .set({
          isLocked: true,
          lockedBy: actorName,
          updatedAt: sql<Date>`now()` as unknown as Date,
          allocatedAt: sql<Date>`CASE WHEN ${jobs.allocatedAt} IS NULL THEN now() ELSE ${jobs.allocatedAt} END` as unknown as Date
        })
        .where(and(eq(jobs.key, key), eq(jobs.isLocked, false)))
        .returning({ key: jobs.key, material: jobs.material });

      if (!updated.length) {
        return false;
      }
      return true;
    })
  );
}

export async function unlockJob(key: string) {
  return withDb((db) =>
    db.transaction(async (tx) => {
      const updated = await tx
        .update(jobs)
        .set({
          isLocked: false,
          lockedBy: null,
          updatedAt: sql<Date>`now()` as unknown as Date,
          allocatedAt: null
        })
        .where(and(eq(jobs.key, key), eq(jobs.isLocked, true)))
        .returning({ key: jobs.key });

      if (!updated.length) {
        return false;
      }

      return true;
    })
  );
}

export async function findJobByNcBase(base: string): Promise<JobLookupRow | null> {
  // Accept only two case-insensitive variants: "sheet1" or "sheet1.nc"
  const baseLower = base.trim().toLowerCase();
  const withoutExt = baseLower.replace(/\.nc$/i, '');

  const selectCols = {
    key: jobs.key,
    folder: jobs.folder,
    ncfile: jobs.ncfile,
    machineId: jobs.machineId,
    status: jobs.status,
    isLocked: jobs.isLocked
  };

  const rows = await withDb((db) =>
    db
      .select(selectCols)
      .from(jobs)
      .where(
        or(
          sql`LOWER(${jobs.ncfile}) = ${withoutExt}`,
          sql`LOWER(${jobs.ncfile}) = ${withoutExt} || '.nc'`
        )
      )
      .orderBy(desc(jobs.updatedAt))
      .limit(1)
  );

  if (!rows.length) return null;
  const row = rows[0];
  return {
    key: row.key,
    folder: row.folder,
    ncfile: row.ncfile,
    machineId: row.machineId ?? null,
    status: row.status as JobStatus,
    isLocked: !!row.isLocked
  };
}

export async function findJobByNcBasePreferStatus(base: string, preferred: string[]): Promise<JobLookupRow | null> {
  const baseLower = base.toLowerCase();
  const withoutExt = baseLower.replace(/\.nc$/i, '');

  const selectCols = {
    key: jobs.key,
    folder: jobs.folder,
    ncfile: jobs.ncfile,
    machineId: jobs.machineId,
    status: jobs.status,
    isLocked: jobs.isLocked
  };

  // First try: only jobs whose status is in preferred list
  if (preferred.length > 0) {
    const preferredTyped = preferred as readonly JobStatus[];
    const rows = await withDb((db) =>
      db
        .select(selectCols)
        .from(jobs)
        .where(
          and(
            inArray(jobs.status, preferredTyped),
            or(sql`LOWER(${jobs.ncfile}) = ${withoutExt}`, sql`LOWER(${jobs.ncfile}) = ${withoutExt} || '.nc'`)
          )
        )
        .orderBy(desc(jobs.updatedAt))
        .limit(1)
    );
    if (rows.length) {
      const row = rows[0];
      return {
        key: row.key,
        folder: row.folder,
        ncfile: row.ncfile,
        machineId: row.machineId ?? null,
        status: row.status as JobStatus,
        isLocked: !!row.isLocked
      };
    }
  }

  // Fallback to the generic lookup
  return findJobByNcBase(base);
}

export async function findJobByNcBaseMachinePreferStatus(
  base: string,
  machineId: number,
  preferred: string[]
): Promise<JobLookupRow | null> {
  const baseLower = base.toLowerCase();
  const withoutExt = baseLower.replace(/\.nc$/i, '');

  const selectCols = {
    key: jobs.key,
    folder: jobs.folder,
    ncfile: jobs.ncfile,
    machineId: jobs.machineId,
    status: jobs.status,
    isLocked: jobs.isLocked
  };

  if (preferred.length > 0) {
    const preferredTyped = preferred as readonly JobStatus[];
    const rows = await withDb((db) =>
      db
        .select(selectCols)
        .from(jobs)
        .where(
          and(
            eq(jobs.machineId, machineId),
            inArray(jobs.status, preferredTyped),
            or(sql`LOWER(${jobs.ncfile}) = ${withoutExt}`, sql`LOWER(${jobs.ncfile}) = ${withoutExt} || '.nc'`)
          )
        )
        .orderBy(desc(jobs.updatedAt))
        .limit(1)
    );
    if (rows.length) {
      const row = rows[0];
      return {
        key: row.key,
        folder: row.folder,
        ncfile: row.ncfile,
        machineId: row.machineId ?? null,
        status: row.status as JobStatus,
        isLocked: !!row.isLocked
      };
    }
  }

  const rows = await withDb((db) =>
    db
      .select(selectCols)
      .from(jobs)
      .where(
        and(
          eq(jobs.machineId, machineId),
          or(sql`LOWER(${jobs.ncfile}) = ${withoutExt}`, sql`LOWER(${jobs.ncfile}) = ${withoutExt} || '.nc'`)
        )
      )
      .orderBy(desc(jobs.updatedAt))
      .limit(1)
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    key: row.key,
    folder: row.folder,
    ncfile: row.ncfile,
    machineId: row.machineId ?? null,
    status: row.status as JobStatus,
    isLocked: !!row.isLocked
  };
}

export type JobDetails = {
  key: string;
  status: JobStatus;
  material: string | null;
  size: string | null;
  parts: string | null;
  thickness: string | null;
  dateadded: string | null; // ISO
};

export async function findJobDetailsByNcBase(base: string): Promise<JobDetails | null> {
  const normalized = base.replace(/\.nc$/i, '');
  const selectCols = {
    key: jobs.key,
    status: jobs.status,
    material: jobs.material,
    size: jobs.size,
    parts: jobs.parts,
    thickness: jobs.thickness,
    dateAdded: jobs.dateAdded
  };

  const rows = await withDb((db) =>
    db
      .select(selectCols)
      .from(jobs)
      .where(
        or(
          sql`LOWER(${jobs.ncfile}) = LOWER(${normalized})`,
          sql`LOWER(${jobs.ncfile}) = LOWER(${normalized} || '.nc')`,
          sql`LOWER(${jobs.key}) = LOWER(${normalized})`,
          sql`LOWER(${jobs.key}) = LOWER(${normalized} || '.nc')`
        )
      )
      .orderBy(desc(jobs.updatedAt))
      .limit(1)
  );

  if (!rows.length) return null;
  const row = rows[0];
  return {
    key: row.key,
    status: row.status as JobStatus,
    material: row.material ?? null,
    size: row.size ?? null,
    parts: row.parts ?? null,
    thickness: row.thickness ?? null,
    dateadded: row.dateAdded ? row.dateAdded.toISOString() : null
  };
}

export async function resetJobForRestage(
  key: string
): Promise<{ reset: boolean; iteration?: number; previousStatus?: JobStatus }> {
  return withDb((db) =>
    db.transaction(async (tx) => {
      const rows = await tx
        .select({
          status: jobs.status,
          machineId: jobs.machineId,
          stagedAt: jobs.stagedAt,
          cutAt: jobs.cutAt,
          nestpickCompletedAt: jobs.nestpickCompletedAt,
          pallet: jobs.pallet
        })
        .from(jobs)
        .where(eq(jobs.key, key))
        .for('update')
        .limit(1);

      if (!rows.length) {
        return { reset: false };
      }

      const current = rows[0];
      const currentStatus = current.status as JobStatus;
      if (!RESETTABLE_STATUSES.includes(currentStatus)) {
        return { reset: false };
      }

      const dbNow = sql<Date>`now()`;
      await tx
        .update(jobs)
        .set({
          status: 'PENDING',
          machineId: null,
          stagedAt: null,
          cutAt: null,
          nestpickCompletedAt: null,
          pallet: null,
          updatedAt: dbNow as unknown as Date
        })
        .where(eq(jobs.key, key));

      const resetCountRows = await tx
        .select({ count: sql<number>`count(*)` })
        .from(jobEvents)
        .where(and(eq(jobEvents.key, key), eq(jobEvents.eventType, 'job:restage:reset')));

      const previousResets = Number(resetCountRows[0]?.count ?? 0);
      const iteration = previousResets + 1;

      await appendJobEvent(
        key,
        'job:restage:reset',
        {
          iteration,
          previousStatus: currentStatus,
          previousMachineId: current.machineId ?? null,
          previousStagedAt: toIso(current.stagedAt),
          previousCutAt: toIso(current.cutAt),
          previousNestpickCompletedAt: toIso(current.nestpickCompletedAt),
          previousPallet: current.pallet ?? null
        },
        current.machineId ?? null,
        tx
      );

      return { reset: true, iteration, previousStatus: currentStatus };
    })
  );
}

export async function updateLifecycle(
  key: string,
  to: JobStatus,
  options: LifecycleUpdateOptions = {}
): Promise<LifecycleUpdateResult> {
  return withDb((db) =>
    db.transaction(async (tx) => {
      const currentRows = await tx
        .select({
          status: jobs.status,
          machineId: jobs.machineId,
          stagedAt: jobs.stagedAt,
          stagedBy: jobs.stagedBy,
          cutAt: jobs.cutAt,
          nestpickCompletedAt: jobs.nestpickCompletedAt,
          updatedAt: jobs.updatedAt,
          isLocked: jobs.isLocked,
          material: jobs.material,
          ncfile: jobs.ncfile
        })
        .from(jobs)
        .where(eq(jobs.key, key))
        .for('update')
        .limit(1);

      if (!currentRows.length) {
        return { ok: false, reason: 'NOT_FOUND' };
      }

      const current = currentRows[0];
      const previousStatus = current.status as JobStatus;
      const currentStagedAt = toIso(current.stagedAt);
      const currentCutAt = toIso(current.cutAt);
      const currentNestpickAt = toIso(current.nestpickCompletedAt);
      const currentUpdatedAt = toIso(current.updatedAt);

      const isAutoPacNestpickBypassCompletion = (() => {
        if (to !== 'NESTPICK_COMPLETE') return false;
        if (previousStatus !== 'CNC_FINISH') return false;
        if (options.source !== 'autopac') return false;
        if (!options.payload || typeof options.payload !== 'object') return false;
        const payload = options.payload as Record<string, unknown>;
        return payload.nestpickBypass === true;
      })();

      if (!ALLOWED_TRANSITIONS[to].includes(previousStatus) && !isAutoPacNestpickBypassCompletion) {
        return { ok: false, reason: 'INVALID_TRANSITION', previousStatus };
      }

      const patch: Partial<typeof jobs.$inferInsert> = {};
      const dbNow = sql<Date>`now()`;
      let touched = false;

      if (previousStatus !== to) {
        patch.status = to;
        touched = true;
      }

      // Manual status changes from the Router page should be recorded on the job row
      // so operators can see a quick history without digging through job_events.
      const manualReason = (() => {
        if (options.source !== 'router-manual') return null;
        if (!options.payload || typeof options.payload !== 'object') return null;
        const anyPayload = options.payload as Record<string, unknown>;
        const reason = typeof anyPayload.reason === 'string' ? anyPayload.reason.trim() : '';
        return reason ? reason : null;
      })();

      if (manualReason && previousStatus !== to) {
        const actor = options.actorName?.trim() || null;
        patch.manualLifecycle = sql`
          COALESCE(${jobs.manualLifecycle}, '[]'::jsonb)
          || jsonb_build_array(
            jsonb_build_object(
              'at', now(),
              'actor', ${actor},
              'from', ${previousStatus},
              'to', ${to},
              'reason', ${manualReason}
            )
          )
        `;
        touched = true;
      }

      if ((to === 'STAGED' || to === 'LOAD_FINISH' || to === 'LABEL_FINISH') && !current.stagedAt) {
        patch.stagedAt = dbNow as unknown as Date;
        touched = true;
      }
      if (to === 'STAGED') {
        patch.stagedBy = options.actorName?.trim() || currentRows[0].stagedBy || null;
      } else if ((previousStatus as string) === 'STAGED' && (to as string) !== 'STAGED') {
        patch.stagedBy = null;
      }

      if (to === 'CNC_FINISH' && !current.cutAt) {
        patch.cutAt = dbNow as unknown as Date;
        touched = true;
      }

      if (to === 'NESTPICK_COMPLETE' && !current.nestpickCompletedAt) {
        patch.nestpickCompletedAt = dbNow as unknown as Date;
        touched = true;
      }

      let nextMachineId = current.machineId ?? null;
      if (Object.prototype.hasOwnProperty.call(options, 'machineId') && options.machineId !== current.machineId) {
        nextMachineId = options.machineId ?? null;
        patch.machineId = nextMachineId;
        touched = true;
      }

      // Enforce business rules:
      // - On LOAD_FINISH: clear lock (stock has been removed from Grundner)
      if (to === 'LOAD_FINISH' && current.isLocked) {
        patch.isLocked = false;
        touched = true;
      }

      if (!touched) {
        return {
          ok: false,
          reason: 'NO_CHANGE',
          previousStatus,
          stagedAt: currentStagedAt,
          cutAt: currentCutAt,
          nestpickCompletedAt: currentNestpickAt,
          updatedAt: currentUpdatedAt
        };
      }

      patch.updatedAt = dbNow as unknown as Date;

      const updatedRows = await tx
        .update(jobs)
        .set(patch)
        .where(eq(jobs.key, key))
        .returning({
          status: jobs.status,
          machineId: jobs.machineId,
          stagedAt: jobs.stagedAt,
          cutAt: jobs.cutAt,
          nestpickCompletedAt: jobs.nestpickCompletedAt,
          updatedAt: jobs.updatedAt
        });

      if (!updatedRows.length) {
        return { ok: false, reason: 'NOT_FOUND' };
      }

      const updated = updatedRows[0];
      const newStatus = updated.status as JobStatus;
      const machineId = updated.machineId ?? null;
      const stagedAtIso = toIso(updated.stagedAt);
      const cutAtIso = toIso(updated.cutAt);
      const nestpickCompletedAtIso = toIso(updated.nestpickCompletedAt);
      const updatedAtIso = toIso(updated.updatedAt);

      const eventPayload: Record<string, unknown> = {
        from: previousStatus,
        to: newStatus
      };
      if (machineId !== null) {
        eventPayload.machineId = machineId;
      }
      if (options.source) {
        eventPayload.source = options.source;
      }
      if (options.payload !== undefined) {
        eventPayload.payload = options.payload;
      }

      // On completion, increment qty on the original (base) job
      if (to === 'NESTPICK_COMPLETE') {
        const base = (current.ncfile ?? '').replace(/^run\d+_/i, '');
        if (base) {
          const lastSlash = key.lastIndexOf('/');
          const relFolder = lastSlash >= 0 ? key.slice(0, lastSlash) : '';
          const originalKey = (relFolder ? `${relFolder}/${base}` : base).slice(0, 100);
          await tx
            .execute(sql`UPDATE public.jobs SET qty = COALESCE(qty, 0) + 1, updated_at = now() WHERE key = ${originalKey}`);
        }
      }

      await appendJobEvent(key, `status:${newStatus}`, eventPayload, machineId, tx);

      return {
        ok: true,
        status: newStatus,
        previousStatus,
        machineId,
        stagedAt: stagedAtIso,
        cutAt: cutAtIso,
        nestpickCompletedAt: nestpickCompletedAtIso,
        updatedAt: updatedAtIso
      };
    })
  );
}

export async function updateJobPallet(key: string, pallet: string | null) {
  const updated = await withDb((db) =>
    db
      .update(jobs)
      .set({ pallet, updatedAt: sql<Date>`now()` as unknown as Date })
      .where(eq(jobs.key, key))
      .returning({ key: jobs.key })
  );

  return updated.length > 0;
}
