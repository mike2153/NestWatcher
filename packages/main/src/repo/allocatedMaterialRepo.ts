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
  SELECT grundner_id,
         type_data,
         customer_id,
         length_mm,
         width_mm,
         thickness_mm,
         stock,
         stock_available,
         reserved_stock,
         pre_reserved,
         job_key,
         folder,
         ncfile,
         material,
         job_pre_reserved,
         job_is_locked,
         updated_at,
         allocated_at,
         allocation_status
    FROM public.allocated_material_view
ORDER BY allocation_status DESC, allocated_at DESC NULLS LAST, job_key ASC
`;

export async function listAllocatedMaterial(): Promise<AllocatedMaterialRow[]> {
  return withClient(async (c: PoolClient) => {
    const res = await c.query<AllocatedMaterialDb>(LIST_SQL);
    return res.rows.map(mapAllocated);
  });
}
