import { eq, sql } from 'drizzle-orm';
import { machines, toolLibrary } from '../db/schema';
import { withDb } from './db';
import { logger } from '../logger';

type NcCatTool = {
  id?: string;
  name?: string;
  type?: string;
  diameter?: number;
  length?: number;
  materialType?: string;
  notes?: string;
  toolDiameter?: number;
  // Allow arbitrary extra fields
  [key: string]: unknown;
};

type NcCatMachineConfig = {
  id?: string;
  name?: string;
  // We intentionally allow arbitrary shape here – it will be stored as JSON
  toolLibrary?: NcCatTool[];
  [key: string]: unknown;
};

type NcCatSettingsSnapshot = {
  version?: string;
  machines?: NcCatMachineConfig[];
  toolLibrary?: NcCatTool[];
  [key: string]: unknown;
};

/**
 * Apply an NC-Cat settings snapshot to the local Postgres database.
 * - Upserts global tools into public.tool_library.
 * - Upserts machines into public.machines, attaching nc_cat_* metadata and config JSON.
 *
 * This function is side-effectful and should only be called from the main process.
 */
export async function applyNcCatSettingsSnapshot(rawSnapshot: unknown): Promise<void> {
  const snapshot = normalizeSnapshot(rawSnapshot);

  if (!snapshot.machines || snapshot.machines.length === 0) {
    logger.warn('NC-Cat settings snapshot has no machines; nothing to apply');
    return;
  }

  const now = new Date();

  await withDb(async (db) => {
    // 1) Upsert global tool library
    const globalTools = collectGlobalTools(snapshot);

    for (const tool of globalTools) {
      if (!tool.id || !tool.name || !tool.type) {
        continue;
      }

      const diameter =
        typeof tool.diameter === 'number'
          ? tool.diameter
          : typeof tool.toolDiameter === 'number'
          ? tool.toolDiameter
          : null;

      const length = typeof tool.length === 'number' ? tool.length : null;

      const [existing] = await db
        .select({ id: toolLibrary.id })
        .from(toolLibrary)
        .where(eq(toolLibrary.id, tool.id))
        .limit(1);

      if (existing) {
        await db
          .update(toolLibrary)
          .set({
            name: tool.name,
            type: tool.type,
            diameterMm: diameter,
            lengthMm: length,
            materialType: tool.materialType ?? null,
            notes: tool.notes ?? null,
            updatedAt: sql`now()`
          })
          .where(eq(toolLibrary.id, tool.id));
      } else {
        await db.insert(toolLibrary).values({
          id: tool.id,
          name: tool.name,
          type: tool.type,
          diameterMm: diameter,
          lengthMm: length,
          materialType: tool.materialType ?? null,
          notes: tool.notes ?? null
        });
      }
    }

    // 2) Upsert machines with attached NC-Cat config JSON
    for (const machineConfig of snapshot.machines) {
      if (!machineConfig || typeof machineConfig !== 'object') continue;

      const ncCatMachineId = typeof machineConfig.id === 'string' ? machineConfig.id : undefined;
      if (!ncCatMachineId) {
        logger.warn({ machineConfig }, 'Skipping NC-Cat machine without id');
        continue;
      }

      const machineName =
        typeof machineConfig.name === 'string' && machineConfig.name.trim().length > 0
          ? machineConfig.name
          : `NC-Cat Machine ${ncCatMachineId}`;

      const [existingMachine] = await db
        .select({ machineId: machines.machineId })
        .from(machines)
        .where(eq(machines.ncCatMachineId, ncCatMachineId))
        .limit(1);

      if (existingMachine) {
        await db
          .update(machines)
          .set({
            name: machineName,
            ncCatMachineId,
            ncCatConfig: machineConfig,
            settingsVersion: snapshot.version ?? null,
            lastSettingsSyncAt: now,
            updatedAt: sql`now()`
          })
          .where(eq(machines.machineId, existingMachine.machineId));
      } else {
        // Insert a new machine row with minimal required fields; folders/IP can be configured later in WE.
        await db.insert(machines).values({
          name: machineName,
          apJobfolder: '',
          nestpickFolder: '',
          nestpickEnabled: true,
          ncCatMachineId,
          ncCatConfig: machineConfig,
          settingsVersion: snapshot.version ?? null,
          lastSettingsSyncAt: now
        });
      }
    }
  });

  logger.info(
    {
      machines: snapshot.machines?.length ?? 0
    },
    'Applied NC-Cat settings snapshot to database'
  );
}

function normalizeSnapshot(raw: unknown): NcCatSettingsSnapshot {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid NC-Cat settings payload (expected object)');
  }

  const snapshot = raw as NcCatSettingsSnapshot;

  if (!Array.isArray(snapshot.machines)) {
    throw new Error('NC-Cat settings payload is missing "machines" array');
  }

  return snapshot;
}

function collectGlobalTools(snapshot: NcCatSettingsSnapshot): NcCatTool[] {
  const toolsById = new Map<string, NcCatTool>();

  // Root-level toolLibrary (if present)
  if (Array.isArray(snapshot.toolLibrary)) {
    for (const tool of snapshot.toolLibrary) {
      if (!tool || typeof tool !== 'object' || !tool.id) continue;
      toolsById.set(tool.id, tool);
    }
  }

  // Per-machine toolLibrary entries
  for (const machine of snapshot.machines ?? []) {
    if (!machine || typeof machine !== 'object' || !Array.isArray(machine.toolLibrary)) continue;
    for (const tool of machine.toolLibrary) {
      if (!tool || typeof tool !== 'object' || !tool.id) continue;
      if (!toolsById.has(tool.id)) {
        toolsById.set(tool.id, tool);
      }
    }
  }

  return Array.from(toolsById.values());
}

