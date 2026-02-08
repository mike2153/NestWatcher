type ColumnPref = {
  visible: boolean;
  order: number;
};

export type JobsTableColumnKey =
  | 'folder'
  | 'ncfile'
  | 'material'
  | 'parts'
  | 'size'
  | 'dateadded'
  | 'locked'
  | 'status'
  | 'processingSeconds'
  | 'machineId';

export type RouterTableColumnKey =
  | 'machine'
  | 'relativePath'
  | 'name'
  | 'jobMaterial'
  | 'jobSize'
  | 'jobParts'
  | 'status'
  | 'addedAtR2R'
  | 'inDatabase';

export type JobsTableColumns = Record<JobsTableColumnKey, ColumnPref>;
export type RouterTableColumns = Record<RouterTableColumnKey, ColumnPref>;

export type UserTableViewPrefs = {
  version: 1;
  jobs: JobsTableColumns;
  router: RouterTableColumns;
};

export const TABLE_VIEW_PREFS_UPDATED_EVENT = 'table-view-prefs-updated';

const STORAGE_PREFIX = 'nestwatcher.tableViews.v1.user';

const REQUIRED_JOB_COLUMNS: ReadonlySet<JobsTableColumnKey> = new Set<JobsTableColumnKey>(['folder', 'ncfile', 'status']);
const REQUIRED_ROUTER_COLUMNS: ReadonlySet<RouterTableColumnKey> = new Set<RouterTableColumnKey>([
  'relativePath',
  'name',
  'status'
]);

const JOB_COLUMN_KEYS: JobsTableColumnKey[] = [
  'folder',
  'ncfile',
  'material',
  'parts',
  'size',
  'dateadded',
  'locked',
  'status',
  'processingSeconds',
  'machineId'
];

const ROUTER_COLUMN_KEYS: RouterTableColumnKey[] = [
  'machine',
  'relativePath',
  'name',
  'jobMaterial',
  'jobSize',
  'jobParts',
  'status',
  'addedAtR2R',
  'inDatabase'
];

export const JOB_COLUMN_LABELS: Array<{ key: JobsTableColumnKey; label: string; required: boolean }> = [
  { key: 'folder', label: 'Folder', required: true },
  { key: 'ncfile', label: 'NC File', required: true },
  { key: 'material', label: 'Material', required: false },
  { key: 'parts', label: 'Parts', required: false },
  { key: 'size', label: 'Dimensions', required: false },
  { key: 'dateadded', label: 'Date Added', required: false },
  { key: 'locked', label: 'Reserved', required: false },
  { key: 'status', label: 'Status', required: true },
  { key: 'processingSeconds', label: 'Processing Time', required: false },
  { key: 'machineId', label: 'Machine', required: false }
];

export const ROUTER_COLUMN_LABELS: Array<{ key: RouterTableColumnKey; label: string; required: boolean }> = [
  { key: 'machine', label: 'Machine', required: false },
  { key: 'relativePath', label: 'Folder', required: true },
  { key: 'name', label: 'NC File', required: true },
  { key: 'jobMaterial', label: 'Material', required: false },
  { key: 'jobSize', label: 'Size', required: false },
  { key: 'jobParts', label: 'Parts', required: false },
  { key: 'status', label: 'Status', required: true },
  { key: 'addedAtR2R', label: 'Staged', required: false },
  { key: 'inDatabase', label: 'In Database', required: false }
];

const DEFAULT_JOBS_TABLE_COLUMNS_INTERNAL: JobsTableColumns = {
  folder: { visible: true, order: 1 },
  ncfile: { visible: true, order: 2 },
  material: { visible: true, order: 3 },
  parts: { visible: true, order: 4 },
  size: { visible: true, order: 5 },
  dateadded: { visible: true, order: 6 },
  locked: { visible: true, order: 7 },
  status: { visible: true, order: 8 },
  processingSeconds: { visible: true, order: 9 },
  machineId: { visible: true, order: 10 }
};

const DEFAULT_ROUTER_TABLE_COLUMNS_INTERNAL: RouterTableColumns = {
  machine: { visible: true, order: 1 },
  relativePath: { visible: true, order: 2 },
  name: { visible: true, order: 3 },
  jobMaterial: { visible: true, order: 4 },
  jobSize: { visible: true, order: 5 },
  jobParts: { visible: true, order: 6 },
  status: { visible: true, order: 7 },
  addedAtR2R: { visible: true, order: 8 },
  inDatabase: { visible: true, order: 9 }
};

