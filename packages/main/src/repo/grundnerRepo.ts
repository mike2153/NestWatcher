import type { QueryResult } from "pg";
import { withClient } from '../services/db';
import type { GrundnerJobRow, GrundnerJobsRes, GrundnerListReq, GrundnerUpdateReq, GrundnerRow } from '../../../shared/src';

type SqlParam = string | number | boolean | null | Date;

type GrundnerRowDb = {
  id: number;
  type_data: number | null;
  customer_id: string | null;
  material_name: string | null;
  material_number: number | null;
  length_mm: number | null;
  width_mm: number | null;
  thickness_mm: number | null;
  stock: number | null;
  stock_available: number | null;
  reserved_stock: number | null;
  last_updated: string | null;
};

function mapRow(row: GrundnerRowDb): GrundnerRow {
  return {
    id: row.id,
    typeData: row.type_data,
    customerId: row.customer_id,
    materialName: row.material_name,
    materialNumber: row.material_number,
    lengthMm: row.length_mm,
    widthMm: row.width_mm,
    thicknessMm: row.thickness_mm,
    stock: row.stock,
    stockAvailable: row.stock_available,
    reservedStock: row.reserved_stock,
    lastUpdated: row.last_updated
  };
}

export async function listGrundner(req: GrundnerListReq) {
  const { limit, filter } = req;
  const params: SqlParam[] = [];
  const where: string[] = [];

  if (filter.search && filter.search.trim()) {
    const search = `%${filter.search.trim()}%`;
    params.push(search);
    where.push(
      `(CAST(type_data AS TEXT) ILIKE $1 OR customer_id ILIKE $1 OR COALESCE(material_name, '') ILIKE $1 OR CAST(material_number AS TEXT) ILIKE $1)`
    );
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
    SELECT id, type_data, customer_id, material_name, material_number, length_mm, width_mm, thickness_mm,
           stock, stock_available, reserved_stock, last_updated
    FROM public.grundner
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY type_data ASC, customer_id ASC NULLS LAST
    LIMIT $${params.length}
  `;

  const rows = await withClient<GrundnerRowDb[]>((c) =>
    c.query<GrundnerRowDb>(sql, params).then((r) => r.rows)
  );
  return rows.map(mapRow);
}

export async function listGrundnerAll(): Promise<GrundnerRow[]> {
  const sql = `
    SELECT id, type_data, customer_id, material_name, material_number, length_mm, width_mm, thickness_mm,
           stock, stock_available, reserved_stock, last_updated
    FROM public.grundner
    ORDER BY type_data ASC, customer_id ASC NULLS LAST
  `;

  const rows = await withClient<GrundnerRowDb[]>((c) =>
    c.query<GrundnerRowDb>(sql).then((r) => r.rows)
  );

  return rows.map(mapRow);
}

export async function listGrundnerPreview(limit: number): Promise<GrundnerRow[]> {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 50);

  const sql = `
    SELECT id, type_data, customer_id, material_name, material_number, length_mm, width_mm, thickness_mm,
           stock, stock_available, reserved_stock, last_updated
    FROM public.grundner
    ORDER BY type_data ASC, customer_id ASC NULLS LAST
    LIMIT $1
  `;

  const rows = await withClient<GrundnerRowDb[]>((c) =>
    c.query<GrundnerRowDb>(sql, [boundedLimit]).then((r) => r.rows)
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

type GrundnerPendingJobDbRow = {
  key: string;
  folder: string | null;
  ncfile: string | null;
  is_locked: boolean;
  total_count: number;
};

export async function listGrundnerPendingJobs(typeData: number, limit: number): Promise<GrundnerJobsRes> {
  const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  const rows = await withClient(async (c) =>
    c
      .query<GrundnerPendingJobDbRow>(
        `
          SELECT
            key,
            folder,
            ncfile,
            is_locked,
            COUNT(*) OVER()::int AS total_count
          FROM public.jobs
          WHERE status = 'PENDING'
            AND material IS NOT NULL
            AND btrim(material) ~ '^[0-9]+$'
            AND btrim(material)::int = $1::int
          ORDER BY dateadded DESC NULLS LAST, key ASC
          LIMIT $2
        `,
        [typeData, boundedLimit]
      )
      .then((r) => r.rows)
  );

  const total = rows.length ? rows[0].total_count : 0;
  const items: GrundnerJobRow[] = rows.map((row) => ({
    key: row.key,
    folder: row.folder,
    ncfile: row.ncfile,
    reserved: Boolean(row.is_locked)
  }));

  return { items, total };
}

// Rows parsed from Grundner stock.csv
export type GrundnerCsvRow = {
  typeData: number | null;
  customerId: string | null;
  materialName: string | null;
  materialNumber: number | null;
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
  const columns = [
    'type_data',
    'customer_id',
    'material_name',
    'material_number',
    'length_mm',
    'width_mm',
    'thickness_mm',
    'stock',
    'stock_available',
    'reserved_stock'
  ] as const;
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
        const customerId = (r.customerId ?? '').trim();
        params.push(
          r.typeData,
          customerId.length ? customerId : '',
          r.materialName,
          r.materialNumber,
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
          material_name = EXCLUDED.material_name,
          material_number = EXCLUDED.material_number,
          length_mm = EXCLUDED.length_mm,
          width_mm = EXCLUDED.width_mm,
          thickness_mm = EXCLUDED.thickness_mm,
          stock = EXCLUDED.stock,
          stock_available = EXCLUDED.stock_available,
          reserved_stock = EXCLUDED.reserved_stock,
          last_updated = now()
        WHERE (
          COALESCE(grundner.material_name, '') IS DISTINCT FROM COALESCE(EXCLUDED.material_name, '') OR
          grundner.material_number IS DISTINCT FROM EXCLUDED.material_number OR
          grundner.length_mm IS DISTINCT FROM EXCLUDED.length_mm OR
          grundner.width_mm IS DISTINCT FROM EXCLUDED.width_mm OR
          grundner.thickness_mm IS DISTINCT FROM EXCLUDED.thickness_mm OR
          grundner.stock IS DISTINCT FROM EXCLUDED.stock OR
          grundner.stock_available IS DISTINCT FROM EXCLUDED.stock_available OR
          grundner.reserved_stock IS DISTINCT FROM EXCLUDED.reserved_stock
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
      const customerIdArr = rows.map((r) => {
        const trimmed = (r.customerId ?? '').trim();
        return trimmed.length ? trimmed : '';
      });
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
