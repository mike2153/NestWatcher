import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';

import { InventoryExportSettingsSchema } from '../../../shared/src';
import type { GrundnerRow, InventoryExportSettings } from '../../../shared/src';

import { logger } from '../logger';
import { listGrundnerAll } from '../repo/grundnerRepo';
import { loadConfig } from './config';
import { buildGrundnerCustomCsv } from './inventoryExportCsv';

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastSignature: string | null = null;

function clearTimer() {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
}

function safeUnref(timeout: NodeJS.Timeout | null) {
  if (!timeout) return;
  if (typeof timeout.unref === 'function') timeout.unref();
}

function hashInventory(rows: GrundnerRow[], settings: InventoryExportSettings): string {
  const h = createHash('sha256');

  // Include the template and destination, so a config change triggers a new export.
  h.update(JSON.stringify(settings.template), 'utf8');
  h.update('\n', 'utf8');
  h.update(JSON.stringify({
    folderPath: settings.scheduled.folderPath,
    fileName: settings.scheduled.fileName
  }), 'utf8');
  h.update('\n', 'utf8');

  for (const row of rows) {
    // Stable order: listGrundnerAll orders by type_data/customer_id, but we still hash field-by-field.
    h.update(String(row.id ?? ''), 'utf8'); h.update('\0', 'utf8');
    h.update(String(row.typeData ?? ''), 'utf8'); h.update('\0', 'utf8');
    h.update(String(row.customerId ?? ''), 'utf8'); h.update('\0', 'utf8');
    h.update(String(row.lengthMm ?? ''), 'utf8'); h.update('\0', 'utf8');
    h.update(String(row.widthMm ?? ''), 'utf8'); h.update('\0', 'utf8');
    h.update(String(row.thicknessMm ?? ''), 'utf8'); h.update('\0', 'utf8');
    h.update(String(row.stock ?? ''), 'utf8'); h.update('\0', 'utf8');
    h.update(String(row.stockAvailable ?? ''), 'utf8'); h.update('\0', 'utf8');
    h.update(String(row.reservedStock ?? ''), 'utf8'); h.update('\0', 'utf8');
    h.update(String(row.preReserved ?? ''), 'utf8'); h.update('\0', 'utf8');
    h.update(String(row.lastUpdated ?? ''), 'utf8'); h.update('\n', 'utf8');
  }

  return h.digest('hex');
}

async function writeAtomicFile(folderPath: string, fileName: string, contents: string): Promise<void> {
  await fs.mkdir(folderPath, { recursive: true });

  const targetPath = join(folderPath, fileName);
  const tmpPath = `${targetPath}.tmp`;

  // Write to a temp file first, then rename to the real name.
  // This reduces the chance another program reads a partially-written CSV.
  await fs.writeFile(tmpPath, contents, 'utf8');

  try {
    await fs.rename(tmpPath, targetPath);
  } catch (err) {
    // On Windows, rename fails if the destination exists.
    try {
      await fs.unlink(targetPath);
    } catch {
      // ignore
    }
    await fs.rename(tmpPath, targetPath);
  }
}

async function runScheduledExportOnce(inventoryExport: InventoryExportSettings) {
  if (running) return;
  running = true;
  try {
    const rows = await listGrundnerAll();
    const signature = hashInventory(rows, inventoryExport);

    if (inventoryExport.scheduled.onlyOnChange && lastSignature === signature) {
      return;
    }

    const csv = buildGrundnerCustomCsv(rows, inventoryExport.template);
    await writeAtomicFile(inventoryExport.scheduled.folderPath, inventoryExport.scheduled.fileName, csv);
    lastSignature = signature;

    logger.debug(
      {
        folderPath: inventoryExport.scheduled.folderPath,
        fileName: inventoryExport.scheduled.fileName,
        rowCount: rows.length,
        onlyOnChange: inventoryExport.scheduled.onlyOnChange
      },
      'Scheduled inventory export wrote CSV'
    );
  } catch (err) {
    logger.error({ err }, 'Scheduled inventory export failed');
  } finally {
    running = false;
  }
}

export function stopInventoryExportScheduler() {
  clearTimer();
  running = false;
  lastSignature = null;
}

export function syncInventoryExportScheduler() {
  clearTimer();
  lastSignature = null;

  const cfg = loadConfig();
  const parsed = InventoryExportSettingsSchema.safeParse(cfg.inventoryExport);

  if (!parsed.success) {
    // Settings are invalid; do not schedule exports.
    // This should only happen if settings.json was edited manually or came from an older version.
    logger.warn({ issues: parsed.error.issues }, 'Inventory export settings invalid; scheduler disabled');
    return;
  }

  const settings = parsed.data;
  if (!settings.scheduled.enabled) {
    return;
  }

  const intervalMs = Math.max(30, settings.scheduled.intervalSeconds) * 1000;

  // Run once immediately so enabling the scheduler produces a file right away.
  void runScheduledExportOnce(settings);

  const tick = async () => {
    await runScheduledExportOnce(settings);
    timer = setTimeout(tick, intervalMs);
    safeUnref(timer);
  };

  timer = setTimeout(tick, intervalMs);
  safeUnref(timer);
}
