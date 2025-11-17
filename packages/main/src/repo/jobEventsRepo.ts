import type { AppDb } from '../services/db';
import { withDb } from '../services/db';
import { jobEvents } from '../db/schema';
import { desc, eq } from 'drizzle-orm';
import type { JobEvent } from '../../../shared/src';

export async function appendJobEvent(
  key: string,
  eventType: string,
  payload?: unknown,
  machineId?: number | null,
  db?: AppDb
) {
  const values = {
    key,
    eventType,
    payload: payload ?? null,
    machineId: machineId ?? null
  };

  if (db) {
    await db.insert(jobEvents).values(values);
    return;
  }

  await withDb(async (innerDb) => {
    await innerDb.insert(jobEvents).values(values);
  });
}

export async function getJobEvents(key: string, limit: number): Promise<JobEvent[]> {
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const rows = await withDb((db) =>
    db
      .select({
        id: jobEvents.eventId,
        key: jobEvents.key,
        eventType: jobEvents.eventType,
        payload: jobEvents.payload,
        machineId: jobEvents.machineId,
        createdAt: jobEvents.createdAt
      })
      .from(jobEvents)
      .where(eq(jobEvents.key, key))
      .orderBy(desc(jobEvents.createdAt), desc(jobEvents.eventId))
      .limit(safeLimit)
  );

  return rows.map((row) => ({
    id: Number(row.id),
    key: row.key,
    eventType: row.eventType,
    payload: row.payload ?? null,
    machineId: row.machineId ?? null,
    createdAt: row.createdAt ? row.createdAt.toISOString() : new Date().toISOString()
  }));
}
