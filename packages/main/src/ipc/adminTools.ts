import { normalize, resolve, join, basename } from 'path';
import { promises as fsp } from 'fs';
import { ok, err } from 'neverthrow';

import type { AppError, AdminToolsWriteFileRes } from '../../../shared/src';
import { AdminToolsWriteFileReq } from '../../../shared/src';
import { createAppError } from './errors';
import { registerResultHandler } from './result';
import { requireAdminSession } from '../services/authSessions';
import { loadConfig } from '../services/config';
import { listMachines } from '../repo/machinesRepo';

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
}
