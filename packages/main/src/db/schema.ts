import {
  bigserial,
  boolean,
  inet,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  varchar
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
  cncIp: inet('cnc_ip'),
  cncPort: integer('cnc_port'),
  apJobfolder: text('ap_jobfolder').notNull(),
  nestpickFolder: text('nestpick_folder').notNull(),
  nestpickEnabled: boolean('nestpick_enabled').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  pcPort: integer('pc_port').default(5000).notNull()
});

export const jobs = pgTable('jobs', {
  key: varchar('key', { length: 100 }).primaryKey(),
  folder: varchar('folder', { length: 255 }),
  ncfile: varchar('ncfile', { length: 255 }),
  material: varchar('material', { length: 255 }),
  parts: varchar('parts', { length: 255 }),
  size: varchar('size', { length: 255 }),
  thickness: varchar('thickness', { length: 255 }),
  isReserved: boolean('is_reserved').default(false).notNull(),
  machineId: integer('machine_id').references(() => machines.machineId, { onDelete: 'set null' }),
  dateAdded: timestamp('dateadded', { withTimezone: true }),
  stagedAt: timestamp('staged_at', { withTimezone: true }),
  cutAt: timestamp('cut_at', { withTimezone: true }),
  nestpickCompletedAt: timestamp('nestpick_completed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  pallet: varchar('pallet', { length: 50 }),
  lastError: text('last_error'),
  status: jobStatusEnum('status').default('PENDING').notNull()
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
  reservedStock: integer('reserved_stock').default(0)
});

export const schema = {
  jobs,
  machines,
  jobEvents,
  grundner,
  jobStatusEnum
};

export type JobStatus = (typeof jobStatusEnum.enumValues)[number];
