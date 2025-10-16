import type { Dirent } from 'fs';
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync, readFileSync } from 'fs';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'path';
import type { WorklistAddResult, WorklistCollisionInfo, WorklistSkippedFile } from '../../../shared/src';
import { dialog } from 'electron';
import { appendJobEvent } from '../repo/jobEventsRepo';
import { listMachines } from '../repo/machinesRepo';
import { resetJobForRestage, updateLifecycle, lockJobAfterGrundnerConfirmation } from '../repo/jobsRepo';
import { logger } from '../logger';
import { loadConfig } from './config';
import { withClient } from './db';
import { placeOrderSawCsv } from './orderSaw';

const OVERWRITE_PATTERNS: RegExp[] = [
  /^planit.*\.csv$/i,
  /\.csv$/i,
  /\.nc$/i,
  /\.lpt$/i,
  /\.pts$/i,
  /\.(bmp|jpg|jpeg|png|gif)$/i
];

function walk(dir: string): string[] {
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    logger.warn({ err, dir }, 'worklist: failed to read directory');
    return [];
  }

  const out: string[] = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function isDir(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function resolveSourceRoot(rawFolder: string | null, processedRoot: string, jobKey: string): string | null {
  const trimmed = rawFolder?.trim() ?? '';
  if (trimmed) {
    const normalized = normalize(trimmed);

    if (isAbsolute(normalized) && isDir(normalized)) {
      return normalized;
    }

    if (isDir(normalized)) {
      return normalize(normalized);
    }

    if (processedRoot) {
      const candidate = resolve(processedRoot, normalized);
      const rel = relative(resolve(processedRoot), candidate);
      if (!rel.startsWith('..') && !rel.includes(`..${sep}`) && isDir(candidate)) {
        return candidate;
      }
    }
  }

  if (!processedRoot) return null;

  const slashIndex = jobKey.lastIndexOf('/');
  const keyFolder = slashIndex >= 0 ? jobKey.slice(0, slashIndex) : '';
  const candidateFromKey = keyFolder
    ? resolve(processedRoot, keyFolder.split('/').join(sep))
    : processedRoot;

  const relFromKey = relative(resolve(processedRoot), candidateFromKey);
  if (relFromKey.startsWith('..') || relFromKey.includes(`..${sep}`)) {
    return null;
  }
  return isDir(candidateFromKey) ? candidateFromKey : null;
}

function formatTimestampForDir(date: Date) {
  const pad = (value: number) => value.toString().padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function toPosixRelative(path: string) {
  return path.split('\\').join('/');
}

function canOverwrite(name: string) {
  return OVERWRITE_PATTERNS.some((pattern) => pattern.test(name));
}

function chooseDestination(baseDir: string): { path: string; collision?: WorklistCollisionInfo } {
  // If the base directory already exists in the machine's Ready-To-Run folder,
  // reuse it instead of creating a timestamped directory.
  if (existsSync(baseDir)) {
    logger.info({ baseDir }, 'worklist: destination exists; reusing existing folder');
    return { path: baseDir };
  }

  // Otherwise, use the base directory path as-is (no timestamp suffix).
  return { path: baseDir };
}

export async function addJobToWorklist(key: string, machineId: number): Promise<WorklistAddResult> {
  const job = await withClient(async (c) => {
    const r = await c.query(
      `SELECT key, folder, ncfile, material FROM public.jobs WHERE key = $1`,
      [key]
    );
    return r.rows[0] as { key: string; folder: string | null; ncfile: string | null; material: string | null } | undefined;
  });
  if (!job) return { ok: false, error: 'Job not found' };

  const machines = await listMachines();
  const m = machines.find((x) => x.machineId === machineId);
  if (!m) return { ok: false, error: 'Machine not found' };
  const destDir = m.apJobfolder;
  if (!destDir) return { ok: false, error: 'Machine ap_jobfolder is empty' };

  if (!job.ncfile) return { ok: false, error: 'Job ncfile missing' };

  const resetResult = await resetJobForRestage(job.key);
  if (resetResult.reset) {
    logger.info(
      {
        jobKey: job.key,
        iteration: resetResult.iteration,
        previousStatus: resetResult.previousStatus,
        machineId
      },
      'worklist: lifecycle reset for restaging'
    );
  }

  const cfg = loadConfig();
  const sourceRoot = resolveSourceRoot(job.folder, cfg.paths.processedJobsRoot || '', job.key);
  if (!sourceRoot) {
    logger.warn({ folder: job.folder, jobKey: job.key, processedRoot: cfg.paths.processedJobsRoot }, 'worklist: source folder unresolved');
    return { ok: false, error: 'Source folder not found' };
  }

  const leaf = basename(sourceRoot) || 'job';
  const destBaseDir = join(destDir, leaf);
  const { path: finalDestBaseDir, collision } = chooseDestination(destBaseDir);
  if (!existsSync(finalDestBaseDir)) mkdirSync(finalDestBaseDir, { recursive: true });

  const files = walk(sourceRoot);
  if (!files.length) {
    return { ok: false, error: 'No files found in source folder' };
  }

  const filesByName = new Map<string, string[]>();
  const filesByRelLower = new Map<string, string>();
  const csvFiles: string[] = [];
  for (const filePath of files) {
    const nameLower = basename(filePath).toLowerCase();
    const list = filesByName.get(nameLower) ?? [];
    list.push(filePath);
    filesByName.set(nameLower, list);
    if (nameLower.endsWith('.csv')) {
      csvFiles.push(filePath);
    }
    const rel = relative(sourceRoot, filePath).replace(/^[\\/]+/, '');
    filesByRelLower.set(rel.toLowerCase(), filePath);
  }

  const ncFileName = job.ncfile.trim();
  const ncFileNameLower = ncFileName.toLowerCase();

  const pickFileByName = (nameLower: string, preferredDirLower?: string): string | null => {
    const candidates = filesByName.get(nameLower);
    if (!candidates?.length) return null;
    if (!preferredDirLower) return candidates[0];
    const normalizedPreferred = normalize(preferredDirLower).toLowerCase();
    const sorted = [...candidates].sort((a, b) => {
      const weight = (p: string) => {
        const dirLower = normalize(dirname(p)).toLowerCase();
        return dirLower === normalizedPreferred ? 0 : 1;
      };
      const diff = weight(a) - weight(b);
      if (diff !== 0) return diff;
      return a.localeCompare(b);
    });
    return sorted[0] ?? null;
  };

  const resolveTokenToFile = (token: string, preferredDirLower?: string): string | null => {
    if (!token) return null;
    const normalizedToken = token.replace(/^["']|["']$/g, '').trim();
    if (!normalizedToken) return null;
    let tokenLower = normalizedToken.toLowerCase();

    const direct = filesByRelLower.get(tokenLower);
    if (direct) return direct;

    tokenLower = tokenLower.replace(/^\.\/?/, '').replace(/^\\/, '');
    const trimmed = filesByRelLower.get(tokenLower);
    if (trimmed) return trimmed;

    const base = basename(normalizedToken);
    if (base) {
      const baseLower = base.toLowerCase();
      const resolved = pickFileByName(baseLower, preferredDirLower);
      if (resolved) return resolved;
    }

    return null;
  };

  let ncPath = pickFileByName(ncFileNameLower);
  // Fallback: if DB value omitted extension, try appending .nc (case-insensitive)
  if (!ncPath) {
    const hasExt = !!extname(ncFileNameLower);
    if (!hasExt) {
      const withNc = `${ncFileNameLower}.nc`;
      ncPath = pickFileByName(withNc);
    }
  }
  if (!ncPath) {
    logger.warn({ ncfile: job.ncfile, sourceRoot }, 'worklist: nc file not found');
    return { ok: false, error: `NC file ${job.ncfile} not found` };
  }

  const preferredDirLower = normalize(dirname(ncPath)).toLowerCase();

  const filesToCopy = new Map<string, string>();
  // Tracks relative paths in destination that should not be overwritten
  // if they already exist (e.g., Planit 3-char family CSV like RJT.csv)
  const skipOverwriteRel = new Set<string>();
  const addCopyTarget = (filePath: string) => {
    const relPath = relative(sourceRoot, filePath);
    if (relPath.startsWith('..')) {
      logger.debug({ filePath, sourceRoot }, 'worklist: candidate outside source root, skipping');
      return;
    }
    const normalizedRel = relPath.replace(/^[\\/]+/, '');
    filesToCopy.set(filePath, normalizedRel);
  };
  // Add a copy target but force a specific destination-relative path (do not
  // preserve the source folder structure). Useful for placing images next to
  // the NC/CSV files regardless of their source location.
  const addCopyTargetAs = (filePath: string, destRelPath: string) => {
    const normalizedRel = destRelPath.replace(/^[\\/]+/, '');
    filesToCopy.set(filePath, normalizedRel);
  };

  addCopyTarget(ncPath);
  const ncRelDir = relative(sourceRoot, dirname(ncPath)).replace(/^[\\/]+/, '');

  const removeExtension = (value: string) => {
    const ext = extname(value);
    return ext ? value.slice(0, -ext.length) : value;
  };

  const ncBaseName = removeExtension(ncFileName);
  const ncBaseLower = ncBaseName.toLowerCase();

  const associatedExtensions = ['.lpt', '.pts', '.bmp', '.jpg', '.jpeg'];
  let lptPath: string | null = null;
  let hasPtsForAlphaCam = false;
  for (const ext of associatedExtensions) {
    const candidate = pickFileByName(`${ncBaseLower}${ext}`, preferredDirLower);
    if (candidate) {
      // For images, place them next to the NC file in the destination
      if (ext === '.bmp' || ext === '.jpg' || ext === '.jpeg') {
        const destRel = ncRelDir ? join(ncRelDir, basename(candidate)) : basename(candidate);
        addCopyTargetAs(candidate, destRel);
      } else {
        addCopyTarget(candidate);
      }
      if (ext === '.lpt') lptPath = candidate;
      if (ext === '.pts') hasPtsForAlphaCam = true;
    } else {
      logger.debug({ key: job.key, file: `${ncBaseName}${ext}` }, 'worklist: associated file not found');
    }
  }

  const exactCsv = pickFileByName(`${ncBaseLower}.csv`, preferredDirLower);
  if (exactCsv) {
    addCopyTarget(exactCsv);
  }

  // Decide scanning mode
  const mode: 'alphacam' | 'planit' | 'generic' = hasPtsForAlphaCam ? 'alphacam' : (lptPath ? 'planit' : 'generic');

  const prefix = ncBaseLower.slice(0, 3);
  let planitCsvPath: string | null = null;
  let planitCsvHasImageTokens = false;
  let planitPrefixCsvPath: string | null = null;
  if (mode === 'planit' && prefix.length === 3) {
    // Copy the exact per-file CSV (already handled via exactCsv above)
    // Additionally, copy the family CSV: first three chars only (e.g., RJT.csv)
    const familyCsvName = `${prefix}.csv`;
    planitPrefixCsvPath = pickFileByName(familyCsvName, preferredDirLower);
    if (planitPrefixCsvPath) {
      const relPath = relative(sourceRoot, planitPrefixCsvPath).replace(/^[\\/]+/, '');
      skipOverwriteRel.add(relPath.toLowerCase());
      addCopyTarget(planitPrefixCsvPath);
      planitCsvPath = planitPrefixCsvPath;
    } else {
      // If the family CSV isn't present in the source, but an older one already
      // exists in the destination (from a prior staging), reuse it for image mapping.
      const existingDestFamilyCsv = join(finalDestBaseDir, familyCsvName);
      if (existsSync(existingDestFamilyCsv)) {
        planitCsvPath = existingDestFamilyCsv;
        logger.info({ key: job.key, csv: existingDestFamilyCsv }, 'worklist: using existing destination family CSV for image mapping');
      } else {
        logger.debug({ key: job.key, prefix }, 'worklist: family CSV (prefix.csv) not found');
      }
    }
    // Image mapping must use the family CSV (prefix.csv), not the per-file CSV
  }

  // Planit-only image mapping via LPT/CSV
  if (mode === 'planit' && lptPath) {
    let lptContent = '';
    try {
      lptContent = readFileSync(lptPath, 'utf8');
    } catch (err) {
      logger.warn({ err, lptPath }, 'worklist: failed to read LPT file');
    }

    if (lptContent) {
      const labelNumbers = new Set<number>();
      for (const line of lptContent.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const cols = trimmed.split(',');
        if (cols.length < 3) continue;
        const value = parseInt(cols[2].trim(), 10);
        if (!Number.isNaN(value)) labelNumbers.add(value);
      }

      if (labelNumbers.size > 0) {
        const imageTokensByLabel = new Map<number, string[]>();
        if (planitCsvPath) {
          try {
            const mapContent = readFileSync(planitCsvPath, 'utf8');
            for (const row of mapContent.split(/\r?\n/)) {
              if (!row.trim()) continue;
              const cols = row.split(',');
              if (!cols.length) continue;
              const label = parseInt(cols[0].trim(), 10);
              if (Number.isNaN(label)) continue;
              const tokens: string[] = [];
              for (const raw of cols) {
                const token = raw.trim();
                if (!token) continue;
                const lower = token.toLowerCase();
                if (lower.endsWith('.bmp') || lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
                  tokens.push(token);
                }
              }
              if (tokens.length) {
                planitCsvHasImageTokens = true;
                const existing = imageTokensByLabel.get(label) ?? [];
                imageTokensByLabel.set(label, existing.concat(tokens));
              }
            }
          } catch (err) {
            logger.warn({ err, planitCsvPath }, 'worklist: failed to read Planit CSV');
          }
        }

        const seenImages = new Set<string>();
        const tryAddImage = (token: string) => {
          const resolved = resolveTokenToFile(token, preferredDirLower);
          if (resolved) {
            const keyLower = resolved.toLowerCase();
            if (!seenImages.has(keyLower)) {
              const destRel = ncRelDir ? join(ncRelDir, basename(resolved)) : basename(resolved);
              addCopyTargetAs(resolved, destRel);
              seenImages.add(keyLower);
            }
            return true;
          }
          const base = basename(token);
          if (base) {
            const bmp = resolveTokenToFile(`${base}.bmp`, preferredDirLower);
            if (bmp && !seenImages.has(bmp.toLowerCase())) {
              const destRel = ncRelDir ? join(ncRelDir, basename(bmp)) : basename(bmp);
              addCopyTargetAs(bmp, destRel);
              seenImages.add(bmp.toLowerCase());
              return true;
            }
            const jpg = resolveTokenToFile(`${base}.jpg`, preferredDirLower);
            if (jpg && !seenImages.has(jpg.toLowerCase())) {
              const destRel = ncRelDir ? join(ncRelDir, basename(jpg)) : basename(jpg);
              addCopyTargetAs(jpg, destRel);
              seenImages.add(jpg.toLowerCase());
              return true;
            }
          }
          return false;
        };

        for (const label of labelNumbers) {
          const tokens = imageTokensByLabel.get(label) ?? [];
          let copiedImage = false;
          for (const token of tokens) {
            if (tryAddImage(token)) {
              copiedImage = true;
              break;
            }
          }
          if (!copiedImage && tokens.length) {
            logger.debug({ key: job.key, label }, 'worklist: unable to resolve image token for label');
          }
          if (!tokens.length) {
            logger.debug({ key: job.key, label }, 'worklist: no image mapping for label in Planit CSV');
          }
        }
      }
    }
  }

  // Planit fallback: Some Planit exports include a family CSV without usable image tokens.
  // In that case, look for a `<ncBase>.txt` file that lists image paths in a pipe-delimited format.
  // The 3rd column (index 2) contains the image path; we ignore the path and use the basename.
  // Skip the first row. Example row:
  //   X01337|Y00294|C:\\...\\r59p0089.bmp||
  if (mode === 'planit' && planitCsvPath && !planitCsvHasImageTokens) {
    const txtCandidate = pickFileByName(`${ncBaseLower}.txt`, preferredDirLower);
    if (txtCandidate) {
      try {
        // Also stage the TXT file itself next to the NC
        const txtDestRel = ncRelDir ? join(ncRelDir, basename(txtCandidate)) : basename(txtCandidate);
        addCopyTargetAs(txtCandidate, txtDestRel);

        const content = readFileSync(txtCandidate, 'utf8');
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (i === 0) continue; // disregard row 0
          const line = lines[i];
          if (!line || !line.includes('|')) continue;
          const cols = line.split('|');
          if (cols.length < 3) continue;
          const rawPath = cols[2]?.trim();
          if (!rawPath) continue;
          const nameOnly = basename(rawPath).trim();
          if (!nameOnly) continue;
          const lower = nameOnly.toLowerCase();
          if (!(lower.endsWith('.bmp') || lower.endsWith('.jpg') || lower.endsWith('.jpeg'))) continue;
          // Resolve against known files (prefer NC directory)
          const resolved = resolveTokenToFile(nameOnly, preferredDirLower) ?? pickFileByName(lower, preferredDirLower);
          if (resolved) {
            const destRel = ncRelDir ? join(ncRelDir, basename(resolved)) : basename(resolved);
            addCopyTargetAs(resolved, destRel);
          }
        }
      } catch (err) {
        logger.warn({ err, txtCandidate }, 'worklist: failed to read Planit TXT fallback');
      }
    }
  }

  // Copy images matching the NC base prefix from job root and subfolders.
  //
  // - For Alphacam (when a .pts exists), we have historically copied all
  //   images that match `${ncBase}*.bmp|jpg|jpeg`.
  // - For Planit/Generic, we also copy all such images to ensure label files
  //   are staged even when no LPT/CSV image mapping is available.
  //
  // This aligns with simulator/docs which state that images matching
  // `<base>*.bmp|jpg|jpeg` are copied during staging regardless of CAM source.
  if (mode === 'alphacam' || mode === 'generic' || mode === 'planit') {
    for (const filePath of files) {
      const nameLower = basename(filePath).toLowerCase();
      if (nameLower.endsWith('.bmp') || nameLower.endsWith('.jpg') || nameLower.endsWith('.jpeg')) {
        const baseNoExt = removeExtension(nameLower);
        if (baseNoExt.startsWith(ncBaseLower)) {
          const destRel = ncRelDir ? join(ncRelDir, basename(filePath)) : basename(filePath);
          addCopyTargetAs(filePath, destRel);
        }
      }
    }
  }

  const skipped: WorklistSkippedFile[] = [];
  let copied = 0;

  for (const [src, rel] of filesToCopy.entries()) {
    const relPosix = toPosixRelative(rel);
    const dest = join(finalDestBaseDir, rel);
    const destParent = dirname(dest);
    if (!existsSync(destParent)) mkdirSync(destParent, { recursive: true });

    const fileName = basename(src);
    if (existsSync(dest)) {
      const relKeyLower = rel.replace(/^[\\/]+/, '').toLowerCase();
      if (skipOverwriteRel.has(relKeyLower)) {
        skipped.push({ relativePath: relPosix, reason: 'exists', message: 'Destination file already exists' });
        logger.debug({ src, dest }, 'worklist: skipped existing Planit family CSV');
        continue;
      }
      if (!canOverwrite(fileName)) {
        skipped.push({ relativePath: relPosix, reason: 'exists', message: 'Destination file already exists' });
        logger.debug({ src, dest }, 'worklist: skipped existing file');
        continue;
      }
    }

    try {
      copyFileSync(src, dest);
      copied++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      skipped.push({ relativePath: relPosix, reason: 'error', message });
      logger.warn({ err, src, dest }, 'worklist: copy failed');
    }
  }

  if (copied === 0) {
    return { ok: false, error: 'No files copied (all skipped or failed)', skipped };
  }

  let stagedAt: string | null = null;
  let alreadyStaged = false;

  try {
    const lifecycle = await updateLifecycle(job.key, 'STAGED', {
      machineId,
      source: 'worklist',
      payload: { dest: finalDestBaseDir, copied, skipped }
    });

    if (lifecycle.ok) {
      stagedAt = lifecycle.stagedAt ?? null;
      alreadyStaged = lifecycle.previousStatus === 'STAGED';
    } else if (lifecycle.reason === 'NO_CHANGE') {
      stagedAt = lifecycle.stagedAt ?? null;
      alreadyStaged = true;
    } else {
      logger.warn({ key: job.key, lifecycle }, 'worklist: lifecycle update failed');
      return { ok: false, error: `Lifecycle update failed: ${lifecycle.reason}`, skipped };
    }
  } catch (err) {
    logger.warn({ err, key: job.key }, 'worklist: lifecycle update threw');
    return { ok: false, error: 'Lifecycle update threw an exception', skipped };
  }

  try {
    await appendJobEvent(job.key, 'worklist:staged', { dest: finalDestBaseDir, copied, skipped }, machineId);
  } catch (err) {
    logger.warn({ err, key: job.key }, 'worklist: failed to append job event');
  }

  // After staging, place Grundner order_saw CSV, wait for .erl reply, record the check,
  // and then lock on confirmation. This should not fail the staging result; show a dialog to the user with outcome.
  try {
    const res = await placeOrderSawCsv([{ key: job.key, ncfile: job.ncfile, material: job.material ?? null }]);

    // Record that we processed and checked the .erl (and that it was deleted)
    try {
      await appendJobEvent(
        job.key,
        'grundner:erlChecked',
        {
          confirmed: res.confirmed,
          folder: res.folder,
          checked: !!res.checked,
          deleted: !!res.deleted,
          csv: res.csv ?? null,
          erl: res.erl ?? null
        },
        machineId
      );
    } catch (err) {
      logger.warn({ err, key: job.key }, 'worklist: failed to append erlChecked event');
    }

    if (res.confirmed) {
      // Lock only after confirmed .erl from Grundner
      await lockJobAfterGrundnerConfirmation(job.key);
      void dialog.showMessageBox({ type: 'info', title: 'Order Saw', message: `Order confirmed for ${job.key}.` });
    } else {
      const message = res.erl ? res.erl : 'Timed out waiting for confirmation (.erl).';
      void dialog.showMessageBox({ type: 'warning', title: 'Order Saw Failed', message });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void dialog.showMessageBox({ type: 'warning', title: 'Order Saw Error', message: msg });
  }

  return {
    ok: true,
    path: finalDestBaseDir,
    copied,
    skipped,
    stagedAt,
    alreadyStaged,
    ...(collision ? { collision } : {})
  };
}
