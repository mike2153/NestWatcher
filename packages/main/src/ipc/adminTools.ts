import { BrowserWindow } from 'electron';
import { normalize, resolve, join, basename } from 'path';
import { promises as fsp } from 'fs';
import { ok, err } from 'neverthrow';

import type { AppError, AdminToolsCleanupTestCsvRes, AdminToolsWriteFileRes } from '../../../shared/src';
import { AdminToolsCleanupTestCsvReq, AdminToolsWriteFileReq } from '../../../shared/src';
import { createAppError } from './errors';
import { registerResultHandler } from './result';
import { copySession, requireAdminSession } from '../services/authSessions';
import { loadConfig } from '../services/config';
import { listMachines } from '../repo/machinesRepo';
import { applyWindowNavigationGuards } from '../security';
import { logger } from '../logger';

let adminToolsWin: BrowserWindow | null = null;

function normalizeLineEndings(input: string, mode: 'crlf' | 'lf'): string {
  const lf = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return mode === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf;
}

function isSafeFileName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  // Disallow any path separators / traversal.
  if (trimmed.includes('..')) return false;
  if (trimmed.includes('/') || trimmed.includes('\\')) return false;
  if (trimmed.includes(':')) return false;
  // basename(name) must be exactly the input.
  return basename(trimmed) === trimmed;
}

