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
  paths: { processedJobsRoot: '', autoPacCsvDir: '', autoPacArchiveEnabled: false, grundnerFolderPath: '', archiveRoot: '', jobsRoot: '', quarantineRoot: '' },
  test: { testDataFolderPath: '', useTestDataMode: false },
  grundner: {
    tableColumns: {
      typeData: { visible: true, order: 1 },
      materialName: { visible: false, order: 2 },
      materialNumber: { visible: false, order: 3 },
      customerId: { visible: true, order: 4 },
      lengthMm: { visible: true, order: 5 },
      widthMm: { visible: true, order: 6 },
      thicknessMm: { visible: true, order: 7 },
      stock: { visible: true, order: 8 },
      reservedStock: { visible: true, order: 9 },
      stockAvailable: { visible: true, order: 10 },
      lastUpdated: { visible: true, order: 11 }
    }
  },
  inventoryExport: {
    template: {
      delimiter: ',',
      lastUpdatedFormat: 'hh:mm dd.mm.yyyy',
      columns: [
        { kind: 'field', enabled: true, header: 'Type', field: 'typeData' },
        { kind: 'field', enabled: true, header: 'Customer ID', field: 'customerId' },
        { kind: 'field', enabled: true, header: 'Length', field: 'lengthMm' },
        { kind: 'field', enabled: true, header: 'Width', field: 'widthMm' },
        { kind: 'field', enabled: true, header: 'Thickness', field: 'thicknessMm' },
        { kind: 'field', enabled: true, header: 'Pre-Reserved', field: 'preReserved' },
        { kind: 'field', enabled: true, header: 'Stock', field: 'stock' },
        { kind: 'field', enabled: true, header: 'Reserved', field: 'reservedStock' },
        { kind: 'field', enabled: true, header: 'Available', field: 'stockAvailable' },
        { kind: 'field', enabled: true, header: 'Last Updated', field: 'lastUpdated' }
      ]
    },
    scheduled: {
      enabled: false,
      intervalSeconds: 60,
      onlyOnChange: true,
      folderPath: '',
      fileName: 'grundner_inventory.csv'
    }
  },
  jobs: { completedJobsTimeframe: '7days', statusFilter: ['pending', 'processing', 'complete'] },
  validationWarnings: { showValidationWarnings: false }
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
    inventoryExport: {
      template: {
        ...DEFAULT_SETTINGS.inventoryExport.template,
        columns: [...DEFAULT_SETTINGS.inventoryExport.template.columns]
      },
      scheduled: { ...DEFAULT_SETTINGS.inventoryExport.scheduled }
    },
    jobs: { ...DEFAULT_SETTINGS.jobs },
    validationWarnings: { ...DEFAULT_SETTINGS.validationWarnings }
  };
}

function normalizeGrundnerTableColumns(
  input: unknown,
  defaults: Settings['grundner']['tableColumns']
): Settings['grundner']['tableColumns'] {
  const inputRecord =
    input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : null;

  const out: Settings['grundner']['tableColumns'] = { ...defaults };
  for (const key of Object.keys(defaults) as Array<keyof Settings['grundner']['tableColumns']>) {
    const raw = inputRecord?.[key as string];

    // Legacy/dev shape: `{ [key]: boolean }`
    if (typeof raw === 'boolean') {
      out[key] = { ...defaults[key], visible: raw };
      continue;
    }

    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const col = raw as Record<string, unknown>;
      const visible = typeof col.visible === 'boolean' ? col.visible : defaults[key].visible;
      const order = typeof col.order === 'number' && Number.isInteger(col.order) && col.order >= 1 ? col.order : defaults[key].order;
      out[key] = { visible, order };
      continue;
    }
  }

  return out;
}

function normalizeSettings(input: MaybeSettings): Settings {
  const base = (typeof input === 'object' && input !== null ? input : {}) as Partial<Settings>;

  const db: Settings['db'] = { ...DEFAULT_SETTINGS.db, ...(base.db ?? {}) } as Settings['db'];
  // Coerce password to a string to avoid pg errors when null/number are provided
  db.password = typeof db.password === 'string' ? db.password : (db.password == null ? '' : String(db.password));

  const inventoryExportBase = (base.inventoryExport ?? {}) as Partial<Settings['inventoryExport']>;
  const templateBase = (inventoryExportBase.template ?? {}) as Partial<Settings['inventoryExport']['template']>;
  const scheduledBase = (inventoryExportBase.scheduled ?? {}) as Partial<Settings['inventoryExport']['scheduled']>;

  const template: Settings['inventoryExport']['template'] = {
    ...DEFAULT_SETTINGS.inventoryExport.template,
    ...templateBase,
    columns: Array.isArray(templateBase.columns) ? templateBase.columns : DEFAULT_SETTINGS.inventoryExport.template.columns
  };

  const scheduled: Settings['inventoryExport']['scheduled'] = {
    ...DEFAULT_SETTINGS.inventoryExport.scheduled,
    ...scheduledBase
  };

  const grundnerBase = (base.grundner ?? {}) as Partial<Settings['grundner']>;
  const tableColumns = normalizeGrundnerTableColumns(
    grundnerBase.tableColumns,
    DEFAULT_SETTINGS.grundner.tableColumns
  );

  const grundner: Settings['grundner'] = { tableColumns };

  return {
    version: typeof base.version === 'number' && base.version > 0 ? base.version : CURRENT_SETTINGS_VERSION,
    db,
    paths: { ...DEFAULT_SETTINGS.paths, ...(base.paths ?? {}) },
    test: { ...DEFAULT_SETTINGS.test, ...(base.test ?? {}) },
    grundner,
    inventoryExport: { template, scheduled },
    jobs: { ...DEFAULT_SETTINGS.jobs, ...(base.jobs ?? {}) },
    validationWarnings: { ...DEFAULT_SETTINGS.validationWarnings, ...(base.validationWarnings ?? {}) }
  };
}

function mergeSettingsInternal(base: Settings, update: MaybeSettings): Settings {
  const partial = (typeof update === 'object' && update !== null ? update : {}) as Partial<Settings>;
  const grundnerTableColumns =
    partial.grundner?.tableColumns != null
      ? { ...base.grundner.tableColumns, ...partial.grundner.tableColumns }
      : base.grundner.tableColumns;
  return normalizeSettings({
    version: partial.version ?? base.version,
    db: { ...base.db, ...(partial.db ?? {}) },
    paths: { ...base.paths, ...(partial.paths ?? {}) },
    test: { ...base.test, ...(partial.test ?? {}) },
    grundner: { ...base.grundner, ...(partial.grundner ?? {}), tableColumns: grundnerTableColumns },
    inventoryExport: {
      template: { ...base.inventoryExport.template, ...((partial.inventoryExport?.template ?? {}) as Partial<Settings['inventoryExport']['template']>) },
      scheduled: { ...base.inventoryExport.scheduled, ...((partial.inventoryExport?.scheduled ?? {}) as Partial<Settings['inventoryExport']['scheduled']>) }
    },
    jobs: { ...base.jobs, ...(partial.jobs ?? {}) },
    validationWarnings: { ...base.validationWarnings, ...(partial.validationWarnings ?? {}) }
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
