import {
  bigserial,
  boolean,
  inet,
  integer,
  jsonb,
  uuid,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
  pgView,
  real,
  numeric
} from 'drizzle-orm/pg-core';

export const jobStatusEnum = pgEnum('job_status', [
  'PENDING',
  'STAGED',
  'LOAD_FINISH',
  'LABEL_FINISH',
  'CNC_FINISH',
  'FORWARDED_TO_NESTPICK',
  'NESTPICK_COMPLETE'
]);

export const machines = pgTable('machines', {
  machineId: serial('machine_id').primaryKey(),
  name: text('name').notNull(),
  pcIp: inet('pc_ip'),
  apJobfolder: text('ap_jobfolder').notNull(),
  nestpickFolder: text('nestpick_folder').notNull(),
  nestpickEnabled: boolean('nestpick_enabled').default(true).notNull(),
  ncCatMachineId: text('nc_cat_machine_id'),
  ncCatConfig: jsonb('nc_cat_config').$type<unknown>(),
  settingsVersion: text('settings_version'),
  lastSettingsSyncAt: timestamp('last_settings_sync_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
});

export const toolLibrary = pgTable('tool_library', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  diameterMm: numeric('diameter_mm'),
  lengthMm: numeric('length_mm'),
  materialType: text('material_type'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
});

export const jobs = pgTable('jobs', {
  key: varchar('key', { length: 100 }).primaryKey(),
  folder: varchar('folder', { length: 255 }),
  ncfile: varchar('ncfile', { length: 255 }),
  material: varchar('material', { length: 255 }),
  parts: varchar('parts', { length: 255 }),
  size: varchar('size', { length: 255 }),
  thickness: varchar('thickness', { length: 255 }),
  machineId: integer('machine_id').references(() => machines.machineId, { onDelete: 'set null' }),
  dateAdded: timestamp('dateadded', { withTimezone: true }),
  // New pre-reservation flag (separate from locked)
  preReserved: boolean('pre_reserved').default(false).notNull(),
  // Renamed from is_reserved -> is_locked
  isLocked: boolean('is_locked').default(false).notNull(),
  allocatedAt: timestamp('allocated_at', { withTimezone: true }),
  stagedAt: timestamp('staged_at', { withTimezone: true }),
  cutAt: timestamp('cut_at', { withTimezone: true }),
  nestpickCompletedAt: timestamp('nestpick_completed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  pallet: varchar('pallet', { length: 50 }),
  lastError: text('last_error'),
  qty: integer('qty').default(0).notNull(),
  status: jobStatusEnum('status').default('PENDING').notNull(),
  lockedBy: text('locked_by'),
  stagedBy: text('staged_by')
});

export const jobEvents = pgTable('job_events', {
  eventId: bigserial('event_id', { mode: 'number' }).primaryKey(),
  key: varchar('key', { length: 100 })
    .notNull()
    .references(() => jobs.key, { onDelete: 'cascade' }),
  machineId: integer('machine_id').references(() => machines.machineId, { onDelete: 'set null' }),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').$type<unknown | null>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
});

export const grundner = pgTable('grundner', {
  id: serial('id').primaryKey(),
  typeData: integer('type_data').notNull(),
  customerId: varchar('customer_id', { length: 50 }),
  lengthMm: integer('length_mm'),
  widthMm: integer('width_mm'),
  thicknessMm: integer('thickness_mm'),
  stock: integer('stock'),
  stockAvailable: integer('stock_available'),
  lastUpdated: varchar('last_updated', { length: 50 }),
  reservedStock: integer('reserved_stock').default(0),
  preReserved: integer('pre_reserved').default(0)
});

export const orderingStatus = pgTable('ordering_status', {
  grundnerId: integer('grundner_id').primaryKey().references(() => grundner.id, { onDelete: 'cascade' }),
  ordered: boolean('ordered').default(false).notNull(),
  orderedBy: text('ordered_by'),
  orderedAt: timestamp('ordered_at', { withTimezone: true }),
  comments: varchar('comments', { length: 20 }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
});

export const ncStats = pgTable('nc_stats', {
  jobKey: varchar('job_key', { length: 100 })
    .primaryKey()
    .references(() => jobs.key, { onDelete: 'cascade' }),
  ncEstRuntime: integer('nc_est_runtime'),
  yieldPercentage: real('yield_percentage'),
  wasteOffcutM2: real('waste_offcut_m2'),
  wasteOffcutDustM3: real('waste_offcut_dust_m3'),
  totalToolDustM3: real('total_tool_dust_m3'),
  totalDrillDustM3: real('total_drill_dust_m3'),
  sheetTotalDustM3: real('sheet_total_dust_m3'),
  cuttingDistanceMeters: real('cutting_distance_meters'),
  usableOffcuts: jsonb('usable_offcuts').$type<unknown>(),
  toolUsage: jsonb('tool_usage').$type<unknown>(),
  drillUsage: jsonb('drill_usage').$type<unknown>(),
  validation: jsonb('validation').$type<unknown>(),
  nestpick: jsonb('nestpick').$type<unknown>(),
  mesOutputVersion: text('mes_output_version')
});

export const appUsers = pgTable('app_users', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  username: text('username').notNull(),
  displayName: text('display_name'),
  passwordHash: text('password_hash').notNull(),
  securityPetHash: text('security_pet_hash').notNull(),
  securityMaidenHash: text('security_maiden_hash').notNull(),
  securitySchoolHash: text('security_school_hash').notNull(),
  role: text('role').default('operator').notNull(),
  forcePasswordReset: boolean('force_password_reset').default(false).notNull(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  activeSessionToken: uuid('active_session_token'),
  activeSessionIssuedAt: timestamp('active_session_issued_at', { withTimezone: true }),
  failedAttempts: integer('failed_attempts').default(0).notNull(),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
});

export const allocatedMaterialView = pgView('allocated_material_view', {
  grundnerId: integer('grundner_id'),
  typeData: integer('type_data'),
  customerId: varchar('customer_id', { length: 50 }),
  lengthMm: integer('length_mm'),
  widthMm: integer('width_mm'),
  thicknessMm: integer('thickness_mm'),
  stock: integer('stock'),
  stockAvailable: integer('stock_available'),
  reservedStock: integer('reserved_stock'),
  preReserved: integer('pre_reserved'),
  jobKey: varchar('job_key', { length: 100 }),
  folder: varchar('folder', { length: 255 }),
  ncfile: varchar('ncfile', { length: 255 }),
  material: varchar('material', { length: 255 }),
  jobPreReserved: boolean('job_pre_reserved'),
  jobIsLocked: boolean('job_is_locked'),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  allocatedAt: timestamp('allocated_at', { withTimezone: true }),
  allocationStatus: varchar('allocation_status', { length: 20 })
});

export const schema = {
  jobs,
  machines,
  jobEvents,
  grundner,
  orderingStatus,
  ncStats,
  allocatedMaterialView,
  jobStatusEnum,
  appUsers
};

export type JobStatus = (typeof jobStatusEnum.enumValues)[number];