function resolveSubdir(root: string, relativeDir: string): { ok: true; dir: string } | { ok: false; error: AppError } {
  const rootResolved = resolve(root);
  const rel = (relativeDir ?? '').trim();
  const candidate = resolve(rootResolved, rel);

  const rootLower = rootResolved.toLowerCase();
  const candidateLower = candidate.toLowerCase();

  if (candidateLower === rootLower) return { ok: true, dir: candidate };
  if (candidateLower.startsWith(rootLower + '\\') || candidateLower.startsWith(rootLower + '/')) {
    return { ok: true, dir: candidate };
  }

  return {
    ok: false,
    error: createAppError('adminTools.invalidRelativeDir', 'Relative directory must stay inside the configured target folder.', {
      root: rootResolved,
      relativeDir: rel,
      resolved: candidate
    })
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fsp.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(path: string): Promise<void> {
  await fsp.mkdir(path, { recursive: true });
}

async function writeFileAtomic(dest: string, content: string): Promise<void> {
  const tmp = `${dest}.tmp-${Date.now()}`;
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, dest);
}

async function writeFileChunked(dest: string, content: string, delayMs: number): Promise<void> {
  const half = Math.floor(content.length / 2);
  const a = content.slice(0, half);
  const b = content.slice(half);
  const handle = await fsp.open(dest, 'w');
  try {
    await handle.write(a, 0, 'utf8');
    await handle.sync();
    await new Promise((r) => setTimeout(r, delayMs));
    await handle.write(b, a.length, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function unlinkWithRetries(path: string, options?: { retries?: number; initialDelayMs?: number }): Promise<{ ok: true } | { ok: false; code?: string; message: string }> {
  const retries = options?.retries ?? 5;
  const initialDelayMs = options?.initialDelayMs ?? 200;

  let delay = initialDelayMs;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await fsp.unlink(path);
      return { ok: true };
    } catch (error) {
      const errAny = error as Error & { code?: string };
      const code = errAny?.code;

      // Missing file is a "not a failure" for cleanup.
      if (code === 'ENOENT') {
        return { ok: false, code, message: 'missing' };
      }

      const retryable = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
      if (!retryable || attempt === retries) {
        return { ok: false, code, message: errAny instanceof Error ? errAny.message : String(error) };
      }

      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 5000);
    }
  }

  return { ok: false, message: 'unknown delete failure' };
}

async function resolveTargetRoot(target: { kind: string; machineId?: number }): Promise<{ ok: true; root: string } | { ok: false; error: AppError }> {
  const cfg = loadConfig();
  const paths = cfg.paths;
  const raw = (v: string | undefined | null) => (v ?? '').trim();

  switch (target.kind) {
    case 'autoPacCsvDir': {
      const root = raw(paths.autoPacCsvDir);
      if (!root) return { ok: false, error: createAppError('adminTools.targetNotConfigured', 'AutoPAC CSV Directory is not configured.') };
      return { ok: true, root: normalize(root) };
    }
    case 'grundnerFolderPath': {
      const root = raw(paths.grundnerFolderPath);
      if (!root) return { ok: false, error: createAppError('adminTools.targetNotConfigured', 'Grundner Folder Path is not configured.') };
      return { ok: true, root: normalize(root) };
    }
    case 'processedJobsRoot': {
      const root = raw(paths.processedJobsRoot);
      if (!root) return { ok: false, error: createAppError('adminTools.targetNotConfigured', 'Processed Jobs Root is not configured.') };
      return { ok: true, root: normalize(root) };
    }
    case 'archiveRoot': {
      const root = raw(paths.archiveRoot);
      if (!root) return { ok: false, error: createAppError('adminTools.targetNotConfigured', 'Archive Root is not configured.') };
      return { ok: true, root: normalize(root) };
    }
    case 'jobsRoot': {
      const root = raw(paths.jobsRoot);
      if (!root) return { ok: false, error: createAppError('adminTools.targetNotConfigured', 'Jobs Root is not configured.') };
      return { ok: true, root: normalize(root) };
    }
    case 'quarantineRoot': {
      const root = raw(paths.quarantineRoot);
      if (!root) return { ok: false, error: createAppError('adminTools.targetNotConfigured', 'Quarantine Root is not configured.') };
      return { ok: true, root: normalize(root) };
    }
    case 'testDataFolderPath': {
      const root = raw(cfg.test?.testDataFolderPath);
      if (!root) return { ok: false, error: createAppError('adminTools.targetNotConfigured', 'Test Data Folder Path is not configured.') };
      return { ok: true, root: normalize(root) };
    }
    case 'machineApJobfolder': {
      const machineId = target.machineId;
      if (typeof machineId !== 'number') {
        return { ok: false, error: createAppError('adminTools.invalidArguments', 'machineId is required for machineApJobfolder target.') };
      }
      const machines = await listMachines();
      const machine = machines.find((m) => m.machineId === machineId);
      const root = raw(machine?.apJobfolder ?? '');
      if (!root) {
        return { ok: false, error: createAppError('adminTools.targetNotConfigured', `Machine ${machineId} apJobfolder is not configured.`) };
      }
      return { ok: true, root: normalize(root) };
    }
    case 'machineNestpickFolder': {
      const machineId = target.machineId;
      if (typeof machineId !== 'number') {
        return { ok: false, error: createAppError('adminTools.invalidArguments', 'machineId is required for machineNestpickFolder target.') };
      }
      const machines = await listMachines();
      const machine = machines.find((m) => m.machineId === machineId);
      const root = raw(machine?.nestpickFolder ?? '');
      if (!root) {
        return { ok: false, error: createAppError('adminTools.targetNotConfigured', `Machine ${machineId} nestpickFolder is not configured.`) };
      }
      return { ok: true, root: normalize(root) };
    }
    default:
      return { ok: false, error: createAppError('adminTools.invalidTarget', `Unknown admin tools target: ${target.kind}`) };
  }
}

export function registerAdminToolsIpc() {
  registerResultHandler<AdminToolsWriteFileRes>(
    'adminTools:writeFile',
    async (event, raw) => {
      const session = await requireAdminSession(event);
      if (session.username.toLowerCase() !== 'admin') {
        return err(createAppError('auth.forbidden', 'This tool is only available when signed in as the built-in "admin" user.'));
      }

      const parsed = AdminToolsWriteFileReq.safeParse(raw);
      if (!parsed.success) {
        return err(createAppError('adminTools.invalidArguments', parsed.error.message));
      }

      const req = parsed.data;

      const relativeDir = (req.relativeDir ?? '').trim();
      const overwrite = req.overwrite ?? true;
      const writeMode = req.writeMode ?? 'atomic';
      const lineEnding = req.lineEnding ?? 'crlf';
      const chunkDelayMs = req.chunkDelayMs ?? 250;
      if (!isSafeFileName(req.fileName)) {
        return err(createAppError('adminTools.invalidFileName', 'Invalid file name. Use a filename only (no slashes, no .., no drive letters).', {
          fileName: req.fileName
        }));
      }

      const targetRoot = await resolveTargetRoot(req.target);
      if (!targetRoot.ok) return err(targetRoot.error);

      const subdir = resolveSubdir(targetRoot.root, relativeDir);
      if (!subdir.ok) return err(subdir.error);

      const folder = subdir.dir;
      const dest = join(folder, req.fileName.trim());

      if (!overwrite && (await fileExists(dest))) {
        return err(createAppError('adminTools.fileExists', `File already exists: ${dest}`, { dest }));
      }

      try {
        await ensureDir(folder);
      } catch (error) {
        return err(createAppError('adminTools.targetUnreachable', 'Target folder is not writable or does not exist.', {
          folder,
          error: error instanceof Error ? error.message : String(error)
        }));
      }

      const content = normalizeLineEndings(req.content ?? '', lineEnding);

      try {
        if (writeMode === 'chunked') {
          await writeFileChunked(dest, content, chunkDelayMs);
        } else if (writeMode === 'direct') {
          await fsp.writeFile(dest, content, 'utf8');
        } else {
          await writeFileAtomic(dest, content);
        }
        return ok({ fullPath: dest });
      } catch (error) {
        return err(createAppError('adminTools.writeFailed', 'Failed to write test file.', {
          dest,
          error: error instanceof Error ? error.message : String(error)
        }));
      }
    },
    { requiresAdmin: true }
  );

  registerResultHandler<null>(
    'adminTools:openWindow',
    async (event) => {
      const session = await requireAdminSession(event);
      if (session.username.toLowerCase() !== 'admin') {
        return err(createAppError('auth.forbidden', 'This tool is only available when signed in as the built-in "admin" user.'));
      }

      if (adminToolsWin && !adminToolsWin.isDestroyed()) {
        if (adminToolsWin.isMinimized()) adminToolsWin.restore();
        adminToolsWin.show();
        adminToolsWin.focus();
        return ok(null);
      }

      const preloadPath = join(__dirname, '../../preload/dist/index.js');

      const parent = BrowserWindow.fromWebContents(event.sender);
      adminToolsWin = new BrowserWindow({
        width: 1200,
        height: 800,
        title: 'Admin Tools',
        parent: parent ?? undefined,
        show: false,
        webPreferences: {
          preload: preloadPath,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          webSecurity: true
        }
      });

      // Share the existing auth session with the new window.
      // Important: in this repo sessions are tracked per-webContents, so without this
      // the popout window behaves like a fresh login.
      copySession(event.sender, adminToolsWin.webContents);

      applyWindowNavigationGuards(adminToolsWin.webContents);

      adminToolsWin.on('closed', () => {
        adminToolsWin = null;
      });

      adminToolsWin.on('ready-to-show', () => {
        adminToolsWin?.show();
        adminToolsWin?.focus();
      });

      adminToolsWin.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
        logger.error({ errorCode, errorDescription }, 'Admin Tools window failed to load');
        if (adminToolsWin && !adminToolsWin.isDestroyed()) {
          adminToolsWin.show();
        }
      });

      try {
        const devServer = process.env.VITE_DEV_SERVER_URL;
        if (devServer) {
          const url = new URL('/admin-tools?window=admin-tools', devServer).toString();
          await adminToolsWin.loadURL(url);
        } else {
          await adminToolsWin.loadFile(join(__dirname, '../../renderer/dist/index.html'), {
            search: '?window=admin-tools',
            hash: '/admin-tools'
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error }, 'Failed to create Admin Tools window');

        try {
          adminToolsWin?.destroy();
        } catch {
          // ignore
        }
        adminToolsWin = null;

        return err(createAppError('adminTools.openWindowFailed', message));
      }

      return ok(null);
    },
    { requiresAdmin: true }
  );

  registerResultHandler<AdminToolsCleanupTestCsvRes>(
    'adminTools:cleanupTestCsv',
    async (event, raw) => {
      const session = await requireAdminSession(event);
      if (session.username.toLowerCase() !== 'admin') {
        return err(createAppError('auth.forbidden', 'This tool is only available when signed in as the built-in "admin" user.'));
      }

      const parsed = AdminToolsCleanupTestCsvReq.safeParse(raw);
      if (!parsed.success) {
        return err(createAppError('adminTools.invalidArguments', parsed.error.message));
      }

      const target = parsed.data.target;
      if (target.kind !== 'grundnerFolderPath' && target.kind !== 'machineNestpickFolder') {
        return err(createAppError('adminTools.invalidTarget', 'CSV cleanup is only supported for Grundner and Nestpick folders.'));
      }

      const allowlist = target.kind === 'grundnerFolderPath'
        ? ['order_saw.csv', 'ChangeMachNr.csv', 'get_production.csv', 'productionLIST_del.csv']
        : ['Report_FullNestpickUnstack.csv'];

      const targetRoot = await resolveTargetRoot(target);
      if (!targetRoot.ok) return err(targetRoot.error);

      const folder = targetRoot.root;
      const deleted: string[] = [];
      const missing: string[] = [];
      const failed: { file: string; error: string }[] = [];

      for (const file of allowlist) {
        const fullPath = join(folder, file);
        const res = await unlinkWithRetries(fullPath);
        if (res.ok) {
          deleted.push(file);
        } else if (res.code === 'ENOENT' || res.message === 'missing') {
          missing.push(file);
        } else {
          failed.push({ file, error: res.message });
        }
      }

      return ok({ deleted, missing, failed });
    },
    { requiresAdmin: true }
  );
}
