import { describe, expect, it } from 'vitest';
import type { AlarmEntry } from '../../packages/shared/src';
import { selectCurrentAlarms } from '../../packages/renderer/src/shell/alarmUtils';

const createAlarm = (key: string, alarm: string, overrides: Partial<AlarmEntry> = {}): AlarmEntry => ({
  id: `${key}:${alarm}`,
  key,
  alarm,
  status: null,
  mode: null,
  currentProgram: null,
  alarmHistory: null,
  lastSeenAt: '2025-01-01T00:00:00.000Z',
  severity: 'warning',
  ...overrides
});

describe('selectCurrentAlarms', () => {
  it('returns first entry per machine key preserving order', () => {
    const raw: AlarmEntry[] = [
      createAlarm('M1', 'Alarm A'),
      createAlarm('M1', 'Alarm B'),
      createAlarm('M2', 'Alarm X'),
      createAlarm('M2', 'Alarm Y'),
      createAlarm('M3', 'Alarm 1')
    ];

    const current = selectCurrentAlarms(raw);

    expect(current).toHaveLength(3);
    expect(current[0].alarm).toBe('Alarm A');
    expect(current[1].alarm).toBe('Alarm X');
    expect(current[2].alarm).toBe('Alarm 1');
  });

  it('returns empty array when no alarms', () => {
    expect(selectCurrentAlarms([])).toEqual([]);
  });
});
