import { dialog, BrowserWindow } from 'electron';
import { ok, err } from 'neverthrow';
import type { AppError, MachinesListRes } from '../../../shared/src';
import { SaveMachineReq } from '../../../shared/src';
import { listMachines, saveMachine, deleteMachine } from '../repo/machinesRepo';
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
    const saved = await saveMachine(req);
    return ok(saved);
  });

  registerResultHandler('machines:delete', async (_e, rawMachineId) => {
    const machineId = typeof rawMachineId === 'number' ? rawMachineId : Number(rawMachineId);
    if (!Number.isFinite(machineId)) {
      return err(createAppError('machines.invalidId', 'Machine id must be a number'));
    }
    await deleteMachine(machineId);
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
