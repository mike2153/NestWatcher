import { promises as fsp } from 'fs';
import { basename, extname, join } from 'path';

const GRUNDNER_ARCHIVE_DIRNAME = 'archive';
const GRUNDNER_INCORRECT_DIRNAME = 'incorrect_files';

async function fileExists(path: string): Promise<boolean> {
  try {
    await fsp.stat(path);
    return true;
  } catch {
    return false;
  }
}

function formatArchiveTimestampDdMmHhMmSs(date = new Date()): string {
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const dd = pad2(date.getDate());
  const mm = pad2(date.getMonth() + 1);
  const hh = pad2(date.getHours());
  const min = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  return `${dd}.${mm}_${hh}.${min}.${ss}`;
}

export async function archiveGrundnerReplyFile(params: {
  grundnerFolder: string;
  sourcePath: string;
}): Promise<{ ok: true; archivedPath: string } | { ok: false; error: string }> {
  return moveGrundnerFile({
    grundnerFolder: params.grundnerFolder,
    sourcePath: params.sourcePath,
    targetDirName: GRUNDNER_ARCHIVE_DIRNAME
  });
}

export async function quarantineGrundnerReplyFile(params: {
  grundnerFolder: string;
  sourcePath: string;
}): Promise<{ ok: true; archivedPath: string } | { ok: false; error: string }> {
  return moveGrundnerFile({
    grundnerFolder: params.grundnerFolder,
    sourcePath: params.sourcePath,
    targetDirName: GRUNDNER_INCORRECT_DIRNAME
  });
}

export async function copyGrundnerIoFileToArchive(params: {
  grundnerFolder: string;
  sourcePath: string;
  suffix?: string;
}): Promise<{ ok: true; archivedPath: string } | { ok: false; error: string }> {
  const { grundnerFolder, sourcePath, suffix } = params;
  try {
    const targetDir = join(grundnerFolder, GRUNDNER_ARCHIVE_DIRNAME);
    await fsp.mkdir(targetDir, { recursive: true });

    const stamp = formatArchiveTimestampDdMmHhMmSs();
    const base = basename(sourcePath, extname(sourcePath));
    const ext = extname(sourcePath) || '';
    const extra = suffix ? `_${suffix}` : '';
    let candidate = join(targetDir, `${base}_${stamp}${extra}${ext}`);

    for (let i = 1; i <= 25 && (await fileExists(candidate)); i++) {
      candidate = join(targetDir, `${base}_${stamp}${extra}_${i}${ext}`);
    }

    await fsp.copyFile(sourcePath, candidate);
    return { ok: true, archivedPath: candidate };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function moveGrundnerFile(params: {
  grundnerFolder: string;
  sourcePath: string;
  targetDirName: string;
}): Promise<{ ok: true; archivedPath: string } | { ok: false; error: string }> {
  const { grundnerFolder, sourcePath, targetDirName } = params;
  try {
    const targetDir = join(grundnerFolder, targetDirName);
    await fsp.mkdir(targetDir, { recursive: true });

    const stamp = formatArchiveTimestampDdMmHhMmSs();
    const base = basename(sourcePath, extname(sourcePath));
    const ext = extname(sourcePath) || '';
    let candidate = join(targetDir, `${base}_${stamp}${ext}`);

    for (let i = 1; i <= 25 && (await fileExists(candidate)); i++) {
      candidate = join(targetDir, `${base}_${stamp}_${i}${ext}`);
    }

    try {
      await fsp.rename(sourcePath, candidate);
      return { ok: true, archivedPath: candidate };
    } catch {
      // Network shares sometimes fail rename across boundaries; fallback to copy+unlink.
      await fsp.copyFile(sourcePath, candidate);
      await fsp.unlink(sourcePath).catch(() => {});
      return { ok: true, archivedPath: candidate };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
