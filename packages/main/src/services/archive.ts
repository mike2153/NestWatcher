import { existsSync } from 'fs';
import { promises as fsp } from 'fs';
import { join, basename, relative, isAbsolute } from 'path';
import type { JobStatus } from '../../../shared/src';
import { logger } from '../logger';
import { loadConfig } from './config';

const { copyFile, readdir, rename, mkdir, access } = fsp;

interface ArchiveJobOptions {
  jobKey: string;
  jobFolder: string | null;
  ncfile: string | null;
  status: JobStatus;
  sourceFiles?: string[];
}

/**
 * Ensures the archive directory exists
 */
async function ensureArchiveDir(archiveRoot: string): Promise<void> {
  try {
    await access(archiveRoot);
  } catch {
    await mkdir(archiveRoot, { recursive: true });
    logger.info({ archiveRoot }, 'Created archive root directory');
  }
}

async function walkFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        out.push(...await walkFiles(p));
      } else if (e.isFile()) {
        out.push(p);
      }
    }
    return out;
  } catch {
    return [];
  }
}

function stripNcExt(name: string): string {
  return name.toLowerCase().endsWith('.nc') ? name.slice(0, -3) : name;
}

async function resolveSourceRoot(jobFolder: string | null, processedJobsRoot: string): Promise<string | null> {
  const folder = (jobFolder ?? '').trim();
  if (!folder) return null;
  if (isAbsolute(folder) && existsSync(folder)) return folder;
  if (processedJobsRoot) {
    const candidate = join(processedJobsRoot, folder);
    if (existsSync(candidate)) return candidate;
  }
  if (existsSync(folder)) return folder;
  return null;
}

async function inferSourceFilesFromJob(options: ArchiveJobOptions, processedJobsRoot: string): Promise<string[]> {
  const sourceRoot = await resolveSourceRoot(options.jobFolder, processedJobsRoot);
  if (!sourceRoot) return [];

  let baseLower = stripNcExt((options.ncfile ?? '').trim().toLowerCase());
  const origLower = baseLower.replace(/^run\d+_/, '');
  if (!baseLower) {
    try {
      // Fallback: use the leaf folder name
      baseLower = basename(sourceRoot).toLowerCase();
    } catch {
      baseLower = '';
    }
  }
  if (!baseLower) return [];

  const allowedExts = ['.nc', '.lpt', '.pts', '.bmp', '.jpg', '.jpeg', '.csv', '.txt'];
  const imageExts = new Set(['.bmp', '.jpg', '.jpeg']);

  const files = await walkFiles(sourceRoot);
  const picked: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => { if (!seen.has(p)) { seen.add(p); picked.push(p); } };

  for (const p of files) {
    const nameLower = basename(p).toLowerCase();
    // Exact base match for all known extensions
    for (const ext of allowedExts) {
      if (nameLower === `${baseLower}${ext}` || (origLower && nameLower === `${origLower}${ext}`)) {
        add(p);
        break;
      }
    }
  }

  // Prefix match for images: include base-prefixed images like base-1.jpg, base_a.bmp, etc.
  for (const p of files) {
    const nameLower = basename(p).toLowerCase();
    const dot = nameLower.lastIndexOf('.');
    const ext = dot >= 0 ? nameLower.slice(dot) : '';
    if (!imageExts.has(ext)) continue;
    if (nameLower.startsWith(baseLower) || (origLower && nameLower.startsWith(origLower))) {
      add(p);
    }
  }

  return picked;
}

/**
 * Archives a completed job to the configured archive folder
 */
