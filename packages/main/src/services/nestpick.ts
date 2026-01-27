import { promises as fsp } from 'fs';
import { existsSync } from 'fs';
import { join } from 'path';
import { loadConfig } from './config';
import { logger } from '../logger';

async function waitForFileFree(path: string, timeoutMs = 5 * 60 * 1000) {
  const start = Date.now();
  while (existsSync(path)) {
    if (Date.now() - start > timeoutMs) throw new Error('productionLIST_del.csv busy timeout');
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function appendProductionListDel(machineId: number, ncFiles: string[]): Promise<void> {
  if (!Array.isArray(ncFiles) || ncFiles.length === 0) return;
  const cfg = loadConfig();
  const folder = (cfg.paths.grundnerFolderPath ?? '').trim();
  if (!folder) return;
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
