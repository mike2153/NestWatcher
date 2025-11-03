import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { DbSettingsSchema, CURRENT_SETTINGS_VERSION } from '../../../shared/src';
import type { Settings } from '../../../shared/src';
import type { App as ElectronApp } from 'electron';
import { logger } from '../logger';

let electronApp: ElectronApp | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { app } = require('electron');
  electronApp = app as ElectronApp;
} catch {
  // In worker/thread contexts the electron module is unavailable; fall back to Node paths.
  electronApp = undefined;
}

const DEFAULT_SETTINGS: Settings = {
  version: CURRENT_SETTINGS_VERSION,
  db: {
    host: 'localhost',
    port: 5432,
    database: 'woodtron',
    user: 'woodtron_user',
    password: '',
    sslMode: 'disable',
    statementTimeoutMs: 30000
  },
  paths: { processedJobsRoot: '', autoPacCsvDir: '', grundnerFolderPath: '', archiveRoot: '' },
  test: { testDataFolderPath: '', useTestDataMode: false, sheetIdMode: 'type_data' },
  grundner: { reservedAdjustmentMode: 'delta' },
  jobs: { completedJobsTimeframe: '7days', statusFilter: ['pending', 'processing', 'complete'] }
};

let cache: Settings | null = null;

type MaybeSettings = Partial<Settings> | undefined | null | { [key: string]: unknown };

function cloneDefaults(): Settings {
  return {
    version: CURRENT_SETTINGS_VERSION,
    db: { ...DEFAULT_SETTINGS.db },
    paths: { ...DEFAULT_SETTINGS.paths },
    test: { ...DEFAULT_SETTINGS.test },
    grundner: { ...DEFAULT_SETTINGS.grundner },
    jobs: { ...DEFAULT_SETTINGS.jobs }
  };
}

function normalizeSettings(input: MaybeSettings): Settings {
  const base = (typeof input === 'object' && input !== null ? input : {}) as Partial<Settings>;
  const db: Settings['db'] = { ...DEFAULT_SETTINGS.db, ...(base.db ?? {}) } as Settings['db'];
  // Coerce password to a string to avoid pg errors when null/number are provided
  db.password = typeof db.password === 'string' ? db.password : (db.password == null ? '' : String(db.password));
  return {
    version: typeof base.version === 'number' && base.version > 0 ? base.version : CURRENT_SETTINGS_VERSION,
    db,
    paths: { ...DEFAULT_SETTINGS.paths, ...(base.paths ?? {}) },
    test: { ...DEFAULT_SETTINGS.test, ...(base.test ?? {}) },
    grundner: { ...DEFAULT_SETTINGS.grundner, ...(base.grundner ?? {}) },
    jobs: { ...DEFAULT_SETTINGS.jobs, ...(base.jobs ?? {}) }
  };
}

function mergeSettingsInternal(base: Settings, update: MaybeSettings): Settings {
  const partial = (typeof update === 'object' && update !== null ? update : {}) as Partial<Settings>;
  return normalizeSettings({
    version: partial.version ?? base.version,
    db: { ...base.db, ...(partial.db ?? {}) },
    paths: { ...base.paths, ...(partial.paths ?? {}) },
    test: { ...base.test, ...(partial.test ?? {}) },
    grundner: { ...base.grundner, ...(partial.grundner ?? {}) },
    jobs: { ...base.jobs, ...(partial.jobs ?? {}) }
  });
}

// Strict config path policy:
// - Dev: settings.json at repo root (relative to compiled main at packages/main/dist)
// - Prod: settings.json next to the .exe (dirname(process.execPath))
export function getConfigPath() {
  const override = process.env.WOODTRON_CONFIG_PATH?.trim();
  if (override) {
    return override;
  }

  // Prefer Electron's userData directory in both dev and prod to avoid polluting the repo
  try {
    const userDataDir = electronApp?.getPath?.('userData');
    if (userDataDir && typeof userDataDir === 'string') {
      return join(userDataDir, 'settings.json');
    }
  } catch {
    // fall through to process.execPath below
  }

  const isPackaged = electronApp?.isPackaged ?? false;
  if (isPackaged) {
    return join(dirname(process.execPath), 'settings.json');
  }

  // Last resort in dev environments without Electron context
  return join(__dirname, '../../../settings.json');
}

export function loadConfig(): Settings {
  if (cache) return cache;
  const file = getConfigPath();
  try {
    if (!existsSync(file)) {
      const defaults = cloneDefaults();
      writeConfig(defaults);
      logger.info({ file }, 'Config created with defaults');
      return defaults;
    }
    const raw = readFileSync(file, 'utf8');
    const parsedJson = JSON.parse(raw);
    const normalized = normalizeSettings(parsedJson);
    cache = normalized;
    logger.info({ file }, 'Config loaded');
    // Do not rewrite automatically; only write on explicit save
    return normalized;
  } catch (err) {
    logger.warn({ err }, 'Failed to load config, falling back to defaults');
    throw err instanceof Error ? err : new Error(String(err));
  }
}

function writeConfig(settings: Settings) {
  const file = getConfigPath();
  const dir = dirname(file);
  const normalized = normalizeSettings(settings);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(normalized, null, 2), 'utf8');
  cache = normalized;
  logger.info({ file }, 'Config saved');
}

export function saveConfig(next: Settings | Partial<Settings>) {
  const file = getConfigPath();
  const current = cache ?? (existsSync(file) ? normalizeSettings(JSON.parse(readFileSync(file, 'utf8'))) : cloneDefaults());
  const merged = mergeSettingsInternal(current, next as MaybeSettings);
  writeConfig(merged);
}

export function mergeSettings(update: Partial<Settings>): Settings {
  const current = loadConfig();
  return mergeSettingsInternal(current, update);
}

export function overwriteConfig(settings: Settings) {
  writeConfig(settings);
}

export function redactSettings(settings: Settings): Settings {
  return {
    ...settings,
    db: { ...settings.db, password: settings.db.password ? '********' : '' }
  };
}

export function validateDbSettings(partial: Partial<Settings['db']>) {
  return DbSettingsSchema.partial().parse(partial);
}
