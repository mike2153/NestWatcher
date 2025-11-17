import { withClient } from '../services/db';
import type { PoolClient, QueryConfig } from 'pg';

export interface CncStatsUpsert {
  key: string;
  pcIp: string | null;
  machineName: string | null;
  currentProgram: string | null;
  mode: string | null;
  status: string | null;
  alarm: string | null;
  emg: string | null;
  powerOnTime: string | null;
  cuttingTime: string | null;
  alarmHistory: string | null;
  vacuumTime: string | null;
  drillHeadTime: string | null;
  spindleTime: string | null;
  conveyorTime: string | null;
  greaseTime: string | null;
}

function sanitize(value: string | null | undefined, limit: number): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= limit) return trimmed;
  return trimmed.slice(0, limit);
}

const UPSERT_COLUMNS = [
  'key',
  'pc_ip',
  'machine_name',
  'currentprogram',
  'mode',
  'status',
  'alarm',
  'emg',
  'powerontime',
  'cuttingtime',
  'alarmhistory',
  'vacuumtime',
  'drillheadtime',
  'spindletime',
  'conveyortime',
  'greasetime'
] as const;

const BULK_UPSERT_CHUNK_SIZE = 500;
const UPSERT_STATEMENT_NAME = 'cncstats_bulk_upsert';

const bulkUpsertSql = `
  INSERT INTO public.cncstats(
    key, pc_ip, machine_name, currentprogram, mode, status, alarm, emg,
    powerontime, cuttingtime, alarmhistory, vacuumtime, drillheadtime, spindletime, conveyortime, greasetime
  )
  SELECT *
  FROM UNNEST(
    $1::text[],
    $2::text[],
    $3::text[],
    $4::text[],
    $5::text[],
    $6::text[],
    $7::text[],
    $8::text[],
    $9::text[],
    $10::text[],
    $11::text[],
    $12::text[],
    $13::text[],
    $14::text[],
    $15::text[],
    $16::text[]
  ) AS t(
    key, pc_ip, machine_name, currentprogram, mode, status, alarm, emg,
    powerontime, cuttingtime, alarmhistory, vacuumtime, drillheadtime, spindletime, conveyortime, greasetime
  )
  ON CONFLICT (key) DO UPDATE SET
    pc_ip = EXCLUDED.pc_ip,
    machine_name = EXCLUDED.machine_name,
    currentprogram = EXCLUDED.currentprogram,
    mode = EXCLUDED.mode,
    status = EXCLUDED.status,
    alarm = EXCLUDED.alarm,
    emg = EXCLUDED.emg,
    powerontime = EXCLUDED.powerontime,
    cuttingtime = EXCLUDED.cuttingtime,
    alarmhistory = EXCLUDED.alarmhistory,
    vacuumtime = EXCLUDED.vacuumtime,
    drillheadtime = EXCLUDED.drillheadtime,
    spindletime = EXCLUDED.spindletime,
    conveyortime = EXCLUDED.conveyortime,
    greasetime = EXCLUDED.greasetime
`;

type SanitizedRow = (string | null)[];

function sanitizeRow(row: CncStatsUpsert): SanitizedRow {
  const key = sanitize(row.key, 100);
  if (!key) throw new Error('CNC telemetry key cannot be empty');
  return [
    key,
    sanitize(row.pcIp, 100),
    sanitize(row.machineName, 100),
    sanitize(row.currentProgram, 50),
    sanitize(row.mode, 50),
    sanitize(row.status, 50),
    sanitize(row.alarm, 50),
    sanitize(row.emg, 50),
    sanitize(row.powerOnTime, 50),
    sanitize(row.cuttingTime, 50),
    sanitize(row.alarmHistory, 50),
    sanitize(row.vacuumTime, 50),
    sanitize(row.drillHeadTime, 50),
    sanitize(row.spindleTime, 50),
    sanitize(row.conveyorTime, 50),
    sanitize(row.greaseTime, 50)
  ];
}

function rowsToColumnArrays(rows: CncStatsUpsert[]): SanitizedRow[] {
  const columns: SanitizedRow[] = Array.from({ length: UPSERT_COLUMNS.length }, () => [] as SanitizedRow);
  for (const row of rows) {
    const sanitized = sanitizeRow(row);
    for (let i = 0; i < sanitized.length; i++) {
      columns[i].push(sanitized[i]);
    }
  }
  return columns;
}

function createQueryConfig(rows: CncStatsUpsert[]): QueryConfig {
  return {
    name: UPSERT_STATEMENT_NAME,
    text: bulkUpsertSql,
    values: rowsToColumnArrays(rows)
  };
}

function* chunkRows(rows: CncStatsUpsert[]): Generator<CncStatsUpsert[]> {
  for (let i = 0; i < rows.length; i += BULK_UPSERT_CHUNK_SIZE) {
    yield rows.slice(i, i + BULK_UPSERT_CHUNK_SIZE);
  }
}

export async function bulkUpsertCncStats(rows: CncStatsUpsert[], client?: PoolClient): Promise<void> {
  if (!rows.length) return;
  if (client) {
    for (const chunk of chunkRows(rows)) {
      await client.query(createQueryConfig(chunk));
    }
    return;
  }
  await withClient(async (c) => {
    for (const chunk of chunkRows(rows)) {
      await c.query(createQueryConfig(chunk));
    }
  });
}

export async function upsertCncStats(row: CncStatsUpsert, client?: PoolClient): Promise<void> {
  await bulkUpsertCncStats([row], client);
}
