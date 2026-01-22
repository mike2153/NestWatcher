import type { PoolClient } from 'pg';
import type { AllocatedMaterialRow } from '../../../shared/src';
import { withClient } from '../services/db';

type AllocatedMaterialDb = {
  grundner_id: number | null;
  type_data: number | null;
  customer_id: string | null;
  length_mm: number | null;
  width_mm: number | null;
  thickness_mm: number | null;
  stock: number | null;
  stock_available: number | null;
  reserved_stock: number | null;
  pre_reserved: number | null;
  job_key: string;
  folder: string | null;
  ncfile: string | null;
  material: string | null;
  job_pre_reserved: boolean;
  job_is_locked: boolean;
  updated_at: Date | null;
  allocated_at: Date | null;
  allocation_status: string;
};

function mapAllocated(row: AllocatedMaterialDb): AllocatedMaterialRow {
  return {
    grundnerId: row.grundner_id,
    typeData: row.type_data,
    customerId: row.customer_id,
    lengthMm: row.length_mm,
    widthMm: row.width_mm,
    thicknessMm: row.thickness_mm,
    stock: row.stock,
    stockAvailable: row.stock_available,
    reservedStock: row.reserved_stock,
    preReserved: row.pre_reserved ?? 0,
    jobKey: row.job_key,
    folder: row.folder,
    ncfile: row.ncfile,
    material: row.material,
    jobPreReserved: row.job_pre_reserved,
    jobLocked: row.job_is_locked,
    updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
    allocatedAt: row.allocated_at ? row.allocated_at.toISOString() : (row.updated_at ? row.updated_at.toISOString() : null),
    allocationStatus: row.allocation_status === 'locked' ? 'locked' : 'pre_reserved'
  };
}

const LIST_SQL = `
  SELECT
    g.id AS grundner_id,
    g.type_data,
    g.customer_id,
    g.length_mm,
    g.width_mm,
    g.thickness_mm,
    g.stock,
    g.stock_available,
    g.reserved_stock,
    COALESCE(g.pre_reserved, 0) AS pre_reserved,
    j.key AS job_key,
    COALESCE(
      NULLIF(TRIM(BOTH FROM j.folder), ''::text),
      NULLIF(regexp_replace((j.key)::text, '^.*/([^/]+)/[^/]+$'::text, '\\1'::text), (j.key)::text)
    ) AS folder,
    j.ncfile,
    j.material,
    j.pre_reserved AS job_pre_reserved,
    j.is_locked AS job_is_locked,
    j.updated_at,
    j.allocated_at,
    CASE
      WHEN j.is_locked THEN 'locked'::text
      ELSE 'pre_reserved'::text
    END AS allocation_status
  FROM public.jobs j
  LEFT JOIN LATERAL (
    SELECT DISTINCT ON (type_data)
      id,
      type_data,
      customer_id,
      length_mm,
      width_mm,
      thickness_mm,
      stock,
      stock_available,
      reserved_stock,
      pre_reserved,
      last_updated
    FROM public.grundner
    WHERE type_data = CASE
      WHEN TRIM(COALESCE(j.material, '')) ~ '^[0-9]+$' THEN TRIM(j.material)::int
      ELSE NULL
    END
    ORDER BY type_data, last_updated DESC NULLS LAST, id DESC
  ) g ON true
  WHERE (j.pre_reserved = TRUE OR j.is_locked = TRUE)
  ORDER BY allocation_status DESC, allocated_at DESC NULLS LAST, job_key ASC
`;

export async function listAllocatedMaterial(): Promise<AllocatedMaterialRow[]> {
  return withClient(async (c: PoolClient) => {
    const res = await c.query<AllocatedMaterialDb>(LIST_SQL);
    return res.rows.map(mapAllocated);
  });
}
