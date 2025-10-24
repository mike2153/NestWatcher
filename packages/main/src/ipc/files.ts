import { readdirSync, statSync, promises as fsp } from 'fs';
import { join, relative, dirname, extname, basename, resolve } from 'path';
import chokidar, { type FSWatcher } from 'chokidar';
import { ok, err } from 'neverthrow';
import type { AppError, Machine, ReadyImportRes, ReadyFile, ReadyDeleteRes } from '../../../shared/src';
import { ReadyImportReq, ReadyDeleteReq } from '../../../shared/src';
import { listMachines } from '../repo/machinesRepo';
import { importReadyFile } from '../services/readyImport';
import { findJobDetailsByNcBase } from '../repo/jobsRepo';
import { createAppError } from './errors';
import { registerResultHandler } from './result';
import { onContentsDestroyed } from './onDestroyed';
import { logger } from '../logger';

function collectFiles(root: string, current: string = root) {
  const entries = readdirSync(current, { withFileTypes: true });
  const out: { fullPath: string; relativePath: string; name: string }[] = [];
  for (const entry of entries) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(root, fullPath));
    } else if (entry.isFile()) {
      const rel = relative(root, fullPath).split('\\').join('/');
      if (/\.nc$/i.test(entry.name)) {
        out.push({ fullPath, relativePath: rel, name: entry.name });
      }
    }
  }
  return out;
}

function baseFromName(name: string) {
  const idx = name.lastIndexOf('.');
  const withoutExt = idx >= 0 ? name.slice(0, idx) : name;
  return withoutExt.replace(/\s+/g, '');
}

// File types to remove when cleaning up a sheet's artifacts in Ready-To-Run.
// Includes .csv per updated requirements and Planit fallback mapping (.txt).
const DELETE_EXTENSIONS = new Set(['.bmp', '.jpg', '.jpeg', '.png', '.gif', '.pts', '.lpt', '.nc', '.csv', '.txt']);

function normalizeRelativePath(input: string) {
  return input.split('\\').join('/');
}

