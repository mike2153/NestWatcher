import { withClient } from '../services/db';
import { logger } from '../logger';
import type { AlarmEntry } from '../../../shared/src';

type RawAlarmRow = {
  key: string;
  api_ip: string | null;
  alarm: string | null;
  status: string | null;
  mode: string | null;
  currentprogram: string | null;
  alarmhistory: string | null;
};

const INACTIVE_VALUES = new Set<string>(['', 'ok', 'ready', 'none', 'no alarm', '0']);

function normalizeAlarm(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (INACTIVE_VALUES.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

function inferSeverity(alarmText: string): AlarmEntry['severity'] {
  const lowered = alarmText.toLowerCase();
  if (lowered.includes('emergency') || lowered.includes('fault') || lowered.includes('alarm')) {
    return 'critical';
  }
  if (lowered.includes('warning') || lowered.includes('warn')) {
    return 'warning';
  }
  return 'info';
}

export async function listActiveAlarms(): Promise<AlarmEntry[]> {
  // Select the most recent row per machine IP (api_ip) using the timestamp stored in `key`.
  // The `key` has format: YYYY.MM.DD HH24:MI:SS (e.g., 2025.04.16 12:58:06).
  // We filter obvious inactive alarms at the DB level to reduce payload.
  const sql = `
    SELECT DISTINCT ON (lower(api_ip))
      key, api_ip, alarm, status, mode, currentprogram, alarmhistory
    FROM public.cncstats
    WHERE api_ip IS NOT NULL AND btrim(api_ip) <> ''
      AND alarm IS NOT NULL AND btrim(alarm) <> ''
      AND lower(alarm) NOT IN ('ok','ready','none','no alarm','0')
    ORDER BY lower(api_ip), to_timestamp(key, 'YYYY.MM.DD HH24:MI:SS') DESC NULLS LAST
  `;
  try {
    const rows = await withClient<RawAlarmRow[]>((client) =>
      client.query<RawAlarmRow>(sql).then((result) => result.rows)
    );

    const nowIso = new Date().toISOString();

    const active: AlarmEntry[] = [];
    for (const row of rows) {
      const alarm = normalizeAlarm(row.alarm);
      if (!alarm) continue;
      const machineKey = (row.api_ip && row.api_ip.trim()) ? row.api_ip.trim().toLowerCase() : row.key;
      const id = `${machineKey}:${alarm}`;
      const severity = inferSeverity(alarm);
      active.push({
        id,
        key: machineKey,
        alarm,
        status: row.status ?? null,
        mode: row.mode ?? null,
        currentProgram: row.currentprogram ?? null,
        alarmHistory: row.alarmhistory ?? null,
        lastSeenAt: nowIso,
        severity
      });
    }
    return active;
  } catch (err) {
    logger.error({ err }, 'alarmRepo: failed to list active alarms');
    return [];
  }
}
