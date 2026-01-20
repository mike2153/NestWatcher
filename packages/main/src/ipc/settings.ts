import { ok, err } from 'neverthrow';
import type { AppError, PathValidationRes, Settings } from '../../../shared/src';
import { promises as fsp } from 'fs';
import { resolve } from 'path';
import { DbSettingsSchema, PathValidationReq, InventoryExportSettingsSchema } from '../../../shared/src';
import { getConfigPath, loadConfig, mergeSettings, overwriteConfig } from '../services/config';
import { testConnection, resetPool } from '../services/db';
import { triggerDbStatusCheck } from '../services/dbWatchdog';
import { syncInventoryExportScheduler } from '../services/inventoryExportScheduler';
import { createAppError } from './errors';
import { registerResultHandler } from './result';

export function registerSettingsIpc() {
  registerResultHandler('settings:get', async () => ok(loadConfig()), { requiresAdmin: true });

  // Expose the resolved on-disk path of the settings file for display in UI
  registerResultHandler('settings:path', async () => ok(getConfigPath()), { requiresAdmin: true });

  registerResultHandler('settings:save', async (_e, next) => {
    const update = (typeof next === 'object' && next !== null ? (next as Partial<Settings>) : {}) ?? {};
    const resolved = mergeSettings({ ...update });

    // Validate inventory export settings so we never write an invalid scheduled export config.
    const inventoryExportParsed = InventoryExportSettingsSchema.safeParse(resolved.inventoryExport);
    if (!inventoryExportParsed.success) {
      const message = inventoryExportParsed.error.issues[0]?.message ?? 'Invalid inventory export settings.';
      return err(createAppError('settings.invalidInventoryExport', message, inventoryExportParsed.error.issues));
    }

    const nextSettings: Settings = {
      ...resolved,
      inventoryExport: inventoryExportParsed.data
    };

    overwriteConfig(nextSettings);
    await resetPool();
    triggerDbStatusCheck();

    // Apply scheduled export changes immediately.
    syncInventoryExportScheduler();

    return ok(nextSettings);
  }, { requiresAdmin: true });

  registerResultHandler('settings:validatePath', async (_event, raw) => {
    const req = PathValidationReq.parse(raw);
    const input = req.path.trim();
    const resolved = resolve(input);
    try {
      const stats = await fsp.stat(resolved);
      const result: PathValidationRes = {
        path: resolved,
        exists: true,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        error: null
      };
      return ok(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const result: PathValidationRes = {
        path: resolved,
        exists: false,
        isDirectory: false,
        isFile: false,
        error: message
      };
      return ok(result);
    }
  }, { requiresAdmin: true });

  registerResultHandler('db:test', async (_e, dbSettings) => {
    const cfg = DbSettingsSchema.parse(dbSettings);
    const current = loadConfig();
    const effective = {
      ...cfg,
      password: cfg.password === '********' ? current.db.password : cfg.password
    };
    const res = await testConnection(effective);
    return ok(res);
  }, { requiresAdmin: true });
}



