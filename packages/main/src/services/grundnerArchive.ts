import { promises as fsp } from 'fs';
import { basename, extname, join } from 'path';

const GRUNDNER_ARCHIVE_DIRNAME = 'archieve';

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
  const { grundnerFolder, sourcePath } = params;
  try {
    const archiveDir = join(grundnerFolder, GRUNDNER_ARCHIVE_DIRNAME);
    await fsp.mkdir(archiveDir, { recursive: true });

    const stamp = formatArchiveTimestampDdMmHhMmSs();
    const base = basename(sourcePath, extname(sourcePath));
    const ext = extname(sourcePath) || '';
    let candidate = join(archiveDir, `${base}_${stamp}${ext}`);

    for (let i = 1; i <= 25 && (await fileExists(candidate)); i++) {
      candidate = join(archiveDir, `${base}_${stamp}_${i}${ext}`);
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
