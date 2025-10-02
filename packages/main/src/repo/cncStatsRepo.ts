import { withClient } from '../services/db';

export interface CncStatsUpsert {
  key: string;
  apiIp: string | null;
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

export async function upsertCncStats(row: CncStatsUpsert): Promise<void> {
  const key = sanitize(row.key, 100);
  if (!key) {
    throw new Error('CNC telemetry key cannot be empty');
  }
  const sql = `
    INSERT INTO public.cncstats(
      key, api_ip, currentprogram, mode, status, alarm, emg, powerontime, cuttingtime,
      alarmhistory, vacuumtime, drillheadtime, spindletime, conveyortime, greasetime
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT (key) DO UPDATE SET
      api_ip = EXCLUDED.api_ip,
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
  const params = [
    key,
    sanitize(row.apiIp, 100),
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
  await withClient((client) => client.query(sql, params));
}

