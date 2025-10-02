import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeWorker extends EventEmitter {
  public readonly script: string;
  public readonly postMessage = vi.fn();
  public readonly terminate = vi.fn(async () => {});

  constructor(script: string) {
    super();
    this.script = script;
  }
}

const workerState = { instances: [] as FakeWorker[] };
const workerCtor = vi.fn((script: string) => {
  const worker = new FakeWorker(script);
  workerState.instances.push(worker);
  return worker;
});

vi.mock('worker_threads', () => ({
  Worker: workerCtor
}));

const diagnostics = {
  registerWatcher: vi.fn(),
  watcherReady: vi.fn(),
  recordWatcherEvent: vi.fn(),
  recordWatcherError: vi.fn(),
  recordWorkerError: vi.fn(),
  setMachineHealthIssue: vi.fn(),
  clearMachineHealthIssue: vi.fn()
};

vi.mock('../../packages/main/src/services/diagnostics', () => diagnostics);

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
};

vi.mock('../../packages/main/src/logger', () => ({ logger }));

describe('watchers service', () => {
  let watchers: { initWatchers: () => void; shutdownWatchers: () => Promise<void> };

  beforeEach(async () => {
    vi.resetModules();
    workerState.instances.length = 0;
    workerCtor.mockClear();
    Object.values(diagnostics).forEach((fn) => fn.mockClear?.());
    Object.values(logger).forEach((fn) => fn.mockClear?.());
    process.env.WOODTRON_WATCHERS_WORKER_PATH = 'C:/fake/watchersWorker.js';
    watchers = await import('../../packages/main/src/services/watchers');
  });

  afterEach(async () => {
    const instance = workerState.instances[0];
    if (instance) {
      const shutdown = watchers.shutdownWatchers();
      instance.emit('exit', 0);
      await shutdown;
    } else {
      await watchers.shutdownWatchers();
    }
    delete process.env.WOODTRON_WATCHERS_WORKER_PATH;
  });

  it('spawns worker and relays watcher lifecycle events', () => {
    watchers.initWatchers();
    expect(workerCtor).toHaveBeenCalledWith('C:/fake/watchersWorker.js');

    const instance = workerState.instances[0];
    expect(instance).toBeTruthy();

    instance.emit('message', { type: 'registerWatcher', name: 'watcher:auto', label: 'Auto' });
    expect(diagnostics.registerWatcher).toHaveBeenCalledWith('watcher:auto', 'Auto');

    instance.emit('message', { type: 'watcherReady', name: 'watcher:auto', label: 'Auto' });
    expect(diagnostics.watcherReady).toHaveBeenCalledWith('watcher:auto', 'Auto');

    instance.emit('message', {
      type: 'watcherEvent',
      name: 'watcher:auto',
      label: 'Auto',
      message: 'CSV processed',
      context: { job: 'JOB-1' }
    });
    expect(diagnostics.recordWatcherEvent).toHaveBeenCalledWith('watcher:auto', {
      label: 'Auto',
      message: 'CSV processed',
      context: { job: 'JOB-1' }
    });

    instance.emit('message', {
      type: 'watcherError',
      name: 'watcher:auto',
      label: 'Auto',
      error: { message: 'boom', stack: 'stack-trace' },
      context: { job: 'JOB-1' }
    });
    expect(diagnostics.recordWatcherError).toHaveBeenCalledWith(
      'watcher:auto',
      expect.objectContaining({ message: 'boom' }),
      { job: 'JOB-1', label: 'Auto' }
    );
  });

  it('propagates machine health updates and telemetry worker errors', () => {
    watchers.initWatchers();
    const instance = workerState.instances[0];
    expect(instance).toBeTruthy();

    instance.emit('message', {
      type: 'machineHealthSet',
      payload: { machineId: 7, code: 'NO_PARTS_CSV', message: 'Missing parts CSV' }
    });
    expect(diagnostics.setMachineHealthIssue).toHaveBeenCalledWith({
      machineId: 7,
      code: 'NO_PARTS_CSV',
      message: 'Missing parts CSV'
    });

    instance.emit('message', {
      type: 'machineHealthClear',
      payload: { machineId: 7, code: 'NO_PARTS_CSV' }
    });
    expect(diagnostics.clearMachineHealthIssue).toHaveBeenCalledWith(7, 'NO_PARTS_CSV');

    instance.emit('message', {
      type: 'workerError',
      source: 'telemetry:init',
      error: { message: 'telemetry down', stack: 'stack' },
      context: { host: '127.0.0.1' }
    });
    expect(diagnostics.recordWorkerError).toHaveBeenCalledWith(
      'telemetry:init',
      expect.objectContaining({ message: 'telemetry down' }),
      { host: '127.0.0.1' }
    );
  });

  it('shuts down the worker thread gracefully', async () => {
    watchers.initWatchers();
    const instance = workerState.instances[0];
    expect(instance).toBeTruthy();

    const shutdown = watchers.shutdownWatchers();
    expect(instance.postMessage).toHaveBeenCalledWith({ type: 'shutdown', reason: 'app-quit' });
    instance.emit('exit', 0);
    await shutdown;
    expect(instance.terminate).not.toHaveBeenCalled();
  });
});




