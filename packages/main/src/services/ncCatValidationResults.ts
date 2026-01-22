import { BrowserWindow } from 'electron';
import type { NcCatValidationReport } from '../../../shared/src';
import { loadConfig } from './config';
import { logger } from '../logger';
import { insertValidationReport } from '../repo/validationReportsRepo';

const VALIDATION_RESULTS_CHANNEL = 'nc-catalyst:validation-results';

export async function persistNcCatValidationReport(report: NcCatValidationReport): Promise<void> {
  try {
    await insertValidationReport(report);
  } catch (err) {
    logger.warn({ err }, 'ncCat: failed to persist validation report');
  }
}

export function broadcastNcCatValidationReport(report: NcCatValidationReport): void {
  const cfg = loadConfig();
  if (!cfg.validationWarnings?.showValidationWarnings) {
    return;
  }

  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) {
        win.webContents.send(VALIDATION_RESULTS_CHANNEL, report);
      }
    } catch (err) {
      logger.warn({ err }, 'ncCat: failed to broadcast validation report');
    }
  }
}
