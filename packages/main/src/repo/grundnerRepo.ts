import type { QueryResult } from "pg";
import { withClient } from '../services/db';
import { getGrundnerLookupColumn, resolveMaterialKey } from '../services/grundner';
import type { GrundnerListReq, GrundnerUpdateReq, GrundnerRow } from '../../../shared/src';

type SqlParam = string | number | boolean | null | Date;

type GrundnerRowDb = {
  id: number;
  type_data: number | null;
  customer_id: string | null;
  length_mm: number | null;
  width_mm: number | null;
  thickness_mm: number | null;
  stock: number | null;
  stock_available: number | null;
  reserved_stock: number | null;
  pre_reserved: number | null;
  last_updated: string | null;
};

type GrundnerKeyRow = {
  id: number;
  type_data: number | null;
  customer_id: string | null;
};

function mapRow(row: GrundnerRowDb): GrundnerRow {
  return {
    id: row.id,
    typeData: row.type_data,
    customerId: row.customer_id,
    lengthMm: row.length_mm,
    widthMm: row.width_mm,
    thicknessMm: row.thickness_mm,
    stock: row.stock,
    stockAvailable: row.stock_available,
    reservedStock: row.reserved_stock,
    preReserved: row.pre_reserved ?? 0,
    lastUpdated: row.last_updated
  };
}

export async function listGrundner(req: GrundnerListReq) {
  const { limit, filter } = req;
  const params: SqlParam[] = [];
  const where: string[] = [];

  if (filter.search && filter.search.trim()) {
    const search = `%${filter.search.trim()}%`;
    params.push(search, search);
    where.push(`(CAST(type_data AS TEXT) ILIKE $${params.length - 1} OR customer_id ILIKE $${params.length})`);
  }
  if (filter.onlyAvailable) {
    where.push('COALESCE(stock_available, 0) > 0');
  }
  if (filter.onlyReserved) {
    where.push('COALESCE(reserved_stock, 0) > 0');
  }
  if (filter.thicknessMin != null) {
    params.push(filter.thicknessMin);
    where.push(`thickness_mm >= $${params.length}`);
  }
  if (filter.thicknessMax != null) {
    params.push(filter.thicknessMax);
    where.push(`thickness_mm <= $${params.length}`);
  }

  params.push(Math.min(Math.max(limit, 1), 500));

  const sql = `
    SELECT id, type_data, customer_id, length_mm, width_mm, thickness_mm,
           stock, stock_available, reserved_stock, pre_reserved, last_updated
    FROM public.grundner
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY type_data ASC, customer_id ASC NULLS LAST
    LIMIT $${params.length}
  `;

  const rows = await withClient<GrundnerRowDb[]>((c) =>
    c.query<GrundnerRowDb>(sql, params).then((r: QueryResult<GrundnerRowDb>) => r.rows)
  );
  return rows.map(mapRow);
}

export async function listGrundnerAll(): Promise<GrundnerRow[]> {
  const sql = `
    SELECT id, type_data, customer_id, length_mm, width_mm, thickness_mm,
           stock, stock_available, reserved_stock, pre_reserved, last_updated
    FROM public.grundner
    ORDER BY type_data ASC, customer_id ASC NULLS LAST
  `;

  const rows = await withClient<GrundnerRowDb[]>((c) =>
    c.query<GrundnerRowDb>(sql).then((r: QueryResult<GrundnerRowDb>) => r.rows)
  );

  return rows.map(mapRow);
}

export async function listGrundnerPreview(limit: number): Promise<GrundnerRow[]> {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 50);

  const sql = `
    SELECT id, type_data, customer_id, length_mm, width_mm, thickness_mm,
           stock, stock_available, reserved_stock, pre_reserved, last_updated
    FROM public.grundner
    ORDER BY type_data ASC, customer_id ASC NULLS LAST
    LIMIT $1
  `;

  const rows = await withClient<GrundnerRowDb[]>((c) =>
    c.query<GrundnerRowDb>(sql, [boundedLimit]).then((r: QueryResult<GrundnerRowDb>) => r.rows)
  );

  return rows.map(mapRow);
}

