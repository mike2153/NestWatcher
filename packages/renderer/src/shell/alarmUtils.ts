import type { AlarmEntry } from '../../../shared/src';

export function selectCurrentAlarms(entries: AlarmEntry[]): AlarmEntry[] {
  if (!entries.length) return [];
  const seen = new Set<string>();
  const result: AlarmEntry[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    result.push(entry);
  }
  return result;
}
