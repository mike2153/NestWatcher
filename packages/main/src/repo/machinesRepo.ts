import { asc, eq, sql } from 'drizzle-orm';
import type { SaveMachineReq, Machine } from '../../../shared/src';
import { machines } from '../db/schema';
import { withDb } from '../services/db';

const MACHINE_FIELDS = {
  machineId: machines.machineId,
  name: machines.name,
  pcIp: machines.pcIp,
  cncIp: machines.cncIp,
  cncPort: machines.cncPort,
  apJobfolder: machines.apJobfolder,
  nestpickFolder: machines.nestpickFolder,
  nestpickEnabled: machines.nestpickEnabled,
  pcPort: machines.pcPort
};

type MachineRow = Pick<typeof machines.$inferSelect, keyof typeof MACHINE_FIELDS>;

function toMachine(row: MachineRow): Machine {
  return {
    machineId: row.machineId,
    name: row.name,
    pcIp: row.pcIp ?? null,
    cncIp: row.cncIp ?? null,
    cncPort: row.cncPort ?? null,
    apJobfolder: row.apJobfolder,
    nestpickFolder: row.nestpickFolder,
    nestpickEnabled: row.nestpickEnabled,
    pcPort: row.pcPort
  };
}

export async function listMachines(): Promise<Machine[]> {
  const rows = await withDb((db) =>
    db.select(MACHINE_FIELDS).from(machines).orderBy(asc(machines.machineId))
  );

  return rows.map(toMachine);
}

export async function saveMachine(input: SaveMachineReq) {
  if (input.machineId != null) {
    const machineId = input.machineId;
    const [row] = await withDb((db) =>
      db
        .update(machines)
        .set({
          name: input.name ?? 'New Machine',
          pcIp: input.pcIp ?? null,
          cncIp: input.cncIp ?? null,
          cncPort: input.cncPort ?? null,
          apJobfolder: input.apJobfolder ?? '',
          nestpickFolder: input.nestpickFolder ?? '',
          nestpickEnabled: input.nestpickEnabled ?? true,
          pcPort: input.pcPort ?? 5000,
          updatedAt: sql`now()`
        })
        .where(eq(machines.machineId, machineId))
        .returning(MACHINE_FIELDS)
    );

    if (!row) {
      throw new Error(`Machine ${input.machineId} not found`);
    }

    return toMachine(row);
  }

  const [inserted] = await withDb((db) =>
    db
      .insert(machines)
      .values({
        name: input.name ?? 'New Machine',
        pcIp: input.pcIp ?? null,
        cncIp: input.cncIp ?? null,
        cncPort: input.cncPort ?? null,
        apJobfolder: input.apJobfolder ?? '',
        nestpickFolder: input.nestpickFolder ?? '',
        nestpickEnabled: input.nestpickEnabled ?? true,
        pcPort: input.pcPort ?? 5000
      })
      .returning(MACHINE_FIELDS)
  );

  if (!inserted) {
    throw new Error('Failed to insert machine');
  }

  return toMachine(inserted);
}

export async function deleteMachine(machineId: number) {
  await withDb((db) => db.delete(machines).where(eq(machines.machineId, machineId)));
  return true;
}

export async function getMachine(machineId: number): Promise<Machine | null> {
  const rows = await withDb((db) =>
    db.select(MACHINE_FIELDS).from(machines).where(eq(machines.machineId, machineId)).limit(1)
  );
  const row = rows[0];
  return row ? toMachine(row) : null;
}