export async function updateGrundnerRow(input: GrundnerUpdateReq) {
  const sets: string[] = [];
  const params: SqlParam[] = [];

  if (Object.prototype.hasOwnProperty.call(input, 'stock')) {
    params.push(input.stock ?? null);
    sets.push(`stock = $${params.length}`);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'stockAvailable')) {
    params.push(input.stockAvailable ?? null);
    sets.push(`stock_available = $${params.length}`);
  }
  if (!sets.length) return { ok: false as const, updated: 0 };

  params.push(input.id);
  const sql = `UPDATE public.grundner
               SET ${sets.join(', ')}, last_updated = now()
               WHERE id = $${params.length}`;
  const res = await withClient((c) => c.query(sql, params));
  return { ok: true as const, updated: res.rowCount ?? 0 };
}

export async function resyncGrundnerReserved(id?: number) {
  return withClient(async (c) => {
    const column = getGrundnerLookupColumn();
    let rows: GrundnerKeyRow[];
    if (id != null) {
      const single = await c.query<GrundnerKeyRow>('SELECT id, type_data, customer_id FROM public.grundner WHERE id = $1', [id]);
      rows = single.rows;
    } else {
      const all = await c.query<GrundnerKeyRow>('SELECT id, type_data, customer_id FROM public.grundner');
      rows = all.rows;
    }

    let updated = 0;
    for (const row of rows) {
      const material = resolveMaterialKey(column, { typeData: row.type_data, customerId: row.customer_id });
      if (!material) continue;
      const res = await c.query(
        `UPDATE public.grundner
           SET pre_reserved = (
             SELECT COUNT(*) FROM public.jobs WHERE material = $1 AND pre_reserved = TRUE
           ), last_updated = now()
         WHERE id = $2`,
        [material, row.id]
      );
      updated += res.rowCount ?? 0;
    }
    return updated;
  });
}

// Rows parsed from Grundner stock.csv
export type GrundnerCsvRow = {
  typeData: number | null;
  customerId: string | null;
  lengthMm: number | null;
  widthMm: number | null;
  thicknessMm: number | null;
  stock: number | null;
  stockAvailable: number | null;
  reservedStock: number | null;
};

export type GrundnerChangedRow = { typeData: number | null; customerId: string | null };