export function registerFilesIpc() {
  const isWindows = process.platform === 'win32';
  const samePath = (a: string, b: string) => (isWindows ? a.toLowerCase() === b.toLowerCase() : a === b);

  async function removeEmptyDirsUpToRoot(root: string, startDir: string) {
    const rootResolved = resolve(root);
    let current = resolve(startDir);
    const IGNORABLE = new Set(['thumbs.db', 'desktop.ini', '.ds_store']);

    async function pruneEmptyDir(dir: string): Promise<boolean> {
      if (samePath(dir, rootResolved)) return false; // never delete the root
      let dirents: Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }>;
      try {
        dirents = await fsp.readdir(dir, { withFileTypes: true } as unknown as { withFileTypes: true }) as unknown as Array<{
          name: string; isFile: () => boolean; isDirectory: () => boolean;
        }>;
      } catch {
        // Can't read dir; treat as non-removable
        return false;
      }

      // Remove ignorable OS noise files
      for (const d of dirents) {
        if (d.isFile && d.isFile()) {
          const nm = d.name.toLowerCase();
          if (IGNORABLE.has(nm) || nm.startsWith('._')) {
            try { await fsp.unlink(join(dir, d.name)); } catch { /* ignore */ }
          }
        }
      }

      // Re-read with types and prune child directories first (bottom-up)
      try {
        dirents = await fsp.readdir(dir, { withFileTypes: true } as unknown as { withFileTypes: true }) as unknown as Array<{
          name: string; isFile: () => boolean; isDirectory: () => boolean;
        }>;
      } catch {
        return false;
      }
      for (const d of dirents) {
        if (d.isDirectory && d.isDirectory()) {
          await pruneEmptyDir(join(dir, d.name));
        }
      }

      // After pruning children and noise files, check if empty
      let remaining: string[];
      try {
        remaining = await fsp.readdir(dir);
      } catch {
        return false;
      }
      if (remaining.length > 0) {
        logger.info(
          `files:ready:delete: directory not empty ${dir} remaining=[${remaining.join(', ')}]`
        );
        return false;
      }
      try {
        // Prefer rmdir for empty directories
        await fsp.rmdir(dir);
        logger.info(`files:ready:delete: removed empty directory (rmdir) ${dir}`);
        return true;
      } catch (err1) {
        try {
          // Fallback to rm with recursive=true (directory is verified empty above)
          await fsp.rm(dir, { recursive: true, force: true });
          logger.info(`files:ready:delete: removed empty directory (rm) ${dir}`);
          return true;
        } catch (err2) {
          logger.warn(
            `files:ready:delete: failed to remove empty directory ${dir} err1=${err1 instanceof Error ? err1.message : String(err1)} err2=${err2 instanceof Error ? err2.message : String(err2)}`
          );
          return false;
        }
      }
    }

    // Walk upward from the starting directory, pruning empties on each ancestor
    while (!samePath(current, rootResolved)) {
      await pruneEmptyDir(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  async function buildReadyList(machineId: number): Promise<{ machineId: number; files: ReadyFile[] }> {
    const machines = await listMachines();
    const machine = machines.find((m: Machine) => m.machineId === machineId);
    if (!machine || !machine.apJobfolder) return { machineId, files: [] };
    const root = machine.apJobfolder;
    const fileEntries = collectFiles(root);
    const files: ReadyFile[] = await Promise.all(
      fileEntries.map(async ({ fullPath, relativePath, name }) => {
        const stats = statSync(fullPath);
        const base = baseFromName(name);
        const job = base ? await findJobDetailsByNcBase(base) : null;
        return {
          name,
          relativePath,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          inDatabase: !!job,
          jobKey: job?.key ?? null,
          status: job?.status ?? null,
          jobMaterial: job?.material ?? null,
          jobSize: job?.size ?? null,
          jobParts: job?.parts ?? null,
          jobThickness: job?.thickness ?? null,
          jobDateadded: job?.dateadded ?? null,
          addedAtR2R: new Date(stats.mtimeMs).toISOString()
        } satisfies ReadyFile;
      })
    );
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return { machineId, files };
  }

  registerResultHandler('files:listReady', async (_e, rawMachineId) => {
    const machineId = typeof rawMachineId === 'number' ? rawMachineId : Number(rawMachineId);
    if (!Number.isFinite(machineId)) {
      return err(createAppError('files.invalidMachineId', 'Machine id must be a number'));
    }
    const { files, machineId: mid } = await buildReadyList(machineId);
    return ok<{ machineId: number; files: ReadyFile[] }, AppError>({ machineId: mid, files });
  });

  // Live subscription for Ready-To-Run folder changes
  const readyWatchers = new Map<number, FSWatcher>(); // keyed by WebContents.id

  registerResultHandler('files:ready:subscribe', async (event, rawMachineId) => {
    const contents = event.sender;
    const webId = contents.id;
    const machineId = typeof rawMachineId === 'number' ? rawMachineId : Number(rawMachineId);
    if (!Number.isFinite(machineId)) {
      return err(createAppError('files.invalidMachineId', 'Machine id must be a number'));
    }
    // Cleanup an existing watcher for this WebContents, if any
    const existing = readyWatchers.get(webId);
    if (existing) {
      try { await existing.close(); } catch (e) { void e; }
      readyWatchers.delete(webId);
    }

    const machines = await listMachines();
    const machine = machines.find((m: Machine) => m.machineId === machineId);
    if (!machine || !machine.apJobfolder) {
      return err(createAppError('files.machineNotFound', 'Machine not found or ap_jobfolder not set'));
    }
    const root = machine.apJobfolder;

    let timer: NodeJS.Timeout | null = null;
    const scheduleUpdate = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        const { files } = await buildReadyList(machineId);
        if (!contents.isDestroyed()) {
          contents.send('files:ready:update', { machineId, files });
        }
      }, 200) as unknown as NodeJS.Timeout;
      if (timer && typeof timer.unref === 'function') {
        timer.unref();
      }
    };

    const watcher = chokidar.watch(root, {
      ignoreInitial: false,
      depth: 5,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
    });
    watcher.on('add', (p) => { if (/\.nc$/i.test(p)) scheduleUpdate(); });
    watcher.on('unlink', (p) => { if (/\.nc$/i.test(p)) scheduleUpdate(); });
    watcher.on('change', (p) => { if (/\.nc$/i.test(p)) scheduleUpdate(); });
    watcher.on('error', () => scheduleUpdate());

    readyWatchers.set(webId, watcher);

    onContentsDestroyed(contents, () => {
      const w = readyWatchers.get(webId);
      if (w) {
        w.close().catch((err) => { void err; });
        readyWatchers.delete(webId);
      }
    });

    // Send initial snapshot
    const { files } = await buildReadyList(machineId);
    if (!contents.isDestroyed()) {
      contents.send('files:ready:update', { machineId, files });
    }

    return ok<null, AppError>(null);
  });

  registerResultHandler('files:ready:unsubscribe', async (event) => {
    const webId = event.sender.id;
    const w = readyWatchers.get(webId);
    if (w) {
      try { await w.close(); } catch (e) { void e; }
      readyWatchers.delete(webId);
    }
    return ok<null, AppError>(null);
  });

  registerResultHandler('files:ready:delete', async (_event, raw) => {
    const parsed = ReadyDeleteReq.safeParse(raw ?? {});
    if (!parsed.success) {
      return err(createAppError('files.invalidArguments', parsed.error.message));
    }

    const { machineId, relativePaths } = parsed.data;
    logger.info(
      `files:ready:delete: request machineId=${machineId} paths=[${relativePaths.join(', ')}]`
    );
    const machines = await listMachines();
    const machine = machines.find((m: Machine) => m.machineId === machineId);
    if (!machine || !machine.apJobfolder) {
      return err(createAppError('files.machineNotFound', 'Machine not found or ap_jobfolder not set'));
    }
    const root = machine.apJobfolder;

    const uniquePaths = Array.from(new Set(relativePaths.map(normalizeRelativePath)));
    const errors: ReadyDeleteRes['errors'] = [];
    const targets = new Set<string>();
    const candidateDirs = new Set<string>();
    // Track per-directory state to allow safe deletion of Planit family CSVs
    const dirEntriesByDir = new Map<string, string[]>();
    const selectedStemsByDir = new Map<string, Set<string>>();
    const planitPrefixesByDir = new Map<string, Set<string>>();

    for (const rel of uniquePaths) {
      if (rel.includes('..') || rel.startsWith('/') || /^[a-zA-Z]:\//.test(rel)) {
        errors.push({ file: rel, message: 'Relative path cannot contain ..' });
        continue;
      }
      const fileName = basename(rel);
      const ext = extname(fileName);
      const stemExact = fileName.slice(0, fileName.length - ext.length);
      const stemLower = stemExact.toLowerCase();
      const stemNoSpacesLower = stemLower.replace(/\s+/g, '');

      const absoluteNc = join(root, rel);
      const containingDir = dirname(absoluteNc);
      candidateDirs.add(containingDir);
      let dirEntries: string[];
      try {
        dirEntries = await fsp.readdir(containingDir);
      } catch (error) {
        const errObj = error as NodeJS.ErrnoException;
        if (errObj?.code !== 'ENOENT') {
          errors.push({ file: rel, message: error instanceof Error ? error.message : String(error) });
        }
        continue;
      }
      logger.info(
        `files:ready:delete: scanning directory rel=${rel} dir=${containingDir} entries=${dirEntries.length}`
      );
      // Track entries for this directory (case preserved)
      dirEntriesByDir.set(containingDir, dirEntries.slice());

      // Track selected stems (both with and without spaces) for this directory
      const stems = selectedStemsByDir.get(containingDir) ?? new Set<string>();
      stems.add(stemLower);
      stems.add(stemNoSpacesLower);
      selectedStemsByDir.set(containingDir, stems);
      // Track Planit family prefix (first 3 letters of NC base) for potential family CSV cleanup
      if (stemLower.length >= 3) {
        const prefixes = planitPrefixesByDir.get(containingDir) ?? new Set<string>();
        prefixes.add(stemLower.slice(0, 3));
        planitPrefixesByDir.set(containingDir, prefixes);
      }
      // Always include the exact .nc file if present
      targets.add(absoluteNc);
      logger.info(`files:ready:delete: add target (.nc) ${absoluteNc}`);
      for (const entry of dirEntries) {
        const entryLower = entry.toLowerCase();
        const extension = extname(entryLower);
        if (!DELETE_EXTENSIONS.has(extension)) continue;
        const entryStemLower = entryLower.slice(0, entryLower.length - extension.length);
        if (
          entryStemLower === stemLower ||
          entryStemLower === stemNoSpacesLower ||
          entryStemLower.startsWith(stemLower) ||
          entryStemLower.startsWith(stemNoSpacesLower)
        ) {
          const abs = join(containingDir, entry);
          targets.add(abs);
          logger.info(`files:ready:delete: add target (by stem match) ${abs}`);
        }
      }

      // Planit-specific cleanup: delete sticker BMPs referenced by mapping files
      // 1) Family CSV: <prefix>.csv (first 3 letters of NC base)
      // 2) TXT fallback: <base>.txt listing image paths in pipe-delimited format
      const addIfExists = async (absPath: string) => {
        try {
          const st = await fsp.stat(absPath);
          if (st.isFile()) targets.add(absPath);
        } catch {
          // ignore
        }
      };
      const resolveImageInDir = (dir: string, token: string): string | null => {
        const name = basename(token).trim();
        if (!name) return null;
        const lower = name.toLowerCase();
        // Try as-is
        const direct = dirEntries.find((e) => e.toLowerCase() === lower);
        if (direct) return join(dir, direct);
        // Try with bmp/jpg/jpeg if token omitted extension
        const stem = lower.replace(/\.[^.]+$/, '');
        const tryNames = [`${stem}.bmp`, `${stem}.jpg`, `${stem}.jpeg`];
        for (const nm of tryNames) {
          const found = dirEntries.find((e) => e.toLowerCase() === nm);
          if (found) return join(dir, found);
        }
        return null;
      };
      // Helper to delete images listed by tokens
      const deleteImagesFromTokens = async (dir: string, tokens: string[]) => {
        logger.info(
          `files:ready:delete: resolving image tokens dir=${dir} count=${tokens.length}`
        );
        for (const t of tokens) {
          const img = resolveImageInDir(dir, t);
          if (img) {
            targets.add(img);
            logger.info(`files:ready:delete: add target (token) token=${t} path=${img}`);
          } else {
            logger.info(`files:ready:delete: token not resolved token=${t}`);
          }
        }
      };

      // 1) Family CSV mapping in containing dir or one level up
      try {
        const prefix = stemLower.slice(0, 3);
        if (prefix && prefix.length === 3) {
          const parentDir = dirname(containingDir);
          const candidates = [join(containingDir, `${prefix}.csv`), join(parentDir, `${prefix}.csv`)];
          let familyFound = false;
          for (const cand of candidates) {
            try {
              const raw = await fsp.readFile(cand, 'utf8');
              // Parse rows: first column can be numeric label; any cell with .bmp/.jpg/.jpeg is an image token
              const rows = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
              const imageTokens: string[] = [];
              for (const row of rows) {
                const cols = row.split(',');
                for (const c of cols) {
                  const v = c.trim();
                  const lv = v.toLowerCase();
                  if (lv.endsWith('.bmp') || lv.endsWith('.jpg') || lv.endsWith('.jpeg')) imageTokens.push(v);
                }
              }
              logger.info(
                `files:ready:delete: parsed family CSV file=${cand} rows=${rows.length} tokens=${imageTokens.length}`
              );
              familyFound = true;
              if (imageTokens.length) {
                await deleteImagesFromTokens(containingDir, imageTokens);
              }
            } catch {
              // ignore missing/unreadable
            }
          }
          if (!familyFound) {
            logger.info(
              `files:ready:delete: family CSV not found for prefix=${prefix} in [${candidates.join(', ')}]`
            );
          }
        }
      } catch {
        // ignore mapping parse errors
      }

      // 2) TXT fallback mapping next to the NC
      try {
        const txtCandidates = [`${stemExact}.txt`, `${stemLower}.txt`, `${stemNoSpacesLower}.txt`];
        const foundTxt = dirEntries.find((e) => txtCandidates.some((n) => e.toLowerCase() === n.toLowerCase()));
        if (foundTxt) {
          const txtPath = join(containingDir, foundTxt);
          try {
            const raw = await fsp.readFile(txtPath, 'utf8');
            const lines = raw.split(/\r?\n/);
            const tokens: string[] = [];
            for (let i = 0; i < lines.length; i++) {
              if (i === 0) continue; // skip header
              const line = lines[i];
              if (!line || !line.includes('|')) continue;
              const cols = line.split('|');
              if (cols.length < 3) continue;
              const rawPath = (cols[2] ?? '').trim();
              if (rawPath) tokens.push(rawPath);
            }
            logger.info(
              `files:ready:delete: parsed mapping TXT file=${txtPath} tokens=${tokens.length}`
            );
            if (tokens.length) {
              await deleteImagesFromTokens(containingDir, tokens);
            }
          } catch {
            // ignore read failures
          }
          // Also delete the mapping TXT itself
          await addIfExists(txtPath);
          logger.info(`files:ready:delete: add target (mapping TXT) ${txtPath}`);
        }
      } catch {
        // ignore mapping parse errors
      }
    }

    // After collecting primary targets, consider removing Planit family CSVs
    // when there are no other Planit .nc files left in that folder.
    for (const [dir, entries] of dirEntriesByDir.entries()) {
      const selectedStems = selectedStemsByDir.get(dir) ?? new Set<string>();
      const entriesLower = entries.map((e) => e.toLowerCase());
      const ncFiles = entriesLower.filter((e) => e.endsWith('.nc'));
      const prefixes = planitPrefixesByDir.get(dir) ?? new Set<string>();
      for (const p of prefixes) {
        if (!p || p.length !== 3) continue;
        // Determine if any other (non-selected) .nc in this dir shares this 3-letter prefix
        let otherExistsForPrefix = false;
        for (const nc of ncFiles) {
          const stem = nc.slice(0, nc.length - '.nc'.length);
          const stemNoSpaces = stem.replace(/\s+/g, '');
          if (selectedStems.has(stem) || selectedStems.has(stemNoSpaces)) continue;
          if (stem.startsWith(p) || stemNoSpaces.startsWith(p)) {
            otherExistsForPrefix = true;
            break;
          }
        }
        logger.info(
          `files:ready:delete: family CSV decision dir=${dir} prefix=${p} selected=${selectedStems.size} otherExists=${otherExistsForPrefix}`
        );
        if (!otherExistsForPrefix) {
          const familyLower = `${p.toLowerCase()}.csv`;
          const match = entries.find((e) => e.toLowerCase() === familyLower);
          if (match) {
            const abs = join(dir, match);
            targets.add(abs);
            logger.info(`files:ready:delete: add target (family CSV) ${abs}`);
          } else {
            logger.info(
              `files:ready:delete: family CSV not present in dir for prefix=${p} expected=${familyLower}`
            );
          }
        }
      }
    }

    const deletedFiles: string[] = [];
    let deletedCount = 0;
    for (const absolute of targets) {
      try {
        await fsp.unlink(absolute);
        deletedCount += 1;
        const relDeleted = normalizeRelativePath(relative(root, absolute));
        deletedFiles.push(relDeleted);
        logger.info(`files:ready:delete: deleted ${absolute}`);
      } catch (error) {
        const errObj = error as NodeJS.ErrnoException;
        if (errObj?.code === 'ENOENT') {
          logger.info(`files:ready:delete: already deleted ${absolute}`);
          continue;
        }
        errors.push({
          file: normalizeRelativePath(relative(root, absolute)),
          message: error instanceof Error ? error.message : String(error)
        });
        logger.warn(
          `files:ready:delete: delete failed ${absolute} error=${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Attempt to remove empty directories for each affected job folder, up to but not including the root
    for (const dir of candidateDirs) {
      try {
        logger.info(`files:ready:delete: prune attempt ${dir}`);
        await removeEmptyDirsUpToRoot(root, dir);
        // Post-prune check for visibility
        try {
          const listing = await fsp.readdir(dir);
          logger.info(
            `files:ready:delete: post-prune still exists ${dir} entries=${listing.length} [${listing.join(
              ', '
            )}]`
          );
        } catch (e) {
          logger.info(`files:ready:delete: post-prune removed ${dir}`);
        }
      } catch {
        // ignore cleanup errors; file deletions are primary concern
      }
    }

    logger.info(
      `files:ready:delete: result deleted=${deletedCount} errorCount=${errors.length} files=[${deletedFiles.join(', ')}]`
    );
    return ok<ReadyDeleteRes, AppError>({ deleted: deletedCount, files: deletedFiles, errors });
  });

  registerResultHandler('files:importReady', async (_event, raw) => {
    const parsed = ReadyImportReq.safeParse(raw ?? {});
    if (!parsed.success) {
      return err(createAppError('files.invalidArguments', parsed.error.message));
    }
    try {
      const result = await importReadyFile(parsed.data.machineId, parsed.data.relativePath);
      return ok<ReadyImportRes, AppError>(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(createAppError('files.importFailed', message));
    }
  });
}

