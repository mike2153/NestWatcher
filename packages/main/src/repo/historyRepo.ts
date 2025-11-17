import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { jobEvents, jobs, machines } from '../db/schema';
import { withDb } from '../services/db';
import type { HistoryListReq, HistoryRow, JobTimelineEvent, JobTimelineRes } from '../../../shared/src';

type SqlExpression = NonNullable<SQL>;

const FINISH_EXPR = sql<Date | null>`CASE WHEN COALESCE(${machines.nestpickEnabled}, FALSE) THEN ${jobs.nestpickCompletedAt} ELSE ${jobs.cutAt} END`;

type HistoryRowDb = {
  key: string;
  folder: string | null;
  ncfile: string | null;
  material: string | null;
  machineId: number | null;
  machineName: string | null;
  machineNestpickEnabled: boolean | null;
  status: string;
  stagedAt: Date | null;
  cutAt: Date | null;
  nestpickCompletedAt: Date | null;
  finishAtRaw: Date | null;
  pallet: string | null;
  updatedAt: Date | null;
  dateAdded: Date | null;
};

type JobDetailRowDb = {
  key: string;
  folder: string | null;
  ncfile: string | null;
  material: string | null;
  machineId: number | null;
  machineName: string | null;
  machineNestpickEnabled: boolean | null;
  status: string;
  dateAdded: Date | null;
  stagedAt: Date | null;
  cutAt: Date | null;
  nestpickCompletedAt: Date | null;
  finishAtRaw: Date | null;
  pallet: string | null;
  updatedAt: Date | null;
};

type JobEventRowDb = {
  eventType: string;
  createdAt: Date | null;
  machineId: number | null;
  machineName: string | null;
  payload: unknown | null;
};

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

export async function listHistory(req: HistoryListReq): Promise<HistoryRow[]> {
  const { limit, machineId, search, from, to } = req;
  const safeLimit = Math.max(1, Math.min(limit ?? 100, 200));

  const conditions: SqlExpression[] = [];

  if (machineId != null) {
    conditions.push(eq(jobs.machineId, machineId));
  }

  if (search && search.trim()) {
    const term = `%${search.trim()}%`;
    conditions.push(
      sql`(${jobs.key} ILIKE ${term} OR ${jobs.ncfile} ILIKE ${term} OR ${jobs.folder} ILIKE ${term} OR ${jobs.material} ILIKE ${term})`
    );
  }

  if (from) {
    const fromDate = new Date(from);
    if (!Number.isNaN(fromDate.getTime())) {
      conditions.push(sql`${FINISH_EXPR} >= ${fromDate.toISOString()}`);
    }
  }

  if (to) {
    const toDate = new Date(to);
    if (!Number.isNaN(toDate.getTime())) {
      conditions.push(sql`${FINISH_EXPR} <= ${toDate.toISOString()}`);
    }
  }

  const rows = await withDb((db) => {
    const baseQuery = db
      .select({
        key: jobs.key,
        folder: jobs.folder,
        ncfile: jobs.ncfile,
        material: jobs.material,
        machineId: jobs.machineId,
        machineName: machines.name,
        machineNestpickEnabled: machines.nestpickEnabled,
        status: jobs.status,
        stagedAt: jobs.stagedAt,
        cutAt: jobs.cutAt,
        nestpickCompletedAt: jobs.nestpickCompletedAt,
        pallet: jobs.pallet,
        updatedAt: jobs.updatedAt,
        dateAdded: jobs.dateAdded,
        finishAtRaw: FINISH_EXPR
      })
      .from(jobs)
      .leftJoin(machines, eq(jobs.machineId, machines.machineId));

    const whereClause = combineClauses([sql`${FINISH_EXPR} IS NOT NULL`, ...conditions]);

    const filteredQuery = baseQuery.where(whereClause);

    return filteredQuery.orderBy(sql`${FINISH_EXPR} DESC`).limit(safeLimit);
  }) as HistoryRowDb[];

  return rows.map((row: HistoryRowDb) => {
    const finishAtIso = toIso(row.finishAtRaw);
    if (!finishAtIso) {
      throw new Error(`History row missing finish timestamp for job ${row.key}`);
    }
    const machineNestpickEnabled = row.machineNestpickEnabled ?? null;
    const finishSource: HistoryRow['finishSource'] = machineNestpickEnabled ? 'nestpick' : 'cut';
    return {
      key: row.key,
      folder: row.folder,
      ncfile: row.ncfile,
      material: row.material,
      machineId: row.machineId,
      machineName: row.machineName,
      machineNestpickEnabled,
      status: row.status as HistoryRow['status'],
      stagedAt: toIso(row.stagedAt),
      cutAt: toIso(row.cutAt),
      nestpickCompletedAt: toIso(row.nestpickCompletedAt),
      finishAt: finishAtIso,
      finishSource,
      pallet: row.pallet,
      updatedAt: toIso(row.updatedAt)
    };
  });
}

