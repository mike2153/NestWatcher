import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
const errorMock = vi.fn();

vi.mock('../../packages/main/src/services/db', () => ({
  withClient: async (fn: (client: { query: typeof queryMock }) => unknown) => fn({ query: queryMock })
}));

vi.mock('../../packages/main/src/logger', () => ({
  logger: {
    error: errorMock,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn()
  }
}));

describe('alarms repository', () => {
  beforeEach(() => {
    queryMock.mockReset();
    errorMock.mockReset();
  });

  it('returns only active alarms with derived severity', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          key: 'Router-1',
          alarm: 'Emergency stop triggered',
          status: 'ALARM',
          mode: 'AUTO',
          currentprogram: 'JOB1',
          alarmhistory: 'prev'
        },
        {
          key: 'Router-2',
          alarm: 'OK',
          status: 'READY',
          mode: 'MANUAL',
          currentprogram: 'JOB2',
          alarmhistory: 'hist'
        }
      ]
    });

    const { listActiveAlarms } = await import('../../packages/main/src/repo/alarmsRepo');
    const alarms = await listActiveAlarms();
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toMatchObject({
      key: 'Router-1',
      alarm: 'Emergency stop triggered',
      severity: 'critical'
    });
    expect(typeof alarms[0].lastSeenAt).toBe('string');
  });

  it('logs and returns empty list on failure', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'));
    const { listActiveAlarms } = await import('../../packages/main/src/repo/alarmsRepo');
    const result = await listActiveAlarms();
    expect(result).toEqual([]);
    expect(errorMock).toHaveBeenCalled();
  });
});
