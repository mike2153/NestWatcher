import { existsSync, promises as fsp } from 'fs';
import { basename, join, resolve, sep } from 'path';
import { loadConfig } from './config';
import { withClient } from './db';

function toRelDirFromKey(key: string): string {
  const idx = key.lastIndexOf('/');
  return idx >= 0 ? key.slice(0, idx) : '';
}

function originalBase(base: string): string {
  return base.replace(/^run\d+_/i, '');
}

export async function rerunJob(key: string): Promise<{ ok: true; created: string[] } | { ok: false; error: string }>{
  const cfg = loadConfig();
  const root = cfg.paths.processedJobsRoot?.trim?.() ?? '';
  if (!root) return { ok: false, error: 'processedJobsRoot not configured' };
  if (!existsSync(root)) return { ok: false, error: 'processedJobsRoot does not exist' };

  // Load current qty and base
  const row = await withClient((c) => c
    .query<{ key: string; folder: string | null; ncfile: string | null; qty: number | null }>(
      'SELECT key, folder, ncfile, qty FROM public.jobs WHERE key = $1', [key]
    )
    .then((r) => r.rows[0])
  );
  if (!row) return { ok: false, error: 'Job not found' };
  const base = (row.ncfile ?? '').trim();
  if (!base) return { ok: false, error: 'Job ncfile missing' };
  const origBase = originalBase(base);

  // Determine original row to retrieve qty
  const relDir = toRelDirFromKey(key);
  const origKey = (relDir ? `${relDir}/${origBase}` : origBase).slice(0, 100);
  const orig = await withClient((c) => c
    .query<{ key: string; qty: number | null }>('SELECT key, qty FROM public.jobs WHERE key = $1', [origKey])
    .then((r) => r.rows[0])
  );
  const nextQty = (orig?.qty ?? 0) + 1;
  const prefix = `run${nextQty}_`;

  // Source folder
  const srcDir = relDir ? resolve(root, relDir.split('/').join(sep)) : root;
  const created: string[] = [];

  const targets = [
    `${origBase}.nc`,
    `${origBase}.lpt`,
    `${origBase}.pts`,
    `${origBase}.bmp`,
    `${origBase}.jpg`,
    `${origBase}.csv`
  ];

  for (const name of targets) {
    const src = join(srcDir, name);
    if (!existsSync(src)) continue; // Optional
    const dest = join(srcDir, `${prefix}${name}`);
    try {
      await fsp.copyFile(src, dest);
      created.push(dest);
    } catch (err) {
      return { ok: false, error: `Copy failed for ${basename(src)}: ${(err as Error).message}` };
    }
  }

  if (created.length === 0) {
    return { ok: false, error: 'No source files found to copy' };
  }

  return { ok: true, created };
}