export async function getJobTimeline(key: string): Promise<JobTimelineRes | null> {
  const jobRow = (await withDb((db) =>
    db
      .select({
        key: jobs.key,
        folder: jobs.folder,
        ncfile: jobs.ncfile,
        material: jobs.material,
        machineId: jobs.machineId,
        machineName: machines.name,
        machineNestpickEnabled: machines.nestpickEnabled,
        status: jobs.status,
        dateAdded: jobs.dateAdded,
        stagedAt: jobs.stagedAt,
        cutAt: jobs.cutAt,
        nestpickCompletedAt: jobs.nestpickCompletedAt,
        finishAtRaw: FINISH_EXPR,
        pallet: jobs.pallet,
        updatedAt: jobs.updatedAt
      })
      .from(jobs)
      .leftJoin(machines, eq(jobs.machineId, machines.machineId))
      .where(eq(jobs.key, key))
      .limit(1)
  )) as JobDetailRowDb[];

  if (!jobRow.length) return null;

  const detail: JobDetailRowDb = jobRow[0];

  const eventRows = (await withDb((db) =>
    db
      .select({
        eventType: jobEvents.eventType,
        createdAt: jobEvents.createdAt,
        machineId: jobEvents.machineId,
        machineName: machines.name,
        payload: jobEvents.payload
      })
      .from(jobEvents)
      .leftJoin(machines, eq(jobEvents.machineId, machines.machineId))
      .where(eq(jobEvents.key, key))
      .orderBy(asc(jobEvents.createdAt), asc(jobEvents.eventId))
  )) as JobEventRowDb[];

  const machineNestpickEnabled = detail.machineNestpickEnabled ?? null;
  const finishAtIso = toIso(detail.finishAtRaw);
  const usedNestpick = Boolean(machineNestpickEnabled && detail.nestpickCompletedAt);
  const finishSource: JobTimelineRes['job']['finishSource'] = finishAtIso
    ? usedNestpick ? 'nestpick' : 'cut'
    : 'pending';

  const events: JobTimelineEvent[] = eventRows.map((row, index) => ({
    id: `${key}:${row.eventType}:${row.createdAt ? toIso(row.createdAt) : index}`,
    eventType: row.eventType,
    createdAt: toIso(row.createdAt),
    machineId: row.machineId,
    machineName: row.machineName,
    payload: row.payload ?? null
  }));

  return {
    job: {
      key: detail.key,
      folder: detail.folder,
      ncfile: detail.ncfile,
      material: detail.material,
      machineId: detail.machineId,
      machineName: detail.machineName,
      machineNestpickEnabled,
      status: detail.status as JobTimelineRes['job']['status'],
      dateadded: toIso(detail.dateAdded),
      stagedAt: toIso(detail.stagedAt),
      cutAt: toIso(detail.cutAt),
      nestpickCompletedAt: toIso(detail.nestpickCompletedAt),
      finishAt: finishAtIso,
      finishSource,
      pallet: detail.pallet,
      updatedAt: toIso(detail.updatedAt)
    },
    events
  };
}





