import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';

import { machines, toolLibrary } from '../packages/main/src/db/schema';
import { applyNcCatSettingsSnapshotToDb } from '../packages/main/src/services/ncCatSettings';

async function createTestDb() {
  const mem = newDb();

  mem.public.none(`
    CREATE TABLE machines (
      machine_id SERIAL PRIMARY KEY,
      name text NOT NULL,
      ap_jobfolder text NOT NULL,
      nestpick_folder text NOT NULL,
      nestpick_enabled boolean NOT NULL DEFAULT true,
      nc_cat_machine_id text,
      nc_cat_config jsonb,
      settings_version text,
      last_settings_sync_at timestamptz,
      created_at timestamptz default now() not null,
      updated_at timestamptz default now() not null
    );

    CREATE TABLE tool_library (
      id text primary key,
      name text not null,
      type text not null,
      diameter_mm numeric,
      length_mm numeric,
      material_type text,
      notes text,
      created_at timestamptz default now() not null,
      updated_at timestamptz default now() not null
    );
  `);

  const pg = mem.adapters.createPg();
  const client = new pg.Client();
  await client.connect();
  const db = drizzle(client, { schema: { machines, toolLibrary } });

  return { client, db };
}

describe('applyNcCatSettingsSnapshotToDb', () => {
  it('inserts a new machine and tool library tools', async () => {
    const { client, db } = await createTestDb();
    const now = new Date('2025-12-12T12:00:00Z');
    try {
      const snapshot = {
        schemaVersion: 1,
        version: 'v3',
        lastModified: now.toISOString(),
        machines: [
          {
            id: 'm1',
            name: 'Machine One',
            toolLibrary: [
              { id: 't1', name: 'Tool One', type: 'drill', diameter: 5, length: 50 }
            ],
            lastModified: now.toISOString()
          }
        ],
        toolLibrary: [{ id: 't1', name: 'Tool One', type: 'drill', diameter: 5, length: 50 }]
      };

      const result = await applyNcCatSettingsSnapshotToDb(db, snapshot as any, now);
      expect(result.ok).toBe(true);
      expect(result.appliedMachines).toBe(1);
      expect(result.appliedTools).toBe(1);

      const machineRows = await db.select().from(machines);
      expect(machineRows).toHaveLength(1);
      expect(machineRows[0].ncCatMachineId).toBe('m1');
      expect(machineRows[0].name).toBe('Machine One');

      const toolRows = await db.select().from(toolLibrary);
      expect(toolRows).toHaveLength(1);
      expect(toolRows[0].id).toBe('t1');
      expect(Number(toolRows[0].diameterMm)).toBe(5);
    } finally {
      await client.end();
    }
  });

  it('updates an existing machine config when snapshot is newer', async () => {
    const { client, db } = await createTestDb();
    const existingSyncAt = new Date('2025-12-01T00:00:00Z');
    const now = new Date('2025-12-12T12:00:00Z');
    try {
      await db.insert(machines).values({
        name: 'Old Name',
        apJobfolder: '',
        nestpickFolder: '',
        nestpickEnabled: true,
        ncCatMachineId: 'm1',
        ncCatConfig: { id: 'm1', name: 'Old Name' },
        settingsVersion: 'old',
        lastSettingsSyncAt: existingSyncAt
      });

      const snapshot = {
        schemaVersion: 1,
        version: 'v3',
        lastModified: now.toISOString(),
        machines: [{ id: 'm1', name: 'New Name', lastModified: now.toISOString() }]
      };

      const result = await applyNcCatSettingsSnapshotToDb(db, snapshot as any, now);
      expect(result.ok).toBe(true);
      expect(result.appliedMachines).toBe(1);

      const [row] = await db
        .select()
        .from(machines)
        .where(eq(machines.ncCatMachineId, 'm1'))
        .limit(1);
      expect(row.name).toBe('New Name');
      expect(row.settingsVersion).toBe('v3');
      expect(row.lastSettingsSyncAt?.toISOString()).toBe(now.toISOString());
    } finally {
      await client.end();
    }
  });

  it('upserts tools in tool_library', async () => {
    const { client, db } = await createTestDb();
    const now = new Date('2025-12-12T12:00:00Z');
    try {
      await db.insert(toolLibrary).values({
        id: 't1',
        name: 'Old Tool',
        type: 'drill',
        diameterMm: '4',
        lengthMm: '40'
      });

      const snapshot = {
        schemaVersion: 1,
        version: 'v3',
        lastModified: now.toISOString(),
        machines: [{ id: 'm1' }],
        toolLibrary: [{ id: 't1', name: 'New Tool', type: 'drill', diameter: 6, length: 60 }]
      };

      const result = await applyNcCatSettingsSnapshotToDb(db, snapshot as any, now);
      expect(result.appliedTools).toBe(1);

      const [tool] = await db.select().from(toolLibrary).where(eq(toolLibrary.id, 't1')).limit(1);
      expect(tool.name).toBe('New Tool');
      expect(Number(tool.diameterMm)).toBe(6);
      expect(Number(tool.lengthMm)).toBe(60);
    } finally {
      await client.end();
    }
  });

  it('rejects stale snapshots per machine', async () => {
    const { client, db } = await createTestDb();
    const existingSyncAt = new Date('2025-12-12T12:00:00Z');
    const now = new Date('2025-12-13T00:00:00Z');
    try {
      await db.insert(machines).values({
        name: 'Current Name',
        apJobfolder: '',
        nestpickFolder: '',
        nestpickEnabled: true,
        ncCatMachineId: 'm1',
        ncCatConfig: { id: 'm1', name: 'Current Name' },
        settingsVersion: 'current',
        lastSettingsSyncAt: existingSyncAt
      });

      const snapshot = {
        schemaVersion: 1,
        version: 'v3',
        lastModified: '2025-12-01T00:00:00Z',
        machines: [{ id: 'm1', name: 'Stale Name', lastModified: '2025-12-01T00:00:00Z' }]
      };

      const result = await applyNcCatSettingsSnapshotToDb(db, snapshot as any, now);
      expect(result.ok).toBe(false);
      expect(result.appliedMachines).toBe(0);
      expect(result.rejectedMachines).toEqual(['m1']);

      const [row] = await db
        .select()
        .from(machines)
        .where(eq(machines.ncCatMachineId, 'm1'))
        .limit(1);
      expect(row.name).toBe('Current Name');
      expect(row.settingsVersion).toBe('current');
    } finally {
      await client.end();
    }
  });

  it('refuses snapshots with mismatched schemaVersion', async () => {
    const { client, db } = await createTestDb();
    const now = new Date('2025-12-12T12:00:00Z');
    try {
      const snapshot = {
        schemaVersion: 999,
        version: 'v3',
        lastModified: now.toISOString(),
        machines: [{ id: 'm1' }]
      };

      const result = await applyNcCatSettingsSnapshotToDb(db, snapshot as any, now);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/schemaVersion/);

      const machineRows = await db.select().from(machines);
      expect(machineRows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});

