import { dialog } from 'electron';
import { promises as fs } from 'fs';
import { ok, err } from 'neverthrow';
import type { AppError, GrundnerExportRes, GrundnerCustomCsvPreviewRes } from '../../../shared/src';
import {
  GrundnerListReq,
  GrundnerUpdateReq,
  GrundnerJobsReq,
  GrundnerCustomCsvPreviewReq,
  InventoryExportSettingsSchema,
  InventoryExportTemplateSchema
} from '../../../shared/src';
import {
  listGrundner,
  listGrundnerAll,
  listGrundnerPreview,
  updateGrundnerRow,
  listGrundnerPendingJobs
} from '../repo/grundnerRepo';
import { loadConfig } from '../services/config';
import { buildGrundnerCustomCsv, buildGrundnerStandardCsv } from '../services/inventoryExportCsv';
import { createAppError } from './errors';
import { registerResultHandler } from './result';

export function registerGrundnerIpc() {
  registerResultHandler('grundner:list', async (_e, raw) => {
    const req = GrundnerListReq.parse(raw ?? {});
    const items = await listGrundner(req);
    return ok({ items });
  });

  registerResultHandler('grundner:update', async (_e, raw) => {
    const req = GrundnerUpdateReq.parse(raw);
    const res = await updateGrundnerRow(req);
    return ok(res);
  });

  registerResultHandler('grundner:jobs', async (_e, raw) => {
    const req = GrundnerJobsReq.parse(raw ?? {});
    const result = await listGrundnerPendingJobs(req.typeData, req.limit);
    return ok(result);
  });

  registerResultHandler('grundner:exportCsv', async () => {
    try {
      const rows = await listGrundnerAll();
      const csv = buildGrundnerStandardCsv(rows);

      const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Save Grundner Inventory CSV',
        defaultPath: 'grundner_inventory.csv',
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      });

      if (canceled || !filePath) {
        return ok<GrundnerExportRes, AppError>({ savedPath: null });
      }

      await fs.writeFile(filePath, csv, 'utf8');
      return ok<GrundnerExportRes, AppError>({ savedPath: filePath });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(createAppError('grundner.exportCsvFailed', message));
    }
  });

  registerResultHandler('grundner:exportCustomCsv', async () => {
    try {
      const cfg = loadConfig();
      const inventoryExportParsed = InventoryExportSettingsSchema.safeParse(cfg.inventoryExport);
      if (!inventoryExportParsed.success) {
        return err(
          createAppError(
            'grundner.exportCustomInvalidSettings',
            'Inventory export settings are invalid. Please fix them in Settings → Inventory Export.',
            inventoryExportParsed.error.issues
          )
        );
      }

      const rows = await listGrundnerAll();
      const csv = buildGrundnerCustomCsv(rows, inventoryExportParsed.data.template);

      const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Save Custom Grundner Inventory CSV',
        defaultPath: 'grundner_inventory_custom.csv',
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      });

      if (canceled || !filePath) {
        return ok<GrundnerExportRes, AppError>({ savedPath: null });
      }

      await fs.writeFile(filePath, csv, 'utf8');
      return ok<GrundnerExportRes, AppError>({ savedPath: filePath });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(createAppError('grundner.exportCustomCsvFailed', message));
    }
  });

  registerResultHandler('grundner:previewCustomCsv', async (_e, raw) => {
    try {
      const req = GrundnerCustomCsvPreviewReq.parse(raw ?? {});
      const templateParsed = InventoryExportTemplateSchema.safeParse(req.template);
      if (!templateParsed.success) {
        return err(
          createAppError(
            'grundner.previewCustomInvalidTemplate',
            templateParsed.error.issues[0]?.message ?? 'Invalid custom export template',
            templateParsed.error.issues
          )
        );
      }

      const rows = await listGrundnerPreview(req.limit);
      const csv = buildGrundnerCustomCsv(rows, templateParsed.data);

      return ok<GrundnerCustomCsvPreviewRes, AppError>({ csv });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(createAppError('grundner.previewCustomCsvFailed', message));
    }
  });
}
