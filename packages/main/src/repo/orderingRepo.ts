import { withClient } from '../services/db';
import { loadConfig } from '../services/config';
import type { OrderingRow } from '../../../shared/src';

type PendingJobRow = {
  type_data: number | null;
  required_count: number;
};

type PendingJobSampleRow = {
  key: string;
  folder: string | null;
  ncfile: string | null;
  material: string | null;
};

type LockedJobRow = {
  type_data: number | null;
  locked_count: number;
};

type GrundnerSnapshotRow = {
  id: number;
  type_data: number | null;
  customer_id: string | null;
  stock: number | null;
  stock_available: number | null;
  reserved_stock: number | null;
};

type OrderingStatusRow = {
  grundner_id: number;
  ordered: boolean;
  ordered_by: string | null;
  ordered_at: string | null;
  comments: string | null;
};

type OrderingComputation = {
  rows: OrderingRow[];
  includeReserved: boolean;
};

const UNKNOWN_KEY = '__UNKNOWN__';

async function loadPendingJobSamples(materialKey: string, limit = 25): Promise<PendingJobSampleRow[]> {
  const normalizedLimit = Math.max(1, Math.min(200, Math.floor(limit)));

  // "Unknown" includes jobs where we cannot safely derive a numeric type_data.
  if (materialKey === UNKNOWN_KEY) {
    return withClient((c) =>
      c
        .query<PendingJobSampleRow>(
          `
            SELECT key, folder, ncfile, material
            FROM public.jobs
            WHERE status = 'PENDING'
              AND (
                material IS NULL
                OR btrim(material) = ''
                OR NOT (btrim(material) ~ '^[0-9]+$')
              )
            ORDER BY dateadded DESC NULLS LAST, key
            LIMIT $1
          `,
          [normalizedLimit]
        )
        .then((res) => res.rows ?? [])
    );
  }

  const typeData = Number(materialKey);
  if (!Number.isFinite(typeData)) {
    return [];
  }

  // Guard the cast so non-numeric material strings don't crash the query.
  return withClient((c) =>
    c
      .query<PendingJobSampleRow>(
        `
          SELECT key, folder, ncfile, material
          FROM public.jobs
          WHERE status = 'PENDING'
            AND material IS NOT NULL
            AND btrim(material) ~ '^[0-9]+$'
            AND btrim(material)::int = $1::int
          ORDER BY dateadded DESC NULLS LAST, key
          LIMIT $2
        `,
        [typeData, normalizedLimit]
      )
      .then((res) => res.rows ?? [])
  );
}

function normalizeMaterialKey(material: string | null | undefined): string {
  const trimmed = material?.trim();
  if (!trimmed) return UNKNOWN_KEY;

  // Canonical material key is always numeric type_data.
  if (!/^[0-9]+$/.test(trimmed)) return UNKNOWN_KEY;
  return String(Number(trimmed));
}

