import { existsSync } from 'fs';
import { promises as fsp } from 'fs';
import { join, basename } from 'path';
import { logger } from '../logger';

const { rename, copyFile, readdir, mkdir, unlink, rmdir, stat, access } = fsp;

export interface MoveFolderResult {
  ok: boolean;
  newPath?: string;
  error?: string;
}

/**
 * Type guard for Node.js ErrnoException
 */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/**
 * Recursively copy a folder and all its contents
 */
async function copyFolderRecursive(source: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(source, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyFolderRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      await copyFile(srcPath, destPath);
    }
  }
}

/**
 * Recursively delete a folder and all its contents
 */
async function deleteFolderRecursive(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(path, entry.name);
    if (entry.isDirectory()) {
      await deleteFolderRecursive(fullPath);
    } else {
      await unlink(fullPath);
    }
  }

  await rmdir(path);
}

/**
 * Move an entire folder atomically if possible (same filesystem),
 * otherwise falls back to recursive copy + delete for cross-device moves.
 *
 * @param source - Source folder path to move
 * @param destRoot - Destination root directory (folder will be placed inside this)
 * @returns Result object with success status and new path
 */
export async function moveFolder(source: string, destRoot: string): Promise<MoveFolderResult> {
  try {
    // Validate source exists
    if (!existsSync(source)) {
      return { ok: false, error: `Source folder does not exist: ${source}` };
    }

    const sourceStat = await stat(source);
    if (!sourceStat.isDirectory()) {
      return { ok: false, error: `Source is not a directory: ${source}` };
    }

    const folderName = basename(source);
    const destination = join(destRoot, folderName);

    // Ensure destination root exists
    await mkdir(destRoot, { recursive: true });

    // Check if destination already exists
    if (existsSync(destination)) {
      // Append timestamp to avoid conflicts
      const timestampedName = `${folderName}_${Date.now()}`;
      const timestampedDest = join(destRoot, timestampedName);

      logger.warn(
        { source, destination, newDestination: timestampedDest },
        'Destination folder already exists, using timestamped name'
      );

      return moveFolder(source, join(destRoot, '..', timestampedName));
    }

    // Try atomic rename first (works if same filesystem)
    try {
      await rename(source, destination);
      logger.info({ source, destination }, 'Folder moved (atomic rename)');
      return { ok: true, newPath: destination };
    } catch (err) {
      // If EXDEV (cross-device link), fall back to recursive copy + delete
      if (isErrnoException(err) && err.code === 'EXDEV') {
        logger.info(
          { source, destination },
          'Cross-device move detected, using copy+delete'
        );

        await copyFolderRecursive(source, destination);
        await deleteFolderRecursive(source);

        logger.info({ source, destination }, 'Folder moved (copy+delete)');
        return { ok: true, newPath: destination };
      }

      // Some other error
      throw err;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error, source, destRoot }, 'Failed to move folder');
    return { ok: false, error: message };
  }
}

/**
 * Ensure a directory exists, creating it if necessary
 */
export async function ensureDir(dir: string): Promise<void> {
  try {
    await access(dir);
  } catch {
    await mkdir(dir, { recursive: true });
    logger.info({ dir }, 'Created directory');
  }
}

/**
 * Get all files in a folder (non-recursive)
 */
export async function getFolderFiles(folderPath: string): Promise<string[]> {
  try {
    const entries = await readdir(folderPath, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => join(folderPath, e.name));
  } catch {
    return [];
  }
}
