import { existsSync, promises as fsp, readdirSync } from 'fs';
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

  // Load current job row (folder, ncfile)
  const row = await withClient((c) => c
    .query<{ key: string; folder: string | null; ncfile: string | null }>(
      'SELECT key, folder, ncfile FROM public.jobs WHERE key = $1', [key]
    )
    .then((r) => r.rows[0])
  );
  if (!row) return { ok: false, error: 'Job not found' };
  const base = (row.ncfile ?? '').trim();
  if (!base) return { ok: false, error: 'Job ncfile missing' };
  const origBase = originalBase(base);

  const relDir = toRelDirFromKey(key);
  // Determine next run number by scanning the source directory for existing runN_ copies
  const srcDir = relDir ? resolve(root, relDir.split('/').join(sep)) : root;
  let nextRun = 2; // Start at run2 for the second run
  try {
    const entries = readdirSync(srcDir, { withFileTypes: true });
    const pattern = new RegExp(`^run(\\d+)_${origBase.replace(/[.*+?^${}()|[\\]\\]/g, r => r)}(?:\\.[A-Za-z0-9]+)?$`, 'i');
    let maxRun = 1;
    for (const e of entries) {
      if (!e.isFile()) continue;
      const m = e.name.match(pattern);
      if (m) {
        const n = Number(m[1]);
        if (!Number.isNaN(n) && n > maxRun) maxRun = n;
      }
    }
    nextRun = Math.max(2, maxRun + 1);
  } catch {
    // ignore and use default nextRun
  }
  const prefix = `run${nextRun}_`;

  const created: string[] = [];

  const targets = [
    `${origBase}.nc`,
    `${origBase}.lpt`,
    `${origBase}.pts`,
    `${origBase}.bmp`,
    `${origBase}.jpg`,
    `${origBase}.jpeg`,
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
