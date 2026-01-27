import { withClient } from '../services/db';
import type { OrderingRow } from '../../../shared/src';

type PendingJobRow = {
  type_data: number | null;
  demand_count: number;
};

type GrundnerSnapshotRow = {
  id: number;
  type_data: number;
  customer_id: string | null;
  material_name: string | null;
  stock_sum: number;
};

type OrderingStatusRow = {
  grundner_id: number;
  ordered: boolean;
  ordered_by: string | null;
  ordered_at: string | null;
  comments: string | null;
};

export async function computeOrderingRows(): Promise<OrderingRow[]> {
  // Demand is defined as "PENDING jobs that require this sheet type".
  const pendingRows = await withClient((c) =>
    c
      .query<PendingJobRow>(
        `
          SELECT
            CASE
              WHEN btrim(COALESCE(material, '')) ~ '^[0-9]+$' THEN btrim(material)::int
              ELSE NULL
            END AS type_data,
            COUNT(*)::int AS demand_count
          FROM public.jobs
          WHERE status = 'PENDING'
          GROUP BY 1
        `
      )
      .then((res) => res.rows)
  );

  const demandByType = new Map<number, number>();
  for (const row of pendingRows) {
    if (row.type_data == null) continue;
    demandByType.set(row.type_data, Math.max(0, row.demand_count));
  }

  if (!demandByType.size) {
    return [];
  }

  const typeValues = Array.from(demandByType.keys());
  const grundnerRows = await withClient((c) =>
    c
      .query<GrundnerSnapshotRow>(
        `
          WITH latest AS (
            SELECT DISTINCT ON (type_data)
              id,
              type_data,
              customer_id,
              material_name
            FROM public.grundner
            WHERE type_data = ANY($1)
            ORDER BY type_data, last_updated DESC NULLS LAST, id DESC
          ), stock_sum AS (
            SELECT
              type_data,
              COALESCE(SUM(COALESCE(stock, 0)), 0)::int AS stock_sum
            FROM public.grundner
            WHERE type_data = ANY($1)
            GROUP BY 1
          )
          SELECT
            l.id,
            l.type_data,
            l.customer_id,
            l.material_name,
            s.stock_sum
          FROM latest l
          JOIN stock_sum s ON s.type_data = l.type_data
        `,
        [typeValues]
      )
      .then((res) => res.rows)
  );

  const statusRows = new Map<number, OrderingStatusRow>();
  {
    const ids = grundnerRows.map((row) => row.id);
    if (ids.length) {
      const rows = await withClient((c) =>
        c
          .query<OrderingStatusRow>(
            `
              SELECT grundner_id, ordered, ordered_by, ordered_at, comments
              FROM public.ordering_status
              WHERE grundner_id = ANY($1)
            `,
            [ids]
          )
          .then((res) => res.rows)
      );
      for (const row of rows) {
        statusRows.set(row.grundner_id, row);
      }
    }
  }

  const items: OrderingRow[] = [];
  for (const g of grundnerRows) {
    const demand = demandByType.get(g.type_data) ?? 0;
    const stock = Number.isFinite(g.stock_sum) ? g.stock_sum : 0;
    const shortfall = Math.max(0, demand - stock);
    if (shortfall <= 0) continue;

    const status = statusRows.get(g.id);
    items.push({
      id: g.id,
      typeData: g.type_data,
      materialName: g.material_name?.trim() || null,
      customerId: g.customer_id?.trim() || null,
      stock,
      demand,
      shortfall,
      ordered: status?.ordered ?? false,
      orderedBy: status?.ordered_by ?? null,
      orderedAt: status?.ordered_at ?? null,
      comments: status?.comments ?? null
    });
  }

  items.sort((a, b) => {
    if (b.shortfall !== a.shortfall) return b.shortfall - a.shortfall;
    const aType = a.typeData ?? 0;
    const bType = b.typeData ?? 0;
    return aType - bType;
  });

  return items;
}

export async function listOrdering(): Promise<{ items: OrderingRow[]; generatedAt: string }> {
  const items = await computeOrderingRows();
  return {
    items,
    generatedAt: new Date().toISOString()
  };
}

export async function updateOrderingStatus(
  id: number,
  actor: string,
  options: { ordered?: boolean; comments?: string | null }
): Promise<OrderingRow> {
  const actorName = actor?.trim() || 'unknown';
  return withClient(async (client) => {
    // Ensure the Grundner row exists; do not create any Grundner records here.
    const exists = await client
      .query<{ id: number }>(`SELECT id FROM public.grundner WHERE id = $1`, [id])
      .then((r) => Boolean(r.rowCount));
    if (!exists) {
      throw new Error('Grundner row not found for ordering status update');
    }

    const { rows } = await client.query<OrderingStatusRow>(
      `
        SELECT grundner_id, ordered, ordered_by, ordered_at, comments
        FROM public.ordering_status
        WHERE grundner_id = $1
      `,
      [id]
    );
    const existing = rows[0] ?? null;

    const orderedNext = options.ordered ?? existing?.ordered ?? false;
    const commentsNext =
      options.comments === undefined
        ? existing?.comments ?? null
        : options.comments ? options.comments.slice(0, 20) : null;

    if (existing) {
      if (
        existing.ordered &&
        existing.ordered_by &&
        existing.ordered_by !== actor &&
        ((options.ordered !== undefined && options.ordered !== existing.ordered) ||
          (options.comments !== undefined && options.comments !== existing.comments))
      ) {
        const error = new Error('ORDER_LOCKED');
        (error as Error & { code?: string }).code = 'ORDER_LOCKED';
        throw error;
      }
    }

    if (existing) {
      await client.query(
        `
          UPDATE public.ordering_status
             SET ordered = $2,
                 ordered_by = $3,
                 ordered_at = $4,
                 comments = $5,
                 updated_at = now()
           WHERE grundner_id = $1
        `,
        [
          id,
          orderedNext,
          orderedNext ? actorName : null,
          orderedNext ? new Date().toISOString() : null,
          commentsNext
        ]
      );
    } else {
      await client.query(
        `
          INSERT INTO public.ordering_status (grundner_id, ordered, ordered_by, ordered_at, comments, updated_at)
          VALUES ($1, $2, $3, $4, $5, now())
        `,
        [
          id,
          orderedNext,
          orderedNext ? actorName : null,
          orderedNext ? new Date().toISOString() : null,
          commentsNext
        ]
      );
    }

    const refreshed = await computeOrderingRows();
    const row = refreshed.find((item) => item.id === id);
    if (row) return row;

    // If the row is no longer present (shortfall resolved), return a minimal echo.
    return {
      id,
      typeData: null,
      materialName: null,
      customerId: null,
      stock: null,
      demand: 0,
      shortfall: 0,
      ordered: orderedNext,
      orderedBy: orderedNext ? actorName : null,
      orderedAt: orderedNext ? new Date().toISOString() : null,
      comments: commentsNext
    };
  });
}
