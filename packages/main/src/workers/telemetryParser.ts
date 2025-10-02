import type { Machine } from '../../../shared/src';
import type { CncStatsUpsert } from '../repo/cncStatsRepo';

type FlatMap = Map<string, unknown>;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function flattenTelemetry(value: unknown, map: FlatMap = new Map(), prefix = ''): FlatMap {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${rawKey}` : rawKey;
      if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
        flattenTelemetry(rawValue, map, path);
      } else {
        map.set(normalizeKey(path), rawValue ?? null);
      }
    }
  }
  return map;
}

function coerceToString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function pick(flat: FlatMap, candidates: string[]): string | null {
  for (const candidate of candidates) {
    const normalized = normalizeKey(candidate);
    if (flat.has(normalized)) {
      const coerced = coerceToString(flat.get(normalized));
      if (coerced != null) return coerced;
    }
  }
  return null;
}

function fallbackKey(machine: Machine, flat: FlatMap): string {
  const explicit = pick(flat, ['key', 'machine', 'machinename', 'name']);
  if (explicit) return explicit;
  if (machine.name && machine.name.trim().length > 0) return machine.name;
  return `Machine ${machine.machineId}`;
}

export function normalizeTelemetryPayload(machine: Machine, payload: unknown): CncStatsUpsert {
  const flat = flattenTelemetry(payload);
  const result: CncStatsUpsert = {
    key: fallbackKey(machine, flat),
    apiIp: pick(flat, ['apiIp', 'api_ip', 'ip']) ?? machine.pcIp ?? null,
    currentProgram: pick(flat, ['currentProgram', 'current_program', 'program', 'activeProgram', 'prog']),
    mode: pick(flat, ['mode', 'machineMode', 'operatingMode']),
    status: pick(flat, ['status', 'state', 'machineStatus']),
    alarm: pick(flat, ['alarm', 'alarmMessage', 'alarm_text']),
    emg: pick(flat, ['emg', 'emergency', 'emergencyStop', 'emergency_stop']),
    powerOnTime: pick(flat, ['powerOnTime', 'power_on', 'timers.powerOn', 'timers.power_on', 'timers.power']),
    cuttingTime: pick(flat, ['cuttingTime', 'cutting_time', 'timers.cuttingTime', 'timers.cutting_time', 'timers.cuttime']),
    alarmHistory: pick(flat, ['alarmHistory', 'alarm_history', 'alarms.history']),
    vacuumTime: pick(flat, ['vacuumTime', 'vacuum_time']),
    drillHeadTime: pick(flat, ['drillHeadTime', 'drill_head_time', 'timers.drillHead']),
    spindleTime: pick(flat, ['spindleTime', 'spindle_time', 'timers.spindle']),
    conveyorTime: pick(flat, ['conveyorTime', 'conveyor_time']),
    greaseTime: pick(flat, ['greaseTime', 'grease_time'])
  };
  return result;
}
