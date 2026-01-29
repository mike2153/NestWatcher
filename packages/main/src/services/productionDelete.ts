import { existsSync, promises as fsp } from 'fs';
import { join, normalize } from 'path';
import { loadConfig } from './config';
import { logger } from '../logger';

type DeleteItem = { ncfile: string | null; machineId: number | null };

function toJobNo(base: string | null): string {
  const name = (base ?? '').trim();
  if (!name) return '';
  // Defensive: if we somehow get a path, keep only the filename.
  const normalized = name.replace(/\\/g, '/');
  const justName = normalized.includes('/') ? normalized.slice(normalized.lastIndexOf('/') + 1) : normalized;
  // Spec: job name without .nc
  return justName.replace(/\.nc$/i, '');
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number, intervalMs = 300): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function waitForStableFile(path: string, attempts = 4, intervalMs = 300): Promise<void> {
  let lastSize = -1;
  for (let i = 0; i < attempts; i++) {
    try {
      const stat = await fsp.stat(path);
      if (stat.size === lastSize) return;
      lastSize = stat.size;
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function normalizeGrundnerReply(content: string): string {
  // New Grundner gateway replies with get_production.erl containing the same
  // content that we sent. Normalize line endings + trim trailing whitespace
  // so minor CRLF differences don't break confirmation.
  return content.replace(/\r\n/g, '\n').trim();
}

export async function placeProductionDeleteCsv(
  items: DeleteItem[],
  timeoutMs = 10_000
): Promise<{ confirmed: boolean; folder: string; checked?: boolean; deleted?: boolean; message?: string }>{
  if (!items.length) return { confirmed: false, folder: '', checked: false, deleted: false, message: 'No items to delete' };
  const cfg = loadConfig();
  const effectiveTimeoutMs = cfg.test?.disableErlTimeouts ? Number.POSITIVE_INFINITY : timeoutMs;
  const folderRaw = cfg.paths.grundnerFolderPath?.trim() ?? '';
  if (!folderRaw) return { confirmed: false, folder: '', checked: false, deleted: false, message: 'Grundner folder not configured' };
  const folder = normalize(folderRaw);
  if (!existsSync(folder)) return { confirmed: false, folder, checked: false, deleted: false, message: 'Grundner folder does not exist' };

  // Per latest spec: write get_production.tmp then rename to get_production.csv
  const reqPath = join(folder, 'get_production.csv');
  const tmpPath = join(folder, 'get_production.tmp');
  // New gateway answer file
  const ansPath = join(folder, 'get_production.erl');

  // Clear any stale answer
  try { await fsp.unlink(ansPath); } catch { /* ignore */ }

  // Busy guard
  if (existsSync(reqPath) || existsSync(tmpPath)) {
    await new Promise((r) => setTimeout(r, 5000));
    if (existsSync(reqPath) || existsSync(tmpPath)) {
      return { confirmed: false, folder, checked: false, deleted: false, message: 'get_production.csv is busy; retry shortly' };
    }
  }

  // CSV structure (semicolon separated):
  // 1) Job name without .nc
  // 2) Machine number
  const lines =
    items
      .map((it) => {
        const jobNo = toJobNo(it.ncfile);
        const machine = Number.isFinite(it.machineId as number) ? String(it.machineId) : '0';
        return `${jobNo};${machine};`;
      })
      .join('\r\n') +
    '\r\n';
  await fsp.writeFile(tmpPath, lines, 'utf8');
  await fsp.rename(tmpPath, reqPath).catch(async () => { await fsp.writeFile(reqPath, lines, 'utf8'); });

  // Wait for the answer file
  const ok = await waitFor(async () => existsSync(ansPath), effectiveTimeoutMs);
  if (!ok) {
    logger.warn({ folder }, 'productionDelete: timed out waiting for get_production.erl');
    return { confirmed: false, folder, checked: false, deleted: false, message: 'Timed out waiting for delete confirmation (get_production.erl)' };
  }

  await waitForStableFile(ansPath);
  const raw = await fsp.readFile(ansPath, 'utf8');
  const confirmed = normalizeGrundnerReply(raw) === normalizeGrundnerReply(lines);

  // Remove answer file to avoid stale confirmations.
  try {
    await fsp.unlink(ansPath);
  } catch (err) {
    logger.warn({ folder, err }, 'productionDelete: failed to delete get_production.erl');
  }

  return { confirmed, folder, checked: true, deleted: true, message: confirmed ? undefined : 'Delete confirmation did not match request' };
}
