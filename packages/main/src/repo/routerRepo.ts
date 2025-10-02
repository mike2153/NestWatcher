import { withClient } from '../services/db';
import type { QueryResult } from 'pg';

type SqlParam = string | number | boolean | null | Date;

type RouterJobRowDb = {
  key: string;
  folder: string | null;
  ncfile: string | null;
  material: string | null;
  status: string;
  machineId: number | null;
  stagedAt: Date | null;
  cutAt: Date | null;
  nestpickCompletedAt: Date | null;
  updatedAt: Date | null;
  pallet: string | null;
  lastError: string | null;
};

export async function listMachineJobs(options: { machineId?: number; statusIn?: string[]; limit?: number } = {}) {
  const params: SqlParam[] = [];
  const where: string[] = [];

  if (options.machineId != null) {
    params.push(options.machineId);
    where.push(`machine_id = $${params.length}`);
  }
  if (options.statusIn && options.statusIn.length) {
    const idxStart = params.length + 1;
    const placeholders = options.statusIn.map((_, i) => `$${idxStart + i}`).join(',');
    params.push(...options.statusIn);
    where.push(`status IN (${placeholders})`);
  }

  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
  params.push(limit);

  const sql = `
    SELECT key,
           folder,
           ncfile,
           material,
           status,
           machine_id AS "machineId",
           staged_at AS "stagedAt",
           cut_at AS "cutAt",
           nestpick_completed_at AS "nestpickCompletedAt",
           updated_at AS "updatedAt",
           pallet,
           last_error AS "lastError"
    FROM public.machine_jobs
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY updated_at DESC NULLS LAST, key DESC
    LIMIT $${params.length}
  `;
  const rows = await withClient<RouterJobRowDb[]>((c) =>
    c.query<RouterJobRowDb>(sql, params).then((r: QueryResult<RouterJobRowDb>) => r.rows)
  );

  return rows.map((row) => ({
    key: row.key,
    folder: row.folder,
    ncfile: row.ncfile,
    material: row.material,
    status: row.status,
    machineId: row.machineId,
    stagedAt: row.stagedAt ? new Date(row.stagedAt).toISOString() : null,
    cutAt: row.cutAt ? new Date(row.cutAt).toISOString() : null,
    nestpickCompletedAt: row.nestpickCompletedAt ? new Date(row.nestpickCompletedAt).toISOString() : null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    pallet: row.pallet,
    lastError: row.lastError
  }));
}