function cloneColumnPrefs<T extends string>(source: Record<T, ColumnPref>, keys: readonly T[]): Record<T, ColumnPref> {
  const out = {} as Record<T, ColumnPref>;
  for (const key of keys) {
    const next = source[key];
    out[key] = { visible: Boolean(next.visible), order: Number(next.order) };
  }
  return out;
}

function normalizeColumnPrefs<T extends string>(
  raw: unknown,
  defaults: Record<T, ColumnPref>,
  keys: readonly T[],
  requiredColumns: ReadonlySet<T>
): Record<T, ColumnPref> {
  const base = cloneColumnPrefs(defaults, keys);
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;

  for (const key of keys) {
    const input = record?.[key];
    if (typeof input === 'boolean') {
      base[key].visible = input;
      continue;
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      continue;
    }

    const value = input as Record<string, unknown>;
    if (typeof value.visible === 'boolean') {
      base[key].visible = value.visible;
    }
    if (typeof value.order === 'number' && Number.isInteger(value.order) && value.order > 0) {
      base[key].order = value.order;
    }
  }

  // Required columns are always visible.
  for (const key of requiredColumns) {
    base[key].visible = true;
  }

  // Normalize order for visible columns and keep deterministic order for hidden columns.
  const visible = keys
    .filter((key) => base[key].visible)
    .sort((a, b) => {
      const orderDiff = base[a].order - base[b].order;
      if (orderDiff !== 0) return orderDiff;
      return keys.indexOf(a) - keys.indexOf(b);
    });
  const hidden = keys.filter((key) => !base[key].visible);

  let nextOrder = 1;
  for (const key of visible) {
    base[key].order = nextOrder++;
  }
  for (const key of hidden) {
    base[key].order = nextOrder++;
  }

  return base;
}

function storageKeyForUser(userId: number): string {
  return `${STORAGE_PREFIX}:${userId}`;
}

export function createDefaultJobsTableColumns(): JobsTableColumns {
  return cloneColumnPrefs(DEFAULT_JOBS_TABLE_COLUMNS_INTERNAL, JOB_COLUMN_KEYS);
}

export function createDefaultRouterTableColumns(): RouterTableColumns {
  return cloneColumnPrefs(DEFAULT_ROUTER_TABLE_COLUMNS_INTERNAL, ROUTER_COLUMN_KEYS);
}

export function loadTableViewPrefsForUser(userId: number): UserTableViewPrefs {
  const defaults: UserTableViewPrefs = {
    version: 1,
    jobs: createDefaultJobsTableColumns(),
    router: createDefaultRouterTableColumns()
  };

  try {
    const raw = window.localStorage.getItem(storageKeyForUser(userId));
    if (!raw) return defaults;

    const parsed = JSON.parse(raw) as {
      version?: unknown;
      jobs?: unknown;
      router?: unknown;
    };

    return {
      version: 1,
      jobs: normalizeColumnPrefs(parsed.jobs, defaults.jobs, JOB_COLUMN_KEYS, REQUIRED_JOB_COLUMNS),
      router: normalizeColumnPrefs(parsed.router, defaults.router, ROUTER_COLUMN_KEYS, REQUIRED_ROUTER_COLUMNS)
    };
  } catch {
    return defaults;
  }
}

export function saveTableViewPrefsForUser(userId: number, prefs: UserTableViewPrefs): UserTableViewPrefs {
  const normalized: UserTableViewPrefs = {
    version: 1,
    jobs: normalizeColumnPrefs(prefs.jobs, createDefaultJobsTableColumns(), JOB_COLUMN_KEYS, REQUIRED_JOB_COLUMNS),
    router: normalizeColumnPrefs(
      prefs.router,
      createDefaultRouterTableColumns(),
      ROUTER_COLUMN_KEYS,
      REQUIRED_ROUTER_COLUMNS
    )
  };
  window.localStorage.setItem(storageKeyForUser(userId), JSON.stringify(normalized));
  return normalized;
}

export function resetTableViewPrefsForUser(userId: number): UserTableViewPrefs {
  window.localStorage.removeItem(storageKeyForUser(userId));
  return loadTableViewPrefsForUser(userId);
}

export function emitTableViewPrefsUpdated(userId: number): void {
  window.dispatchEvent(new CustomEvent(TABLE_VIEW_PREFS_UPDATED_EVENT, { detail: { userId } }));
}

