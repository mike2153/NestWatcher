import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const ENV_KEY = 'WOODTRON_USER_DATA_PATH';

describe('config service', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'woodtron-config-'));
    process.env[ENV_KEY] = tempDir;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env[ENV_KEY];
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function loadModule() {
    return import('../../packages/main/src/services/config');
  }

  it('creates defaults when config file missing', async () => {
    const { loadConfig } = await loadModule();
    const cfg = loadConfig();
    expect(cfg.db.host).toBe('localhost');
    const file = join(tempDir, 'settings.json');
    expect(existsSync(file)).toBe(true);
    const written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written.db.host).toBe('localhost');
  });

  it('persists overrides and reloads them', async () => {
    const mod = await loadModule();
    const next = mod.loadConfig();
    next.db.host = 'db.internal';
    next.paths.processedJobsRoot = 'C:/jobs';
    next.db.password = 'secret';
    mod.saveConfig(next);

    vi.resetModules();
    process.env[ENV_KEY] = tempDir;
    const reloaded = (await loadModule()).loadConfig();
    expect(reloaded.db.host).toBe('db.internal');
    expect(reloaded.paths.processedJobsRoot).toBe('C:/jobs');
  });

  it('redacts sensitive settings', async () => {
    const { loadConfig, redactSettings } = await loadModule();
    const cfg = loadConfig();
    cfg.db.password = 'secret';
    const sanitized = redactSettings(cfg);
    expect(sanitized.db.password).toBe('********');
  });
});