export async function upsertGrundnerInventory(
  rows: GrundnerCsvRow[]
): Promise<{ inserted: number; updated: number; deleted: number; changed: GrundnerChangedRow[] }> {
  if (!rows.length) return { inserted: 0, updated: 0, deleted: 0, changed: [] };
  const columns = ['type_data', 'customer_id', 'length_mm', 'width_mm', 'thickness_mm', 'stock', 'stock_available', 'reserved_stock'] as const;
  const chunkSize = 200; // avoid huge single statements
  let inserted = 0;
  let updated = 0;
  let deleted = 0;
  const changed = new Map<string, GrundnerChangedRow>();

  await withClient(async (c) => {
    for (let i = 0; i < rows.length; i += chunkSize) {
      const batch = rows.slice(i, i + chunkSize);
      const params: Array<string | number | null> = [];
      const tuples = batch.map((r, idx) => {
        const base = idx * columns.length;
        params.push(
          r.typeData,
          r.customerId,
          r.lengthMm,
          r.widthMm,
          r.thicknessMm,
          r.stock,
          r.stockAvailable,
          r.reservedStock
        );
        const ph = columns.map((_, j) => `$${base + j + 1}`).join(',');
        return `(${ph}, now())`;
      }).join(',');

      const sql = `
        INSERT INTO public.grundner (${columns.join(', ')}, last_updated)
        VALUES ${tuples}
        ON CONFLICT (type_data, customer_id) DO UPDATE SET
          length_mm = EXCLUDED.length_mm,
          width_mm = EXCLUDED.width_mm,
          thickness_mm = EXCLUDED.thickness_mm,
          stock = EXCLUDED.stock,
          stock_available = EXCLUDED.stock_available,
          reserved_stock = EXCLUDED.reserved_stock,
          last_updated = now()
        WHERE (
          COALESCE(grundner.length_mm, -1) IS DISTINCT FROM EXCLUDED.length_mm OR
          COALESCE(grundner.width_mm, -1) IS DISTINCT FROM EXCLUDED.width_mm OR
          COALESCE(grundner.thickness_mm, -1) IS DISTINCT FROM EXCLUDED.thickness_mm OR
          COALESCE(grundner.stock, -1) IS DISTINCT FROM EXCLUDED.stock OR
          COALESCE(grundner.stock_available, -1) IS DISTINCT FROM EXCLUDED.stock_available OR
          COALESCE(grundner.reserved_stock, -1) IS DISTINCT FROM EXCLUDED.reserved_stock
        )
        RETURNING
          (xmax = 0) AS inserted,
          type_data AS type_data,
          customer_id AS customer_id;
      `;

      const res = await c.query<{ inserted: boolean; type_data: number | null; customer_id: string | null }>(sql, params);
      for (const row of res.rows ?? []) {
        if (row.inserted) {
          inserted += 1;
        } else {
          updated += 1;
        }
        const key = `${row.type_data ?? 'null'}::${row.customer_id ?? 'null'}`;
        if (!changed.has(key)) {
          changed.set(key, { typeData: row.type_data, customerId: row.customer_id });
        }
      }
    }

    // After upsert, delete rows not present in the current CSV to keep DB in exact sync
    try {
      const typeDataArr = rows.map((r) => (r.typeData == null ? null : r.typeData));
      const customerIdArr = rows.map((r) => (r.customerId == null ? null : r.customerId));
      const delSql = `
        WITH incoming(type_data, customer_id) AS (
          SELECT UNNEST($1::int[]), UNNEST($2::text[])
        )
        DELETE FROM public.grundner g
        WHERE NOT EXISTS (
          SELECT 1 FROM incoming i
          WHERE g.type_data IS NOT DISTINCT FROM i.type_data
            AND g.customer_id IS NOT DISTINCT FROM i.customer_id
        )
        RETURNING type_data, customer_id
      `;
      const delRes = await c.query<{ type_data: number | null; customer_id: string | null }>(delSql, [typeDataArr, customerIdArr]);
      deleted = delRes.rowCount ?? 0;
      for (const r of delRes.rows ?? []) {
        const key = `${r.type_data ?? 'null'}::${r.customer_id ?? 'null'}`;
        if (!changed.has(key)) {
          changed.set(key, { typeData: r.type_data, customerId: r.customer_id });
        }
      }
    } catch (err) {
      // Best-effort: if deletion fails, keep upsert results; log via withClient caller if needed
    }
  });

  return { inserted, updated, deleted, changed: Array.from(changed.values()) };
}

export type GrundnerAllocationConflict = {
  jobKey: string;
  ncfile: string | null;
  material: string | null;
  preReserved: boolean;
  locked: boolean;
  updatedAt: string | null;
  typeData: number | null;
  customerId: string | null;
};

export async function findGrundnerAllocationConflicts(
  changed: GrundnerChangedRow[]
): Promise<GrundnerAllocationConflict[]> {
  if (!changed.length) return [];
  const lookupColumn = getGrundnerLookupColumn();
  const keys = new Map<string, GrundnerChangedRow>();
  for (const row of changed) {
    const key = resolveMaterialKey(lookupColumn, { typeData: row.typeData, customerId: row.customerId });
    if (!key) continue;
    const trimmed = key.trim();
    if (!trimmed) continue;
    if (!keys.has(trimmed)) {
      keys.set(trimmed, row);
    }
  }
  if (!keys.size) return [];

  const materials = Array.from(keys.keys());
  const sql = `
    SELECT key AS job_key,
           ncfile,
           material,
           pre_reserved,
           is_locked,
           updated_at
      FROM public.jobs
     WHERE material = ANY($1::text[])
       AND (pre_reserved = TRUE OR is_locked = TRUE)
  `;

  const rows = await withClient(async (c) =>
    c.query<{
      job_key: string;
      ncfile: string | null;
      material: string | null;
      pre_reserved: boolean;
      is_locked: boolean;
      updated_at: Date | null;
    }>(sql, [materials]).then((r) => r.rows)
  );

  return rows.map((row) => {
    const changedRow = keys.get(row.material?.trim() ?? '') ?? null;
    return {
      jobKey: row.job_key,
      ncfile: row.ncfile,
      material: row.material,
      preReserved: row.pre_reserved,
      locked: row.is_locked,
      updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
      typeData: changedRow?.typeData ?? null,
      customerId: changedRow?.customerId ?? null
    };
  });
}
