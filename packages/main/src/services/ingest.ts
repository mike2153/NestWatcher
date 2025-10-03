import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, extname, basename, relative, dirname } from 'path';
import { withClient } from './db';
import { loadConfig } from './config';
import { logger } from '../logger';

function walkDir(dir: string): string[] {
  const out: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...walkDir(p));
      else if (e.isFile()) out.push(p);
    }
  } catch (err) {
    logger.warn({ err, dir }, 'Failed to read directory during walkDir');
  }
  return out;
}

function toBaseNoExt(p: string) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i >= 0 ? b.substring(0, i) : b;
}

function parseNc(ncPath: string): { material?: string; size?: string; thickness?: string } {
  try {
    const txt = readFileSync(ncPath, 'utf8');
    const lines = txt.split(/\r?\n/);
    let material: string | undefined;
    let size: string | undefined;
    let thickness: string | undefined;
    for (const ln of lines) {
      const l = ln.trim();
      const m = l.match(/ID\s*=\s*([A-Za-z0-9_.-]+)/i);
      if (m && !material) material = m[1];
      const g = l.match(/G100\s+X([0-9]+(?:\.[0-9]+)?)\s+Y([0-9]+(?:\.[0-9]+)?)\s+Z([0-9]+(?:\.[0-9]+)?)/i);
      if (g && !size) {
        const x = Number.parseFloat(g[1]);
        const y = Number.parseFloat(g[2]);
        const z = g[3];
        const xInt = Number.isNaN(x) ? null : Math.round(x);
        const yInt = Number.isNaN(y) ? null : Math.round(y);
        if (xInt != null && yInt != null) {
          size = `${xInt}x${yInt}`;
        }
        thickness = z;
      }
    }
    return { material, size, thickness };
  } catch {
    return {};
  }
}

function countParts(dir: string, base: string): string | undefined {
  const entries = readdirSync(dir, { withFileTypes: true });
  let target: string | null = null;
  for (const e of entries) {
    if (!e.isFile()) continue;
    const nm = e.name.toLowerCase();
    if (nm === `${base.toLowerCase()}.pts` || nm === `${base.toLowerCase()}.lpt`) {
      target = join(dir, e.name);
      break;
    }
  }
  if (!target) return undefined;
  try {
    const txt = readFileSync(target, 'utf8');
    const lines = txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    return String(lines.length);
  } catch {
    return undefined;
  }
}

export async function ingestProcessedJobsRoot(): Promise<{ inserted: number; updated: number }> {
  const cfg = loadConfig();
  const root = cfg.paths.processedJobsRoot;
  if (!root) {
    logger.warn('No processedJobsRoot configured, skipping ingest');
    return { inserted: 0, updated: 0 };
  }
  if (!existsSync(root)) {
    logger.error({ root }, 'processedJobsRoot path does not exist');
    return { inserted: 0, updated: 0 };
  }
  logger.info({ root }, 'Starting job ingest');
  let inserted = 0, updated = 0;
  const files = walkDir(root).filter(p => extname(p).toLowerCase() === '.nc');
  logger.info({ count: files.length, root }, 'Found NC files');
  for (const nc of files) {
    const dir = dirname(nc);
    const base = toBaseNoExt(nc);
    const baseNoExt = basename(base);
    const relFolder = relative(root, dir).split('\\').join('/');
    const folderLeaf = basename(dir);
    const key = `${relFolder}/${baseNoExt}`.replace(/^\//, '').slice(0, 100);
    const { material, size, thickness } = parseNc(nc);
    const parts = countParts(dir, baseNoExt);
    const sql = `INSERT INTO public.jobs(key, folder, ncfile, material, parts, size, thickness, dateadded, updated_at)
                   VALUES($1,$2,$3,$4,$5,$6,$7, now(), now())
                   ON CONFLICT (key) DO UPDATE SET
                     folder=EXCLUDED.folder,
                     ncfile=EXCLUDED.ncfile,
                     material=COALESCE(EXCLUDED.material, jobs.material),
                     parts=COALESCE(EXCLUDED.parts, jobs.parts),
                     size=COALESCE(EXCLUDED.size, jobs.size),
                     thickness=COALESCE(EXCLUDED.thickness, jobs.thickness),
                     updated_at=now()
                   RETURNING (xmax = 0) AS inserted`;
    try {
      const res = await withClient(c => c.query<{ inserted: boolean }>(sql, [
        key,
        folderLeaf,
        baseNoExt,
        material ?? null,
        parts ?? null,
        size ?? null,
        thickness ?? null
      ]));
      const wasInserted = (res.rows?.[0]?.inserted ?? false) as boolean;
      if (wasInserted) inserted++; else updated++;
    } catch (e) {
      logger.warn({ err: e }, 'ingest upsert failed');
      // Keep counters stable; treat failures as neither inserted nor updated
    }
  }
  logger.info({ inserted, updated, total: files.length }, 'Job ingest completed');
  return { inserted, updated };
}
