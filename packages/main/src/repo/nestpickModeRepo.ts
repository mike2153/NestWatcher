import { withClient } from '../services/db';

type NestpickModeResult = {
  enabled: boolean | null;
  lastSeenAt: string | null;
};

type NestpickModeDebug = {
  enabled: boolean | null;
  reason: string;
  matchedKey: string | null;
  rawValue: unknown;
};

export type NestpickModeDebugResult = {
  enabled: boolean | null;
  lastSeenAt: string | null;
  // These are for logging only. Do not pass to renderer.
  row: {
    key: string | null;
    pcIp: string | null;
    ts: string | null;
    customValues: unknown;
  };
  debug: NestpickModeDebug;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pickCaseInsensitive(source: Record<string, unknown> | null, candidates: string[]): unknown {
  if (!source) return undefined;
  for (const candidate of candidates) {
    const wanted = candidate.toLowerCase();
    for (const [k, v] of Object.entries(source)) {
      if (k.toLowerCase() === wanted) return v;
    }
  }
  return undefined;
}

function toBooleanish(value: unknown): boolean | null {
  if (value == null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (!v) return null;
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  }
  return null;
}

export function extractNestpickEnabledFromCustomValues(customValues: unknown): boolean | null {
  const obj = toRecord(customValues);
  if (!obj) return null;

  // Support both spellings because the collector might change.
  const keyObj = toRecord(pickCaseInsensitive(obj, ['nestpick_enable', 'nestpick_enabled']));
  if (!keyObj) {
    // Also support a simplified shape: { nestpick_enable: 1 }
    const direct = pickCaseInsensitive(obj, ['nestpick_enable', 'nestpick_enabled']);
    if (direct != null && typeof direct !== 'object') {
      return toBooleanish(direct);
    }
    return null;
  }

  // Intentionally ignore the nested "name" field (user plans to remove it later).
  const value = pickCaseInsensitive(keyObj, ['value']);
  return toBooleanish(value);
}

function extractNestpickEnabledDebugFromCustomValues(customValues: unknown): NestpickModeDebug {
  const obj = toRecord(customValues);
  if (!obj) {
    return { enabled: null, reason: 'custom_values is not an object', matchedKey: null, rawValue: null };
  }

  const candidates = ['nestpick_enable', 'nestpick_enabled'];

  // Support both spellings because the collector might change.
  const matched = (() => {
    for (const candidate of candidates) {
      const wanted = candidate.toLowerCase();
      for (const [k, v] of Object.entries(obj)) {
        if (k.toLowerCase() === wanted) return { key: k, value: v };
      }
    }
    return null;
  })();

  if (!matched) {
    return {
      enabled: null,
      reason: `custom_values missing nestpick key; expected one of: ${candidates.join(', ')}`,
      matchedKey: null,
      rawValue: null
    };
  }

  // Shape A: { nestpick_enable: { value: 1, ... } }
  const keyObj = toRecord(matched.value);
  if (keyObj) {
    const rawValue = pickCaseInsensitive(keyObj, ['value']);
    const enabled = toBooleanish(rawValue);
    if (enabled == null) {
      return {
        enabled: null,
        reason: `custom_values.${matched.key}.value is not boolean-ish; expected 0 or 1 or true or false`,
        matchedKey: matched.key,
        rawValue
      };
    }
    return {
      enabled,
      reason: `custom_values.${matched.key}.value parsed successfully`,
      matchedKey: matched.key,
      rawValue
    };
  }

  // Shape B: { nestpick_enable: 1 }
  const enabled = toBooleanish(matched.value);
  if (enabled == null) {
    return {
      enabled: null,
      reason: `custom_values.${matched.key} is not boolean-ish; expected 0 or 1 or true or false`,
      matchedKey: matched.key,
      rawValue: matched.value
    };
  }
  return {
    enabled,
    reason: `custom_values.${matched.key} parsed successfully`,
    matchedKey: matched.key,
    rawValue: matched.value
  };
}

const STATS_HOST_EXPR = `split_part(split_part(regexp_replace(lower(btrim(cs.pc_ip)), '^https?://', ''), '/', 1), ':', 1)`;
const STATS_HOST_NORM_EXPR = `regexp_replace(${STATS_HOST_EXPR}, '\\s+', '', 'g')`;

const PARAM_HOST_EXPR = `split_part(split_part(regexp_replace(lower(btrim($1)), '^https?://', ''), '/', 1), ':', 1)`;
const PARAM_HOST_NORM_EXPR = `regexp_replace(${PARAM_HOST_EXPR}, '\\s+', '', 'g')`;

export async function getLatestNestpickEnabledForPcIp(pcIp: string): Promise<NestpickModeResult> {
  const trimmed = (pcIp ?? '').trim();
  if (!trimmed) return { enabled: null, lastSeenAt: null };

  try {
    const row = await withClient(async (client) => {
      const sql = `
        SELECT
          cs.custom_values AS custom_values,
          cs.ts AS ts
        FROM public.cncstats cs
        WHERE cs.pc_ip IS NOT NULL
          AND btrim(cs.pc_ip) <> ''
          AND ${STATS_HOST_NORM_EXPR} = ${PARAM_HOST_NORM_EXPR}
        ORDER BY cs.ts DESC
        LIMIT 1
      `;
      const res = await client.query<{ custom_values: unknown; ts: Date | string | null }>(sql, [trimmed]);
      return res.rows[0] ?? null;
    });

    if (!row) return { enabled: null, lastSeenAt: null };

    const lastSeenAt =
      row.ts instanceof Date
        ? row.ts.toISOString()
        : typeof row.ts === 'string'
          ? row.ts
          : null;

    const enabled = extractNestpickEnabledFromCustomValues((row as { custom_values?: unknown }).custom_values);
    return { enabled, lastSeenAt };
  } catch {
    // If the column does not exist or the query fails, treat as unknown.
    return { enabled: null, lastSeenAt: null };
  }
}

export async function getLatestNestpickEnabledDebugForPcIp(pcIp: string): Promise<NestpickModeDebugResult> {
  const trimmed = (pcIp ?? '').trim();
  if (!trimmed) {
    return {
      enabled: null,
      lastSeenAt: null,
      row: { key: null, pcIp: null, ts: null, customValues: null },
      debug: {
        enabled: null,
        reason: 'machine pcIp is blank; cannot query cncstats',
        matchedKey: null,
        rawValue: null
      }
    };
  }

  try {
    const row = await withClient(async (client) => {
      const sql = `
        SELECT
          cs.key AS key,
          cs.pc_ip AS pc_ip,
          cs.custom_values AS custom_values,
          cs.ts AS ts
        FROM public.cncstats cs
        WHERE cs.pc_ip IS NOT NULL
          AND btrim(cs.pc_ip) <> ''
          AND ${STATS_HOST_NORM_EXPR} = ${PARAM_HOST_NORM_EXPR}
        ORDER BY cs.ts DESC
        LIMIT 1
      `;
      const res = await client.query<{ key: string; pc_ip: string | null; custom_values: unknown; ts: Date | string | null }>(
        sql,
        [trimmed]
      );
      return res.rows[0] ?? null;
    });

    if (!row) {
      return {
        enabled: null,
        lastSeenAt: null,
        row: { key: null, pcIp: trimmed, ts: null, customValues: null },
        debug: {
          enabled: null,
          reason: 'no cncstats rows found for this pcIp',
          matchedKey: null,
          rawValue: null
        }
      };
    }

    const lastSeenAt =
      row.ts instanceof Date
        ? row.ts.toISOString()
        : typeof row.ts === 'string'
          ? row.ts
          : null;

    const debug = extractNestpickEnabledDebugFromCustomValues((row as { custom_values?: unknown }).custom_values);

    return {
      enabled: debug.enabled,
      lastSeenAt,
      row: {
        key: row.key ?? null,
        pcIp: row.pc_ip ?? null,
        ts: lastSeenAt,
        customValues: (row as { custom_values?: unknown }).custom_values
      },
      debug
    };
  } catch {
    return {
      enabled: null,
      lastSeenAt: null,
      row: { key: null, pcIp: trimmed, ts: null, customValues: null },
      debug: {
        enabled: null,
        reason: 'query failed; treating nestpick mode as unknown',
        matchedKey: null,
        rawValue: null
      }
    };
  }
}
