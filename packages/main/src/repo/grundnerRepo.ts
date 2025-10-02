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
           stock, stock_available, reserved_stock, last_updated
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
  if (Object.prototype.hasOwnProperty.call(input, 'reservedStock')) {
    params.push(input.reservedStock ?? null);
    sets.push(`reserved_stock = $${params.length}`);
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
           SET reserved_stock = (
             SELECT COUNT(*) FROM public.jobs WHERE material = $1 AND is_reserved = TRUE
           ), last_updated = now()
         WHERE id = $2`,
        [material, row.id]
      );
      updated += res.rowCount ?? 0;
    }
    return updated;
  });
}
