import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const dbStatusMock = vi.fn(() => ({
  online: true,
  checkedAt: new Date().toISOString(),
  latencyMs: 12,
  error: null
}));

vi.mock('../../packages/main/src/services/dbWatchdog', () => ({
  getDbStatus: dbStatusMock
}));

vi.mock('../../packages/main/src/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}));

describe('diagnostics service', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'woodtron-diagnostics-'));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function loadDiagnostics() {
    return import('../../packages/main/src/services/diagnostics');
  }

  it('loads existing error log on initialization', async () => {
    const logPath = join(tempDir, 'worker-errors.jsonl');
    const existing = { id: '1', source: 'worker', message: 'prior error', timestamp: new Date().toISOString() };
    writeFileSync(logPath, JSON.stringify(existing) + '\n');

    const diagnostics = await loadDiagnostics();
    await diagnostics.initializeDiagnostics(tempDir);
    const snapshot = diagnostics.getDiagnosticsSnapshot();
    expect(snapshot.recentErrors).toHaveLength(1);
    expect(snapshot.recentErrors[0].message).toBe('prior error');
  });

  it('records watcher transitions and worker errors', async () => {
    const diagnostics = await loadDiagnostics();
    await diagnostics.initializeDiagnostics(tempDir);

    diagnostics.registerWatcher('watcher:auto', 'Auto Watcher');
    diagnostics.watcherReady('watcher:auto', 'Auto Watcher');

    const snapshots: string[] = [];
    const unsubscribe = diagnostics.subscribeDiagnostics((snapshot) => {
      snapshots.push(snapshot.lastUpdatedAt);
    });

    const entry = diagnostics.recordWorkerError('test-source', new Error('boom'), { job: 'A1' });
    expect(entry.message).toBe('boom');
    expect(entry.source).toBe('test-source');

    const snapshot = diagnostics.getDiagnosticsSnapshot();
    expect(snapshot.watchers[0]).toMatchObject({
      name: 'watcher:auto',
      status: 'watching'
    });
    expect(snapshot.recentErrors[0].message).toBe('boom');
    expect(snapshots.length).toBeGreaterThan(0);

    unsubscribe();

    await new Promise((resolve) => setTimeout(resolve, 20));

    const logPath = join(tempDir, 'worker-errors.jsonl');
    const written = readFileSync(logPath, 'utf8');
    expect(written).toContain('boom');
  });
});