export async function archiveCompletedJob(options: ArchiveJobOptions): Promise<{
  ok: boolean;
  archivedPath?: string;
  error?: string
}> {
  let { jobKey, jobFolder, status, sourceFiles = [] } = options;

  // Only archive completed jobs
  if (status !== 'NESTPICK_COMPLETE' && status !== 'CNC_FINISH') {
    return { ok: true }; // Not an error, just skip
  }

  const config = loadConfig();
  const archiveRoot = config.paths.archiveRoot?.trim();

  if (!archiveRoot) {
    logger.warn({ jobKey }, 'archive: archiveRoot not configured, skipping');
    return { ok: true };
  }

  try {
    logger.debug({ jobKey, status, jobFolder, archiveRoot }, 'archive: start');
    await ensureArchiveDir(archiveRoot);

    // Create archive path preserving folder structure
    const rawRel = jobFolder ? relative(config.paths.processedJobsRoot || '', jobFolder) : '';
    const unsafe = rawRel.startsWith('..') || rawRel.includes(`..`);
    const jobRelPath = unsafe && jobFolder ? basename(jobFolder) : rawRel;
    const archiveJobDir = join(archiveRoot, jobRelPath);
    logger.debug({ jobKey, jobRelPath, archiveJobDir }, 'archive: resolved target directory');

    // Ensure the job's archive directory exists
    await mkdir(archiveJobDir, { recursive: true });

    // If no explicit source files were provided, try to infer them from the job folder
    if (!sourceFiles || sourceFiles.length === 0) {
      sourceFiles = await inferSourceFilesFromJob(options, config.paths.processedJobsRoot || '');
      if (sourceFiles.length === 0) {
        logger.warn({ jobKey, jobFolder }, 'archive: discovered 0 source files');
      } else {
        logger.info({ jobKey, discovered: sourceFiles.length }, 'archive: discovered source files');
      }
    }

    // Archive each source file
    let archivedCount = 0;
    for (const sourceFile of sourceFiles) {
      if (!existsSync(sourceFile)) {
        logger.debug({ sourceFile, jobKey }, 'Source file not found for archiving');
        continue;
      }

      const fileName = basename(sourceFile);
      // Normalize rerun file names: store without runN_ prefix in archive
      const normalizedName = fileName.replace(/^run\d+_/i, '');
      let targetPath = join(archiveJobDir, normalizedName);

      // Handle file name conflicts - prefix with date (dd.MM.yy_)
      try {
        await access(targetPath);
        const d = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const yy = String(d.getFullYear()).slice(-2);
        const prefix = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${yy}_`;
        targetPath = join(archiveJobDir, `${prefix}${normalizedName}`);
      } catch {
        // File doesn't exist, we can use the original name
      }

      try {
        // Try to move first, fall back to copy if cross-device
        await rename(sourceFile, targetPath);
        logger.debug({ source: sourceFile, target: targetPath }, 'Moved file to archive');
      } catch (err: unknown) {
        if (isNodeErrnoException(err) && err.code === 'EXDEV') {
          // Cross-device link, copy instead
          await copyFile(sourceFile, targetPath);
          // Try to remove the source after successful copy
          try {
            await fsp.unlink(sourceFile);
          } catch {
            logger.debug({ source: sourceFile }, 'Could not remove source file after copy');
          }
          logger.debug({ source: sourceFile, target: targetPath }, 'Copied file to archive');
        } else {
          throw err;
        }
      }
      archivedCount++;
    }

    if (archivedCount > 0) {
      logger.info({ jobKey, archiveJobDir, filesArchived: archivedCount }, 'archive: job archived successfully');
    } else {
      logger.warn({ jobKey, archiveJobDir }, 'archive: no files archived');
    }

    return { ok: true, archivedPath: archiveJobDir };
  } catch (err) {
    logger.error({ err, jobKey }, 'Failed to archive job');
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Unknown error'
    };
  }
}

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/**
 * Gets the archive path for a job
 */
export function getArchivePath(jobFolder: string | null, config: { paths: { archiveRoot: string; processedJobsRoot: string } }): string | null {
  const archiveRoot = config.paths.archiveRoot?.trim();
  if (!archiveRoot || !jobFolder) {
    return null;
  }

  const rawRel = relative(config.paths.processedJobsRoot || '', jobFolder);
  const unsafe = rawRel.startsWith('..') || rawRel.includes('..');
  const jobRelPath = unsafe ? basename(jobFolder) : rawRel;
  return join(archiveRoot, jobRelPath);
}

/**
 * Checks if archived files exist for a job
 */
export async function checkArchiveExists(jobFolder: string | null): Promise<boolean> {
  const config = loadConfig();
  const archivePath = getArchivePath(jobFolder, config);

  if (!archivePath) {
    return false;
  }

  try {
    await access(archivePath);
    const files = await readdir(archivePath);
    return files.length > 0;
  } catch {
    return false;
  }
}

/**
 * List archived files for a job
 */
export async function listArchivedFiles(jobFolder: string | null): Promise<string[]> {
  const config = loadConfig();
  const archivePath = getArchivePath(jobFolder, config);

  if (!archivePath) {
    return [];
  }

  try {
    const files = await readdir(archivePath);
    return files.map(f => join(archivePath, f));
  } catch {
    return [];
  }
}
