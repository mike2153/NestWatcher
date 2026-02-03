import { dialog, BrowserWindow } from 'electron';
import { ok, err } from 'neverthrow';
import type { AppError, MachinesListRes } from '../../../shared/src';
import { SaveMachineReq } from '../../../shared/src';
import { deleteMachine, getMachine, listMachines, saveMachine } from '../repo/machinesRepo';
import { restartWatchers } from '../services/watchers';
import { logger } from '../logger';
import { createAppError } from './errors';
import { registerResultHandler } from './result';

export function registerMachinesIpc() {
  registerResultHandler('machines:list', async () => {
    const items = await listMachines();
    const res: MachinesListRes = { items };
    return ok<MachinesListRes, AppError>(res);
  });

  registerResultHandler('machines:save', async (_e, raw) => {
    const req = SaveMachineReq.parse(raw);
    const prev = req.machineId != null ? await getMachine(req.machineId) : null;
    const saved = await saveMachine(req);

    // Nestpick watchers are configured on worker startup.
    // If a machine's nestpick settings change, restart watchers so they watch the new paths.
    const shouldRestart =
      prev == null ||
      (prev.nestpickFolder ?? '') !== (saved.nestpickFolder ?? '') ||
      Boolean(prev.nestpickEnabled) !== Boolean(saved.nestpickEnabled);

    if (shouldRestart) {
      const res = await restartWatchers();
      if (!res.ok) {
        logger.warn({ error: res.error }, 'machines: saved but failed to restart watchers');
      }
    }

    return ok(saved);
  });

  registerResultHandler('machines:delete', async (_e, rawMachineId) => {
    const machineId = typeof rawMachineId === 'number' ? rawMachineId : Number(rawMachineId);
    if (!Number.isFinite(machineId)) {
      return err(createAppError('machines.invalidId', 'Machine id must be a number'));
    }
    await deleteMachine(machineId);

    // A deleted machine could have had nestpick watchers.
    // Restart watchers so the worker no longer watches stale files.
    const res = await restartWatchers();
    if (!res.ok) {
      logger.warn({ error: res.error }, 'machines: deleted but failed to restart watchers');
    }

    return ok<null, AppError>(null);
  });

  registerResultHandler('dialog:pickFolder', async (e) => {
    const parent = BrowserWindow.fromWebContents(e.sender);
    const props = { properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> };
    const res = parent ? await dialog.showOpenDialog(parent, props) : await dialog.showOpenDialog(props);
    if (res.canceled || res.filePaths.length === 0) {
      return ok<null, AppError>(null);
    }
    return ok<string, AppError>(res.filePaths[0]);
  });
}
