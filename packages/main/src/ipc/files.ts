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
// Includes .csv per updated requirements.
const DELETE_EXTENSIONS = new Set(['.bmp', '.jpg', '.jpeg', '.png', '.pts', '.lpt', '.nc', '.csv']);

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
      if (remaining.length > 0) return false;
      try {
        await fsp.rmdir(dir);
        return true;
      } catch {
        return false;
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
      // Always include the exact .nc file if present
      targets.add(absoluteNc);
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
          targets.add(join(containingDir, entry));
        }
      }
    }

    const deletedFiles: string[] = [];
    let deletedCount = 0;
    for (const absolute of targets) {
      try {
        await fsp.unlink(absolute);
        deletedCount += 1;
        deletedFiles.push(normalizeRelativePath(relative(root, absolute)));
      } catch (error) {
        const errObj = error as NodeJS.ErrnoException;
        if (errObj?.code === 'ENOENT') {
          continue;
        }
        errors.push({
          file: normalizeRelativePath(relative(root, absolute)),
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // Attempt to remove empty directories for each affected job folder, up to but not including the root
    for (const dir of candidateDirs) {
      try {
        await removeEmptyDirsUpToRoot(root, dir);
      } catch {
        // ignore cleanup errors; file deletions are primary concern
      }
    }

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

