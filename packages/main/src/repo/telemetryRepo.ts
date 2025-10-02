import { withClient } from '../services/db';
import { logger } from '../logger';
import type { TelemetryMachineSummary, TelemetrySummaryReq, TelemetrySeconds } from '../../../shared/src';

type SeriesRow = {
  machine_id: number | null;
  machine_name: string | null;
  ts: string; // ISO timestamp from SQL
  status: string | null;
};

function toIsoOrNull(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return null;
}

function toDate(value: string): Date {
  return new Date(value);
}

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function normalizeStatus(raw: string | null): keyof TelemetrySeconds | 'OTHER' {
  if (!raw) return 'OTHER';
  const v = raw.trim().toUpperCase();
  if (v === 'READY') return 'READY';
  if (v === 'B-STOP' || v === 'BSTOP' || v === 'B_STOP') return 'B-STOP';
  if (v === 'BUSY' || v === 'RUNNING') return 'BUSY';
  if (v === 'ALARM') return 'ALARM';
  if (v === 'EMG' || v === 'EMERGENCY') return 'EMG';
  return 'OTHER';
}

export async function summarizeTelemetry(req: TelemetrySummaryReq): Promise<TelemetryMachineSummary[]> {
  const fromIso = req.from ?? null;
  const toIso = req.to ?? null;

  logger.debug({ fromIso, toIso, machineIds: req.machineIds }, 'telemetry: summarizing');

  const params: unknown[] = [];
  let idx = 1;
  let where = 'WHERE 1=1';

  if (fromIso) {
    where += ` AND to_timestamp(cs.key, 'YYYY.MM.DD HH24:MI:SS') >= $${idx++}`;
    params.push(new Date(fromIso));
  }
  if (toIso) {
    where += ` AND to_timestamp(cs.key, 'YYYY.MM.DD HH24:MI:SS') <= $${idx++}`;
    params.push(new Date(toIso));
  }
  if (req.machineIds && req.machineIds.length) {
    where += ` AND m.machine_id = ANY($${idx++})`;
    params.push(req.machineIds);
  }

  const sql = `
    SELECT
      m.machine_id,
      m.name AS machine_name,
      to_timestamp(cs.key, 'YYYY.MM.DD HH24:MI:SS') AS ts,
      cs.status
    FROM public.cncstats cs
    LEFT JOIN public.machines m
      ON lower(btrim(m.pc_ip::text)) = split_part(regexp_replace(lower(btrim(cs.api_ip)), '^https?://', ''), ':', 1)
    ${where}
    ORDER BY m.machine_id NULLS LAST, ts ASC
  `;

  logger.debug({ sql, params }, 'telemetry: executing SQL');

  const rows = await withClient<SeriesRow[]>((client) =>
    client.query(sql, params).then((r) => {
      logger.debug({ rowCount: r.rowCount }, 'telemetry: SQL returned rows');
      return r.rows.map((row) => ({
        machine_id: row.machine_id == null ? null : Number(row.machine_id),
        machine_name: row.machine_name ?? null,
        status: row.status ?? null,
        ts: toIsoOrNull(row.ts) ?? new Date(row.ts as unknown as string).toISOString()
      }));
    })
  );

  // group by machine
  const byMachine = new Map<number, SeriesRow[]>();
  let unmatchedExists = false;
  for (const r of rows) {
    if (r.machine_id == null) continue; // skip unmatched for grouping
    if (!byMachine.has(r.machine_id)) byMachine.set(r.machine_id, []);
    byMachine.get(r.machine_id)!.push(r);
  }

  const result: TelemetryMachineSummary[] = [];

  for (const r of rows) if (r.machine_id == null) unmatchedExists = true;

  for (const [machineId, series] of byMachine.entries()) {
    // group by day within the series
    const byDay = new Map<string, SeriesRow[]>();
    for (const p of series) {
      const d = toDate(p.ts);
      const k = dayKey(d);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k)!.push(p);
    }

    const seconds: TelemetrySeconds = { READY: 0, 'B-STOP': 0, BUSY: 0, ALARM: 0, EMG: 0, OTHER: 0 };

    for (const [, points] of byDay.entries()) {
      if (points.length < 2) continue; // no interval to accumulate
      // points are already ASC
      for (let i = 0; i < points.length - 1; i++) {
        const curr = points[i];
        const next = points[i + 1];
        const dt = Math.max(0, (toDate(next.ts).getTime() - toDate(curr.ts).getTime()) / 1000);
        const key = normalizeStatus(curr.status);
        if ((key as keyof TelemetrySeconds) in seconds) {
          const k = key as keyof TelemetrySeconds;
          seconds[k] += Math.floor(dt);
        } else {
          seconds.OTHER += Math.floor(dt);
        }
      }
    }

    result.push({ machineId, machineName: series[0]?.machine_name ?? null, seconds });
    logger.debug({ machineId, machineName: series[0]?.machine_name ?? null, seconds }, 'telemetry: machine summary');
  }

  if (result.length === 0 && unmatchedExists) {
    const zero: TelemetrySeconds = { READY: 0, 'B-STOP': 0, BUSY: 0, ALARM: 0, EMG: 0, OTHER: 0 };
    result.push({ machineId: null, machineName: null, seconds: zero });
  }

  logger.debug({ items: result.length }, 'telemetry: summarize done');
  return result;
}
