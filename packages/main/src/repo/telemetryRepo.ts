import { withClient } from '../services/db';
import { logger } from '../logger';
import type { TelemetryMachineSummary, TelemetrySummaryReq, TelemetrySeconds } from '../../../shared/src';

const STATS_HOST_EXPR = `split_part(split_part(regexp_replace(lower(btrim(cs.pc_ip)), '^https?://', ''), '/', 1), ':', 1)`;
const STATS_HOST_NORM_EXPR = `regexp_replace(${STATS_HOST_EXPR}, '\\s+', '', 'g')`;
const MACHINE_HOST_EXPR = 'host(m.pc_ip)';
const MACHINE_HOST_NORM_EXPR = `regexp_replace(lower(${MACHINE_HOST_EXPR}), '\\s+', '', 'g')`;

type SeriesRow = {
  machine_id: number | null;
  machine_name: string | null;
  ts: string; // ISO timestamp from SQL
  status: string | null;
  stats_ip_raw: string | null;
  stats_ip_host: string | null;
  stats_ip_host_norm: string | null;
};

function toIsoOrNull(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return null;
}

function toDate(value: string): Date {
  return new Date(value);
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
    where += ` AND to_timestamp(split_part(cs.key, '_', 1), 'YYYY.MM.DD HH24:MI:SS') >= $${idx++}`;
    params.push(new Date(fromIso));
  }
  if (toIso) {
    where += ` AND to_timestamp(split_part(cs.key, '_', 1), 'YYYY.MM.DD HH24:MI:SS') <= $${idx++}`;
    params.push(new Date(toIso));
  }
  if (req.machineIds && req.machineIds.length) {
    where += ` AND m.machine_id = ANY($${idx++})`;
    params.push(req.machineIds);
  }

  // Note on JOIN:
  // We require BOTH name and host IP to match to avoid mismatches.
  // Normalize both sides to lowercase/stripped host before comparing.
  const sql = `
    SELECT
      m.machine_id,
      m.name AS machine_name,
      to_timestamp(split_part(cs.key, '_', 1), 'YYYY.MM.DD HH24:MI:SS') AS ts,
      cs.status,
      cs.pc_ip,
      ${STATS_HOST_EXPR} AS stats_ip_host,
      ${STATS_HOST_NORM_EXPR} AS stats_ip_host_norm,
      ${MACHINE_HOST_EXPR} AS machine_host
    FROM public.cncstats cs
    LEFT JOIN public.machines m
      ON lower(btrim(m.name)) = lower(btrim(cs.machine_name))
     AND ${MACHINE_HOST_NORM_EXPR} = ${STATS_HOST_NORM_EXPR}
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
        ts: toIsoOrNull(row.ts) ?? new Date(row.ts as unknown as string).toISOString(),
        stats_ip_raw: (row as { pc_ip?: string | null }).pc_ip ?? null,
        stats_ip_host: (row as { stats_ip_host?: string | null }).stats_ip_host ?? null,
        stats_ip_host_norm: (row as { stats_ip_host_norm?: string | null }).stats_ip_host_norm ?? null
      }));
    })
  );

  // Debugging: inspect join behavior and IP normalization results using a small sample
  try {
    const sampleSql = `
      SELECT
        cs.pc_ip,
        ${STATS_HOST_EXPR} AS stats_ip_host,
        ${STATS_HOST_NORM_EXPR} AS stats_ip_host_norm,
        m.pc_ip::text AS pc_ip_raw,
        ${MACHINE_HOST_EXPR} AS machine_host,
        ${MACHINE_HOST_NORM_EXPR} AS machine_host_norm,
        m.machine_id,
        m.name
      FROM public.cncstats cs
      LEFT JOIN public.machines m
        ON lower(btrim(m.name)) = lower(btrim(cs.machine_name))
       AND ${MACHINE_HOST_NORM_EXPR} = ${STATS_HOST_NORM_EXPR}
      ${where}
      ORDER BY m.machine_id NULLS LAST, cs.key ASC
      LIMIT 50
    `;
    await withClient((client) =>
      client.query(sampleSql, params).then((r) => {
        const sample = r.rows.map((x) => ({
          pc_ip: (x as { pc_ip?: string | null }).pc_ip,
          stats_ip_host: (x as { stats_ip_host?: string | null }).stats_ip_host,
          stats_ip_host_norm: (x as { stats_ip_host_norm?: string | null }).stats_ip_host_norm,
          pc_ip_raw: (x as { pc_ip_raw?: string | null }).pc_ip_raw,
          machine_host: (x as { machine_host?: string | null }).machine_host,
          machine_host_norm: (x as { machine_host_norm?: string | null }).machine_host_norm,
          machine_id: (x as { machine_id?: number | null }).machine_id,
          machine_name: (x as { name?: string | null }).name
        }));
        logger.debug({ sampleCount: sample.length, sample }, 'telemetry: join debug sample');
      })
    );
  } catch (err) {
    logger.warn({ err }, 'telemetry: failed to fetch join debug sample');
  }

  // group by machine
  const byMachine = new Map<number, SeriesRow[]>();
  const unmatchedHosts = new Map<string, number>();
  let unmatchedExists = false;
  for (const r of rows) {
    if (r.machine_id == null) {
      unmatchedExists = true;
      const hostKey = r.stats_ip_host_norm ?? r.stats_ip_host ?? r.stats_ip_raw ?? '(unknown)';
      unmatchedHosts.set(hostKey, (unmatchedHosts.get(hostKey) ?? 0) + 1);
      continue; // skip unmatched for grouping
    }
    if (!byMachine.has(r.machine_id)) byMachine.set(r.machine_id, []);
    byMachine.get(r.machine_id)!.push(r);
  }

  const result: TelemetryMachineSummary[] = [];

  for (const [machineId, series] of byMachine.entries()) {
    // Aggregate across the full requested range (no per-day reset), still using consecutive points.
    const seconds: TelemetrySeconds = { READY: 0, 'B-STOP': 0, BUSY: 0, ALARM: 0, EMG: 0, OTHER: 0 };

    if (series.length < 2) {
      logger.debug({ machineId, points: series.length }, 'telemetry: insufficient points for intervals');
    } else {
      for (let i = 0; i < series.length - 1; i++) {
        const curr = series[i];
        const next = series[i + 1];
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

  if (unmatchedExists && unmatchedHosts.size) {
    const hostSummary = Array.from(unmatchedHosts.entries()).map(([host, count]) => ({ host, count }));
    const rawSamples = Array.from(new Set(rows.filter((r) => r.machine_id == null).map((r) => r.stats_ip_raw ?? '(null)'))).slice(0, 5);
    logger.info({ hosts: hostSummary, rawSamples }, 'telemetry: unmatched machine hosts');
  }

  if (result.length === 0 && unmatchedExists) {
    const zero: TelemetrySeconds = { READY: 0, 'B-STOP': 0, BUSY: 0, ALARM: 0, EMG: 0, OTHER: 0 };
    result.push({ machineId: null, machineName: null, seconds: zero });
  }

  logger.debug({ items: result.length }, 'telemetry: summarize done');
  return result;
}
