import { promises as fsp } from 'fs';
import { existsSync } from 'fs';
import { join } from 'path';
import { loadConfig } from './config';
import { logger } from '../logger';

async function waitForFileFree(path: string, timeoutMs = 5 * 60 * 1000) {
  const start = Date.now();
  // Wait until file does not exist to avoid clobbering an in-use file
  while (existsSync(path)) {
    if (Date.now() - start > timeoutMs) throw new Error('productionLIST_del.csv busy timeout');
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Writes productionLIST_del.csv into the machine's Nestpick folder with one line per NC file.
 * Each line is formatted as: "<NCfile>;0;" (CRLF terminated).
 * If the target CSV exists, waits for it to become free (deleted) before writing a fresh file.
 */
export async function appendProductionListDel(machineId: number, ncFiles: string[]): Promise<void> {
  if (!Array.isArray(ncFiles) || ncFiles.length === 0) return;
  // Write to the Grundner folder per manual; not machine-specific
  const cfg = loadConfig();
  const folder = (cfg.paths.grundnerFolderPath ?? '').trim();
  if (!folder) return;
  // Per latest spec: write get_production.tmp then rename to get_production.csv
  const target = join(folder, 'get_production.csv');

  const lines = ncFiles
    .filter((v) => typeof v === 'string' && v.trim().length > 0)
    .map((name) => (name.toLowerCase().endsWith('.nc') ? name : `${name}.nc`))
    .map((name) => `${name};0;\r\n`)
    .join('');
  if (!lines) return;

  const tmp = join(folder, 'get_production.tmp');
  try {
    await waitForFileFree(target);
    await fsp.writeFile(tmp, lines, 'utf8');
    await fsp.rename(tmp, target).catch(async () => {
      await fsp.writeFile(target, lines, 'utf8');
      await fsp.unlink(tmp).catch(() => {});
    });
    logger.info({ machineId, file: target, count: ncFiles.length }, 'nestpick: wrote get_production.csv');
  } catch (err) {
    logger.warn({ err, machineId, file: target }, 'nestpick: failed to write get_production.csv');
    try { await fsp.unlink(tmp); } catch { /* ignore */ }
  }
}