export async function computeOrderingRows(): Promise<OrderingComputation> {
  const includeReserved = loadConfig().ordering?.includeReserved ?? false;

  // We always use numeric type_data as the canonical material key.
  // Anything that cannot be parsed as a number becomes "Unknown".
  const [pendingRows, lockedRows] = await Promise.all([
    withClient((c) =>
      c
        .query<PendingJobRow>(
          `
            SELECT
              CASE
                WHEN TRIM(COALESCE(material, '')) ~ '^[0-9]+$' THEN TRIM(material)::int
                ELSE NULL
              END AS type_data,
              COUNT(*)::int AS required_count
            FROM public.jobs
            WHERE status = 'PENDING'
            GROUP BY 1
          `
        )
        .then((res) => res.rows)
    ),
    withClient((c) =>
      c
        .query<LockedJobRow>(
          `
            SELECT
              CASE
                WHEN TRIM(COALESCE(material, '')) ~ '^[0-9]+$' THEN TRIM(material)::int
                ELSE NULL
              END AS type_data,
              COUNT(*)::int AS locked_count
            FROM public.jobs
            WHERE is_locked = TRUE
              AND status <> 'NESTPICK_COMPLETE'
            GROUP BY 1
          `
        )
        .then((res) => res.rows)
    )
  ]);

  const pendingByKey = new Map<string, number>();
  for (const row of pendingRows) {
    const key = row.type_data == null ? UNKNOWN_KEY : String(row.type_data);
    pendingByKey.set(key, row.required_count);
  }

  const lockedByKey = new Map<string, number>();
  for (const row of lockedRows) {
    const key = row.type_data == null ? UNKNOWN_KEY : String(row.type_data);
    lockedByKey.set(key, row.locked_count);
  }

  const allMaterialKeys = new Set<string>([
    ...Array.from(pendingByKey.keys()),
    ...Array.from(lockedByKey.keys())
  ]);

  const aggregated = Array.from(allMaterialKeys).map((materialKey) => {
    const pendingCount = pendingByKey.get(materialKey) ?? 0;
    const lockedCount = lockedByKey.get(materialKey) ?? 0;

    return {
      materialKey,
      pendingCount: Math.max(pendingCount, 0),
      lockedCount: Math.max(lockedCount, 0)
    };
  });

  const numericKeys = new Set<number>();
  for (const row of aggregated) {
    if (row.materialKey === UNKNOWN_KEY) continue;
    const parsed = Number(row.materialKey);
    if (Number.isFinite(parsed)) {
      numericKeys.add(parsed);
    }
  }

  const grundnerRows = new Map<string, GrundnerSnapshotRow>();
  if (numericKeys.size) {
    const values = Array.from(numericKeys);
    const rows = await withClient((c) =>
      c
        .query<GrundnerSnapshotRow>(
          `
            SELECT DISTINCT ON (type_data)
              id,
              type_data,
              customer_id,
              stock,
              stock_available,
              reserved_stock
            FROM public.grundner
            WHERE type_data = ANY($1)
            ORDER BY type_data, last_updated DESC NULLS LAST, id DESC
          `,
          [values]
        )
        .then((res) => res.rows)
    );
    for (const row of rows) {
      if (row.type_data == null) continue;
      grundnerRows.set(String(row.type_data), row);
    }
  }

  const statusRows = new Map<number, OrderingStatusRow>();
  if (grundnerRows.size) {
    const ids = Array.from(grundnerRows.values()).map((row) => row.id);
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
  for (const entry of aggregated) {
    const baseKey = entry.materialKey;
    const grundnerRow = grundnerRows.get(baseKey);
    const status = grundnerRow ? statusRows.get(grundnerRow.id) : undefined;

    const stock = grundnerRow?.stock ?? null;
    const stockAvailable = grundnerRow?.stock_available ?? null;
    const reservedStock = grundnerRow?.reserved_stock ?? null;

    const numericZeroed = (value: number | null | undefined): number => (value == null ? 0 : value);

    const pendingCount = entry.pendingCount;
    const lockedCount = entry.lockedCount;
    const totalRequired = pendingCount;

    const availableStock = stockAvailable !== null ? numericZeroed(stockAvailable) : numericZeroed(stock);
    const orderAmount = totalRequired - availableStock;

    if (orderAmount <= 0) {
      continue;
    }

    const effectiveAvailable = availableStock;

    const typeData = grundnerRow?.type_data ?? (baseKey === UNKNOWN_KEY ? null : Number(baseKey));
    const customerId = grundnerRow?.customer_id?.trim() ?? null;
    const materialLabel = baseKey === UNKNOWN_KEY ? 'Unknown' : String(typeData);

    items.push({
      id: grundnerRow?.id ?? null,
      typeData: typeData != null && Number.isFinite(typeData) ? typeData : null,
      customerId,
      materialKey: baseKey,
      materialLabel,
      required: totalRequired,
      lockedCount,
      stock,
      stockAvailable,
      reservedStock,
      effectiveAvailable,
      orderAmount,
      ordered: status?.ordered ?? false,
      orderedBy: status?.ordered_by ?? null,
      orderedAt: status?.ordered_at ?? null,
      comments: status?.comments ?? null
    });
  }

  if (!items.some((item) => item.materialKey === UNKNOWN_KEY)) {
    const unknownPending = aggregated.find((entry) => entry.materialKey === UNKNOWN_KEY);
    if (unknownPending) {
      const totalRequired = unknownPending.pendingCount;
      if (totalRequired > 0) {
        items.push({
          id: null,
          typeData: null,
          customerId: null,
          materialKey: UNKNOWN_KEY,
          materialLabel: 'Unknown',
          required: totalRequired,
          lockedCount: unknownPending.lockedCount,
          stock: null,
          stockAvailable: null,
          reservedStock: null,
          effectiveAvailable: 0,
          orderAmount: totalRequired,
          ordered: false,
          orderedBy: null,
          orderedAt: null,
          comments: null
        });
      }
    }
  }

  // Help identify "Unknown" / unmatched ordering rows by attaching sample pending jobs.
  // This avoids the situation where ordering shows blank Type Data / Customer ID and users
  // can't tell which jobs are responsible.
  const keysNeedingSamples = Array.from(
    new Set(
      items
        .filter((item) => item.materialKey === UNKNOWN_KEY || (item.typeData == null && item.customerId == null))
        .map((item) => item.materialKey)
    )
  );
  if (keysNeedingSamples.length) {
    const sampleLimit = 50;
    for (const key of keysNeedingSamples) {
      try {
        const samples = await loadPendingJobSamples(key, sampleLimit);
        for (const item of items) {
          if (item.materialKey === key) {
            item.pendingJobs = samples;
          }
        }
      } catch {
        // Best-effort only; ordering should still render even if sample query fails.
      }
    }
  }

  // Order by order amount descending, then material label
  items.sort((a, b) => {
    if (b.orderAmount !== a.orderAmount) return b.orderAmount - a.orderAmount;
    return a.materialLabel.localeCompare(b.materialLabel);
  });

  return { rows: items, includeReserved };
}


export async function listOrdering(): Promise<{ items: OrderingRow[]; includeReserved: boolean; generatedAt: string }> {
  const result = await computeOrderingRows();
  return {
    items: result.rows,
    includeReserved: result.includeReserved,
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
    const row = refreshed.rows.find((item) => item.id === id);
    if (row) return row;
    // If the row is no longer present in the ordering view (e.g., shortage resolved),
    // return a minimal echo using the status fields without fabricating a pseudo material.
    return {
      id,
      typeData: null,
      customerId: null,
      materialKey: '__HIDDEN__',
      materialLabel: 'Hidden',
      required: 0,
      lockedCount: 0,
      stock: null,
      stockAvailable: null,
      reservedStock: null,
      effectiveAvailable: 0,
      orderAmount: 0,
      ordered: orderedNext,
      orderedBy: orderedNext ? actorName : null,
      orderedAt: orderedNext ? new Date().toISOString() : null,
      comments: commentsNext
    };
  });
}
