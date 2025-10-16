import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, extname, basename, relative, dirname } from 'path';
import { withClient } from './db';
import { loadConfig } from './config';
import { logger } from '../logger';

function walkDir(dir: string): { files: string[]; hadError: boolean } {
  const out: string[] = [];
  let hadError = false;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        const child = walkDir(p);
        if (child.hadError) hadError = true;
        out.push(...child.files);
      } else if (e.isFile()) {
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

export async function ingestProcessedJobsRoot(): Promise<{ inserted: number; updated: number; pruned: number }> {
  const cfg = loadConfig();
  const root = cfg.paths.processedJobsRoot;
  if (!root) {
    logger.warn('No processedJobsRoot configured, skipping ingest');
    return { inserted: 0, updated: 0, pruned: 0 };
  }
  if (!existsSync(root)) {
    logger.error({ root }, 'processedJobsRoot path does not exist');
    return { inserted: 0, updated: 0, pruned: 0 };
  }
  // Safety guard: if root is temporarily unreachable, skip pruning this cycle
  try {
    // Touch root directory to confirm it is readable
    readdirSync(root, { withFileTypes: true });
  } catch (err) {
    logger.warn({ err, root }, 'Ingest: root not readable; skipping prune this cycle');
    return { inserted: 0, updated: 0, pruned: 0 };
  }

  let inserted = 0, updated = 0;
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
  // Prune jobs that no longer exist on disk and have not been cut
  // Note: If there are no .nc files present, this will prune all uncut jobs.
  let pruned = 0;
  try {
    // Additional safety: if scanning had errors, do not prune this cycle to avoid accidental mass deletes
    if (hadScanError) {
      logger.warn({ root }, 'Ingest: scan had errors; skipping prune this cycle');
      return { inserted, updated, pruned: 0 };
    }
    const keys = Array.from(presentKeys);
    const pruneSql = `
      WITH present AS (
        SELECT unnest($1::text[]) AS key
      )
      DELETE FROM public.jobs j
      USING (
        SELECT j.key, j.material, j.pre_reserved
        FROM public.jobs j
        LEFT JOIN present p ON p.key = j.key
        WHERE p.key IS NULL AND j.cut_at IS NULL AND j.nestpick_completed_at IS NULL
      ) d
      WHERE j.key = d.key
      RETURNING d.material, d.pre_reserved`;

    const result = await withClient((c) => c.query<{ material: string | null; pre_reserved: boolean | null }>(pruneSql, [keys]));
    pruned = result.rowCount ?? 0;

    if (pruned > 0) {
      // For any materials that had pre-reserved rows deleted, resync the Grundner pre_reserved count
      const affectedMaterials = new Set<string>();
      for (const row of result.rows) {
        if ((row.pre_reserved ?? false) && row.material && row.material.trim()) {
          affectedMaterials.add(row.material.trim());
        }
      }
      if (affectedMaterials.size > 0) {
        try {
          // Lazy import to avoid cycles
          const { resyncGrundnerPreReservedForMaterial } = await import('../repo/jobsRepo');
          for (const material of affectedMaterials) {
            await resyncGrundnerPreReservedForMaterial(material);
          }
        } catch (err) {
          logger.warn({ err }, 'Failed to resync Grundner reserved counts after prune');
        }
      }
      logger.info({ pruned }, 'ingest: pruned missing uncut jobs');
    }
  } catch (err) {
    logger.warn({ err }, 'ingest: failed to prune missing uncut jobs');
  }

  return { inserted, updated, pruned };
}
