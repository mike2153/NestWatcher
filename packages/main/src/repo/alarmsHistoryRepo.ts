import { withClient } from '../services/db';
import { logger } from '../logger';
import type { AlarmIntervalRow, AlarmsHistoryReq } from '../../../shared/src';

type SeriesRow = {
  machine_id: number | null;
  machine_name: string | null;
  ts: string; // ISO timestamp from SQL
  alarm: string | null;
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

function normalizeAlarmText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === '****') return null; // explicitly ignore only ****
  return trimmed;
}

function parseAlarmIdAndDesc(alarm: string): { id: string | null; description: string } {
  const m = alarm.match(/^\s*\(([^)]+)\)\s*(.*)$/);
  if (m) {
    const id = m[1].trim();
    const desc = (m[2] ?? '').trim();
    return { id: id.length ? id : null, description: desc.length ? desc : alarm };
  }
  return { id: null, description: alarm.trim() };
}

export async function listAlarmIntervals(req: AlarmsHistoryReq): Promise<AlarmIntervalRow[]> {
  const fromIso = req.from ?? null;
  const toIso = req.to ?? null;

  logger.debug({ fromIso, toIso, machineIds: req.machineIds }, 'alarms: history summarize');

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
      cs.alarm
    FROM public.cncstats cs
    LEFT JOIN public.machines m
      ON lower(btrim(m.pc_ip::text)) = split_part(regexp_replace(lower(btrim(cs.api_ip)), '^https?://', ''), ':', 1)
    ${where}
    ORDER BY m.machine_id NULLS LAST, ts ASC
  `;

  logger.debug({ sql, params }, 'alarms: executing SQL');

  const rows = await withClient<SeriesRow[]>((client) =>
    client.query(sql, params).then((r) => {
      logger.debug({ rowCount: r.rowCount }, 'alarms: SQL returned rows');
      return r.rows.map((row) => ({
        machine_id: row.machine_id == null ? null : Number(row.machine_id),
        machine_name: row.machine_name ?? null,
        alarm: row.alarm ?? null,
        ts: toIsoOrNull(row.ts) ?? new Date(row.ts as unknown as string).toISOString()
      }));
    })
  );

  // group by machine (string key to allow null)
  const byMachine = new Map<string, SeriesRow[]>();
  for (const r of rows) {
    const k = r.machine_id == null ? 'null' : String(r.machine_id);
    if (!byMachine.has(k)) byMachine.set(k, []);
    byMachine.get(k)!.push(r);
  }

  const intervals: AlarmIntervalRow[] = [];

  for (const [, series] of byMachine.entries()) {
    const machineId = series[0]?.machine_id ?? null;
    const machineName = series[0]?.machine_name ?? null;
    // split by day
    const byDay = new Map<string, SeriesRow[]>();
    for (const p of series) {
      const k = dayKey(toDate(p.ts));
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k)!.push(p);
    }

    for (const [, points] of byDay.entries()) {
      if (!points.length) continue;
      // walk alarm changes within the day
      let current: string | null = null;
      let startAt: Date | null = null;
      for (let i = 0; i < points.length - 1; i++) {
        const curr = points[i];
        const next = points[i + 1];
        const alarm = normalizeAlarmText(curr.alarm);
        if (current == null && alarm != null) {
          current = alarm;
          startAt = toDate(curr.ts);
          continue;
        }
        if (current != null) {
          const thisAlarm = alarm;
          if (thisAlarm !== current) {
            // alarm changed or cleared at next point => close interval at next.ts
            const endAt = toDate(next.ts);
            const minutes = Math.max(0, Math.round((endAt.getTime() - (startAt ?? toDate(curr.ts)).getTime()) / 60000));
            const { id, description } = parseAlarmIdAndDesc(current);
            intervals.push({
              startAt: (startAt ?? toDate(curr.ts)).toISOString(),
              endAt: endAt.toISOString(),
              durationMinutes: minutes,
              machineId,
              machineName,
              alarmId: id,
              description
            });
            current = thisAlarm;
            startAt = thisAlarm ? toDate(next.ts) : null;
          }
        }
      }
      // End of day handling: if last point still in alarm, assign 1 minute
      const last = points[points.length - 1];
      const lastAlarm = current ?? normalizeAlarmText(last.alarm);
      if (lastAlarm) {
        const { id, description } = parseAlarmIdAndDesc(lastAlarm);
        const endStart = startAt ?? toDate(last.ts);
        intervals.push({
          startAt: endStart.toISOString(),
          endAt: null,
          durationMinutes: 1,
          machineId,
          machineName,
          alarmId: id,
          description
        });
      }
    }
  }

  logger.debug({ intervals: intervals.length }, 'alarms: summarized intervals');
  return intervals;
}
