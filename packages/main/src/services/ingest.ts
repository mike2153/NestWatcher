import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, extname, basename, relative, dirname } from 'path';
import { withClient } from './db';
import { loadConfig } from './config';
import { logger } from '../logger';
import { pushAppMessage } from './messages';

const INGEST_ALLOWED_EXTENSIONS = new Set(['.bmp', '.jpg', '.pts', '.lpt', '.npt', '.nsp', '.nc', '.csv']);

function walkDir(dir: string): { files: string[]; hadError: boolean } {
  const out: string[] = [];
  let hadError = false;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const lowerName = e.name.toLowerCase();
      if (e.isDirectory() && (lowerName === '$recycle.bin' || lowerName === 'system volume information')) {
        continue;
      }
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        const child = walkDir(p);
        if (child.hadError) hadError = true;
        out.push(...child.files);
      } else if (e.isFile()) {
        const extension = extname(e.name).toLowerCase();
        if (!INGEST_ALLOWED_EXTENSIONS.has(extension)) {
          continue;
        }
        out.push(p);
      }
    }
  } catch (err) {
    hadError = true;
    logger.warn({ err, dir }, 'Failed to read directory during walkDir');
  }
  return { files: out, hadError };
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
      // Accept X/Y/Z numbers like 2400, 2400., 2400.0, 2400.00
      const g = l.match(/G100\s+X(\d+(?:\.\d*)?)\s+Y(\d+(?:\.\d*)?)\s+Z(\d+(?:\.\d*)?)/i);
      if (g && !size) {
        const x = Number.parseFloat(g[1]);
        const y = Number.parseFloat(g[2]);
        const zNum = Number.parseFloat(g[3]);
        const xInt = Number.isNaN(x) ? null : Math.round(x);
        const yInt = Number.isNaN(y) ? null : Math.round(y);
        if (xInt != null && yInt != null) {
          size = `${xInt}x${yInt}`;
        }
        if (!Number.isNaN(zNum)) {
          const zInt = Math.round(zNum);
          thickness = String(zInt);
        }
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

export type IngestResult = {
  inserted: number;
  updated: number;
  pruned: number;
  addedJobs: { ncFile: string; folder: string }[];
  updatedJobs: { ncFile: string; folder: string }[];
  prunedJobs: { key: string; folder: string; ncFile: string; material: string | null; isLocked: boolean }[];
};

export async function ingestProcessedJobsRoot(): Promise<IngestResult> {
  const cfg = loadConfig();
  const root = cfg.paths.processedJobsRoot;
  if (!root) {
    logger.warn('No processedJobsRoot configured, skipping ingest');
    return { inserted: 0, updated: 0, pruned: 0, addedJobs: [], updatedJobs: [], prunedJobs: [] };
  }
  if (!existsSync(root)) {
    logger.error({ root }, 'processedJobsRoot path does not exist');
    pushAppMessage(
      'jobsFolder.unreadable',
      {
        path: root,
        error: 'Jobs folder path does not exist'
      },
      { source: 'jobs-ingest' }
    );
    return { inserted: 0, updated: 0, pruned: 0, addedJobs: [], updatedJobs: [], prunedJobs: [] };
  }
  // Safety guard: if root is temporarily unreachable, skip pruning this cycle
  try {
    // Touch root directory to confirm it is readable
    readdirSync(root, { withFileTypes: true });
  } catch (err) {
    logger.warn({ err, root }, 'Ingest: root not readable; skipping prune this cycle');
    pushAppMessage(
      'jobsFolder.unreadable',
      {
        path: root,
        error: err instanceof Error ? err.message : String(err)
      },
      { source: 'jobs-ingest' }
    );
    return { inserted: 0, updated: 0, pruned: 0, addedJobs: [], updatedJobs: [], prunedJobs: [] };
  }

  let inserted = 0, updated = 0;
  const addedJobs: { ncFile: string; folder: string }[] = [];
  const updatedJobs: { ncFile: string; folder: string }[] = [];
  const scan = walkDir(root);
  const files = scan.files.filter(p => extname(p).toLowerCase() === '.nc');
  const hadScanError = scan.hadError;
  const presentKeys = new Set<string>();
  for (const nc of files) {
    const dir = dirname(nc);
    const base = toBaseNoExt(nc);
    const baseNoExt = basename(base);
    const relFolder = relative(root, dir).split('\\').join('/');
    const folderLeaf = basename(dir);
    const key = `${relFolder}/${baseNoExt}`.replace(/^\//, '').slice(0, 100);
    // Track this key as present in filesystem
    presentKeys.add(key);
    const { material, size, thickness } = parseNc(nc);
    const parts = countParts(dir, baseNoExt);
    const sql = `INSERT INTO public.jobs(key, folder, ncfile, material, parts, size, thickness, dateadded, updated_at)
                   VALUES($1,$2,$3,$4,$5,$6,$7, now(), now())
                   ON CONFLICT (key) DO UPDATE SET
                     folder=EXCLUDED.folder,
                     ncfile=EXCLUDED.ncfile,
                     material=CASE WHEN EXCLUDED.material IS NOT NULL THEN EXCLUDED.material ELSE public.jobs.material END,
                     parts=CASE WHEN EXCLUDED.parts IS NOT NULL THEN EXCLUDED.parts ELSE public.jobs.parts END,
                     size=CASE WHEN EXCLUDED.size IS NOT NULL THEN EXCLUDED.size ELSE public.jobs.size END,
                     thickness=CASE WHEN EXCLUDED.thickness IS NOT NULL THEN EXCLUDED.thickness ELSE public.jobs.thickness END,
                     updated_at=now()
                   WHERE public.jobs.folder IS DISTINCT FROM EXCLUDED.folder
                      OR public.jobs.ncfile IS DISTINCT FROM EXCLUDED.ncfile
                      OR (EXCLUDED.material IS NOT NULL AND EXCLUDED.material IS DISTINCT FROM public.jobs.material)
                      OR (EXCLUDED.parts IS NOT NULL AND EXCLUDED.parts IS DISTINCT FROM public.jobs.parts)
                      OR (EXCLUDED.size IS NOT NULL AND EXCLUDED.size IS DISTINCT FROM public.jobs.size)
                      OR (EXCLUDED.thickness IS NOT NULL AND EXCLUDED.thickness IS DISTINCT FROM public.jobs.thickness)
                   RETURNING (xmax = 0) AS inserted, folder, ncfile`;
    try {
      const res = await withClient(c => c.query<{ inserted: boolean; folder: string | null; ncfile: string | null }>(sql, [
        key,
        folderLeaf,
        baseNoExt,
        material ?? null,
        parts ?? null,
        size ?? null,
        thickness ?? null
      ]));
      if (!res.rowCount) {
        continue;
      }
      const row = res.rows[0];
      const ncRaw = row.ncfile ?? baseNoExt;
      const ncFile = ncRaw.toLowerCase().endsWith('.nc') ? ncRaw : `${ncRaw}.nc`;
      const folderValue = row.folder ?? folderLeaf;
      if (row.inserted) {
        inserted++;
        addedJobs.push({ ncFile, folder: folderValue });
      } else {
        updated++;
        updatedJobs.push({ ncFile, folder: folderValue });
      }
    } catch (e) {
      logger.warn({ err: e }, 'ingest upsert failed');
      // Keep counters stable; treat failures as neither inserted nor updated
    }
  }

  // Prune jobs that no longer exist on disk and are still PENDING
  // Once a job has moved beyond PENDING (pushed to production), keep it as historical record
  let pruned = 0;
  const prunedJobs: { key: string; folder: string; ncFile: string; material: string | null; isLocked: boolean }[] = [];
  try {
    // Additional safety: if scanning had errors, do not prune this cycle to avoid accidental mass deletes
    if (hadScanError) {
      logger.warn({ root }, 'Ingest: scan had errors; skipping prune this cycle');
      pushAppMessage(
        'jobsFolder.unreadable',
        {
          path: root,
          error: 'Jobs folder scan encountered errors'
        },
        { source: 'jobs-ingest' }
      );
      return { inserted, updated, pruned: 0, addedJobs, updatedJobs, prunedJobs: [] };
    }
    const keys = Array.from(presentKeys);
    const pruneSql = `
      WITH present AS (
        SELECT unnest($1::text[]) AS key
      )
      DELETE FROM public.jobs j
      USING (
        SELECT j.key, j.ncfile, j.folder, j.material, j.is_locked
        FROM public.jobs j
        LEFT JOIN present p ON p.key = j.key
        WHERE p.key IS NULL AND j.status = 'PENDING'
      ) d
      WHERE j.key = d.key
      RETURNING d.key, d.ncfile, d.folder, d.material, d.is_locked`;

    const result = await withClient((c) =>
      c.query<{ key: string; ncfile: string | null; folder: string | null; material: string | null; is_locked: boolean | null }>(pruneSql, [keys])
    );
    pruned = result.rowCount ?? 0;

    if (pruned > 0) {
      for (const row of result.rows) {
        const key = row.key;
        const folder = row.folder ?? (key.includes('/') ? key.substring(0, key.lastIndexOf('/')) : '');
        const base = row.ncfile ?? (key.includes('/') ? key.substring(key.lastIndexOf('/') + 1) : key);
        const ncFile = base.toLowerCase().endsWith('.nc') ? base : `${base}.nc`;
        prunedJobs.push({
          key,
          folder,
          ncFile,
          material: row.material,
          isLocked: Boolean(row.is_locked)
        });
      }
      logger.info({ pruned }, 'ingest: pruned missing uncut jobs');
    }
  } catch (err) {
    logger.warn({ err }, 'ingest: failed to prune missing uncut jobs');
  }

  return { inserted, updated, pruned, addedJobs, updatedJobs, prunedJobs };
}
