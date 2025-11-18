import { withClient } from '../services/db';
import { getGrundnerLookupColumn } from '../services/grundner';
import { loadConfig } from '../services/config';
import type { OrderingRow } from '../../../shared/src';

type PendingJobRow = {
  material: string | null;
  required_count: number;
};

type LockedJobRow = {
  material: string | null;
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

function normalizeMaterialKey(material: string | null | undefined): string {
  const trimmed = material?.trim();
  if (!trimmed) return UNKNOWN_KEY;
  return trimmed;
}

export async function computeOrderingRows(): Promise<OrderingComputation> {
  const includeReserved = loadConfig().ordering?.includeReserved ?? false;

  // Get ALL pending jobs (not just pre-reserved) and locked jobs
  const [pendingRows, lockedRows] = await Promise.all([
    withClient((c) =>
      c
        .query<PendingJobRow>(
          `
            SELECT material, COUNT(*)::int AS required_count
            FROM public.jobs
            WHERE status = 'PENDING'
            GROUP BY material
          `
        )
        .then((res) => res.rows)
    ),
    withClient((c) =>
      c
        .query<LockedJobRow>(
          `
            SELECT material, COUNT(*)::int AS locked_count
            FROM public.jobs
            WHERE is_locked = TRUE
              AND status <> 'NESTPICK_COMPLETE'
            GROUP BY material
          `
        )
        .then((res) => res.rows)
    )
  ]);

  const pendingByKey = new Map<string, number>();
  for (const row of pendingRows) {
    pendingByKey.set(normalizeMaterialKey(row.material), row.required_count);
  }

  const lockedByKey = new Map<string, number>();
  for (const row of lockedRows) {
    lockedByKey.set(normalizeMaterialKey(row.material), row.locked_count);
  }

  // Combine all materials from both pending and locked
  const allMaterialKeys = new Set<string>([
    ...Array.from(pendingByKey.keys()),
    ...Array.from(lockedByKey.keys())
  ]);

  const lookupColumn = getGrundnerLookupColumn();
  const aggregated = Array.from(allMaterialKeys).map((materialKey) => {
    const pendingCount = pendingByKey.get(materialKey) ?? 0;
    const lockedCount = lockedByKey.get(materialKey) ?? 0;
    // Get the raw material string from one of the original rows
    const pendingRow = pendingRows.find(r => normalizeMaterialKey(r.material) === materialKey);
    const lockedRow = lockedRows.find(r => normalizeMaterialKey(r.material) === materialKey);
    const material = (pendingRow?.material ?? lockedRow?.material ?? '').trim();

    return {
      material,
      materialKey,
      pendingCount: Math.max(pendingCount, 0),
      lockedCount: Math.max(lockedCount, 0)
    };
  });

  const numericKeys = new Set<number>();
  const stringKeys = new Set<string>();
  for (const row of aggregated) {
    if (row.materialKey === UNKNOWN_KEY) continue;
    if (lookupColumn === 'type_data') {
      const parsed = Number(row.materialKey);
      if (!Number.isNaN(parsed)) {
        numericKeys.add(parsed);
      }
    } else {
      stringKeys.add(row.materialKey);
    }
  }

  const grundnerRows = new Map<string, GrundnerSnapshotRow>();
  if (lookupColumn === 'type_data' && numericKeys.size) {
    const values = Array.from(numericKeys);
    const rows = await withClient((c) =>
      c
        .query<GrundnerSnapshotRow>(
          `
            SELECT id, type_data, customer_id, stock, stock_available, reserved_stock
            FROM public.grundner
            WHERE type_data = ANY($1)
          `,
          [values]
        )
        .then((res) => res.rows)
    );
    for (const row of rows) {
      if (row.type_data == null) continue;
      grundnerRows.set(String(row.type_data), row);
    }
  } else if (lookupColumn === 'customer_id' && stringKeys.size) {
    const values = Array.from(stringKeys);
    const rows = await withClient((c) =>
      c
        .query<GrundnerSnapshotRow>(
          `
            SELECT id, type_data, customer_id, stock, stock_available, reserved_stock
            FROM public.grundner
            WHERE customer_id = ANY($1)
          `,
          [values]
        )
        .then((res) => res.rows)
    );
    for (const row of rows) {
      if (!row.customer_id) continue;
      grundnerRows.set(row.customer_id.trim(), row);
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

    // New calculation: shortage = pending - stockAvailable
    // We consider ALL pending jobs, and check against available stock
    const pendingCount = entry.pendingCount;
    const lockedCount = entry.lockedCount;
    const totalRequired = pendingCount;  // Total jobs that need material

    // Use stockAvailable if provided, otherwise use stock
    // stockAvailable accounts for reserved/locked quantities in Grundner
    const availableStock = stockAvailable !== null ? numericZeroed(stockAvailable) : numericZeroed(stock);

    // Calculate how much we need to order
    // This is the total needed minus what's available
    const orderAmount = totalRequired - availableStock;

    // Only show materials with a shortage (orderAmount > 0)
    if (orderAmount <= 0) {
      continue;
    }

    const effectiveAvailable = availableStock;

    const typeData = grundnerRow?.type_data ?? null;
    const customerId = grundnerRow?.customer_id?.trim() ?? null;
    const materialLabel =
      baseKey === UNKNOWN_KEY
        ? 'Unknown'
        : lookupColumn === 'customer_id'
          ? customerId ?? (entry.material || 'Unknown')
          : typeData != null
            ? String(typeData)
            : entry.material || 'Unknown';

    items.push({
      id: grundnerRow?.id ?? null,
      typeData,
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
