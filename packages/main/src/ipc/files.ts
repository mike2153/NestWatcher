import { readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import chokidar, { type FSWatcher } from 'chokidar';
import { ok, err } from 'neverthrow';
import type { AppError, Machine, ReadyImportRes, ReadyFile } from '../../../shared/src';
import { ReadyImportReq } from '../../../shared/src';
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

export function registerFilesIpc() {
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


