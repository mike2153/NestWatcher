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

function parseCommissioningDelCsv(raw: string): string[][] {
  // Semicolon separated; simple split sufficient
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(';'));
}

export async function placeProductionDeleteCsv(
  items: DeleteItem[],
  timeoutMs = 10_000
): Promise<{ confirmed: boolean; folder: string; checked?: boolean; deleted?: boolean; message?: string }>{
  if (!items.length) return { confirmed: false, folder: '', checked: false, deleted: false, message: 'No items to delete' };
  const cfg = loadConfig();
  const folderRaw = cfg.paths.grundnerFolderPath?.trim() ?? '';
  if (!folderRaw) return { confirmed: false, folder: '', checked: false, deleted: false, message: 'Grundner folder not configured' };
  const folder = normalize(folderRaw);
  if (!existsSync(folder)) return { confirmed: false, folder, checked: false, deleted: false, message: 'Grundner folder does not exist' };

  // Per latest spec: write get_production.tmp then rename to get_production.csv
  const reqPath = join(folder, 'get_production.csv');
  const tmpPath = join(folder, 'get_production.tmp');
  // Grundner answer file for delete confirmation (preferred)
  const ansPathA = join(folder, 'productionLIST_del.csv');
  // Backward-compatible alternate names if needed
  const ansPathB = join(folder, 'commissioningLIST_DEL.csv');

  // Clear any stale answer
  try { await fsp.unlink(ansPathA); } catch { /* ignore */ }
  try { await fsp.unlink(ansPathB); } catch { /* ignore */ }

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

  // Wait for the production delete answer file
  const ok = await waitFor(async () => existsSync(ansPathA) || existsSync(ansPathB), timeoutMs);
  if (!ok) {
    logger.warn({ folder }, 'productionDelete: timed out waiting for productionLIST_del.csv');
    return { confirmed: false, folder, checked: false, deleted: false, message: 'Timed out waiting for delete confirmation (productionLIST_del.csv)' };
  }

  const ansPath = existsSync(ansPathA) ? ansPathA : ansPathB;
  await waitForStableFile(ansPath);
  const raw = await fsp.readFile(ansPath, 'utf8');
  const rows = parseCommissioningDelCsv(raw);
  // Build expected items and material counts
  const expectedItems = items
    .map((it) => ({
      job: toJobNo(it.ncfile).toLowerCase(),
      machine: (Number.isFinite(it.machineId as number) ? String(it.machineId) : '0').trim()
    }))
    .filter((it) => it.job.length > 0 && it.machine.length > 0);

  // Evaluate answer rows using new 9-column structure (0-based):
  // 0=line, 1=job-no, 2=type, 3=material, 4=qty, 5=rotation, 6=machine, 7=source, 8=res
  const matchedJobs = new Set<number>();
  for (const cols of rows) {
    const jobNo = (cols[1] ?? '').trim().toLowerCase();
    const machine = (cols[6] ?? '').trim();

    // Try to match individual jobs by job-no + machine
    for (let i = 0; i < expectedItems.length; i++) {
      if (matchedJobs.has(i)) continue;
      const ex = expectedItems[i];
      if (ex.job === jobNo && ex.machine === machine) {
        matchedJobs.add(i);
        // Do not break; allow duplicates but only count first match per expected item
      }
    }
  }

  // All requested jobs must be matched at least once
  const confirmed = matchedJobs.size === expectedItems.length;

  // Keep the commissioning answer file for inspection (do not delete here)
  // Caller can clean up later if desired.

  return { confirmed, folder, checked: true, deleted: true, message: confirmed ? undefined : 'Delete confirmation did not match request' };
}
