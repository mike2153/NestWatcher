import { ok } from 'neverthrow';
import type { AppError } from '../../../shared/src';
import type { AllocatedMaterialListRes } from '../../../shared/src';
import { listAllocatedMaterial } from '../repo/allocatedMaterialRepo';
import { registerResultHandler } from './result';

export function registerAllocatedMaterialIpc() {
  registerResultHandler('allocatedMaterial:list', async () => {
    const items = await listAllocatedMaterial();
    return ok<AllocatedMaterialListRes, AppError>({ items });
  });
}
