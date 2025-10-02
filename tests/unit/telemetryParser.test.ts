import { describe, expect, it } from 'vitest';
import { normalizeTelemetryPayload } from '../../packages/main/src/workers/telemetryParser';
import type { Machine } from '../../packages/shared/src';

describe('normalizeTelemetryPayload', () => {
  const baseMachine: Machine = {
    machineId: 7,
    name: 'Router A',
    pcIp: '10.0.0.5',
    cncIp: null,
    cncPort: null,
    apJobfolder: 'c:/jobs',
    nestpickFolder: 'c:/nestpick',
    nestpickEnabled: true,
    pcPort: 5000
  };

  it('maps flat payload fields', () => {
    const payload = {
      status: 'RUN',
      mode: 'AUTO',
      alarm: 'ok',
      currentProgram: 'JOB123',
      powerOnTime: '12:34',
      cuttingTime: '01:20'
    };
    const result = normalizeTelemetryPayload(baseMachine, payload);
    expect(result.key).toBe('Router A');
    expect(result.status).toBe('RUN');
    expect(result.mode).toBe('AUTO');
    expect(result.currentProgram).toBe('JOB123');
    expect(result.powerOnTime).toBe('12:34');
    expect(result.cuttingTime).toBe('01:20');
    expect(result.apiIp).toBe('10.0.0.5');
  });

  it('extracts nested timer fields and payload key override', () => {
    const payload = {
      key: 'Router-Override',
      timers: {
        power_on: '88:00',
        cutting_time: '03:45'
      },
      alarmHistory: 'none'
    };
    const result = normalizeTelemetryPayload(baseMachine, payload);
    expect(result.key).toBe('Router-Override');
    expect(result.powerOnTime).toBe('88:00');
    expect(result.cuttingTime).toBe('03:45');
    expect(result.alarmHistory).toBe('none');
  });

  it('falls back to machine identifier when name missing', () => {
    const unnamed: Machine = { ...baseMachine, name: '', machineId: 42 };
    const result = normalizeTelemetryPayload(unnamed, {});
    expect(result.key).toBe('Machine 42');
  });
});
