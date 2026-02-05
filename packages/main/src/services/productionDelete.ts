import { existsSync, promises as fsp } from 'fs';
import { join, normalize } from 'path';
import { loadConfig } from './config';
import { logger } from '../logger';
import { pushAppMessage } from './messages';
import { archiveGrundnerReplyFile, copyGrundnerIoFileToArchive, quarantineGrundnerReplyFile } from './grundnerArchive';

type DeleteItem = { ncfile: string | null; machineId: number | null };

function toJobNo(base: string | null): string {
  const name = (base ?? '').trim();
  if (!name) return '';
  // Defensive: if we somehow get a path, keep only the filename.
  const normalized = name.replace(/\\/g, '/');
  const justName = normalized.includes('/') ? normalized.slice(normalized.lastIndexOf('/') + 1) : normalized;
  // Spec: job name without .nc
  return justName.replace(/\.nc$/i, '');
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number, intervalMs = 300): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function waitForStableFile(path: string, attempts = 4, intervalMs = 300): Promise<void> {
  let lastSize = -1;
  for (let i = 0; i < attempts; i++) {
    try {
      const stat = await fsp.stat(path);
      if (stat.size === lastSize) return;
      lastSize = stat.size;
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function normalizeGrundnerReply(content: string): string {
  // New Grundner gateway replies with get_production.erl containing the same
  // content that we sent. Normalize line endings + trim trailing whitespace
  // so minor CRLF differences don't break confirmation.
  return content.replace(/\r\n/g, '\n').trim();
}

export async function placeProductionDeleteCsv(
  items: DeleteItem[],
  timeoutMs = 10_000
): Promise<{ confirmed: boolean; folder: string; checked?: boolean; deleted?: boolean; message?: string }>{
  if (!items.length) return { confirmed: false, folder: '', checked: false, deleted: false, message: 'No items to delete' };
  const cfg = loadConfig();
  const archiveIoFiles = Boolean(cfg.integrations?.archiveIoFiles);
  const effectiveTimeoutMs = cfg.test?.disableErlTimeouts ? Number.POSITIVE_INFINITY : timeoutMs;
  const folderRaw = cfg.paths.grundnerFolderPath?.trim() ?? '';
  if (!folderRaw) return { confirmed: false, folder: '', checked: false, deleted: false, message: 'Grundner folder not configured' };
  const folder = normalize(folderRaw);
  if (!existsSync(folder)) return { confirmed: false, folder, checked: false, deleted: false, message: 'Grundner folder does not exist' };

  // Per latest spec: write get_production.tmp then rename to get_production.csv
  const reqPath = join(folder, 'get_production.csv');
  const tmpPath = join(folder, 'get_production.tmp');
  // New gateway answer file
  const ansPath = join(folder, 'get_production.erl');

  // If a stale reply exists, quarantine it so we don't lose traceability.
  // We need a clean slot so we don't accidentally accept an old confirmation.
  if (existsSync(ansPath)) {
    const res = await quarantineGrundnerReplyFile({ grundnerFolder: folder, sourcePath: ansPath });
    if (!res.ok) {
      logger.warn({ folder, error: res.error }, 'productionDelete: failed to quarantine stale get_production.erl');
    }
  }

  // Busy guard
  if (existsSync(reqPath) || existsSync(tmpPath)) {
    await new Promise((r) => setTimeout(r, 5000));
    if (existsSync(reqPath) || existsSync(tmpPath)) {
      return { confirmed: false, folder, checked: false, deleted: false, message: 'get_production.csv is busy; retry shortly' };
    }
  }

  // CSV structure (semicolon separated):
  // 1) Job name without .nc
  // 2) Machine number
  const lines =
    items
      .map((it) => {
        const jobNo = toJobNo(it.ncfile);
        const machine = Number.isFinite(it.machineId as number) ? String(it.machineId) : '0';
        return `${jobNo};${machine};`;
      })
      .join('\r\n') +
    '\r\n';
  await fsp.writeFile(tmpPath, lines, 'utf8');
  await fsp.rename(tmpPath, reqPath).catch(async () => { await fsp.writeFile(reqPath, lines, 'utf8'); });

  // Optional: archive a copy of the outbound request without breaking the handshake.
  if (archiveIoFiles && existsSync(reqPath)) {
    const copied = await copyGrundnerIoFileToArchive({ grundnerFolder: folder, sourcePath: reqPath, suffix: 'sent' });
    if (!copied.ok) {
      logger.warn({ folder, error: copied.error }, 'productionDelete: failed to copy get_production.csv into archive');
    }
  }

  // Wait for the answer file
  const ok = await waitFor(async () => existsSync(ansPath), effectiveTimeoutMs);
  if (!ok) {
    logger.warn({ folder }, 'productionDelete: timed out waiting for get_production.erl');
    return { confirmed: false, folder, checked: false, deleted: false, message: 'Timed out waiting for delete confirmation (get_production.erl)' };
  }

  await waitForStableFile(ansPath);
  const raw = await fsp.readFile(ansPath, 'utf8');
  const confirmed = normalizeGrundnerReply(raw) === normalizeGrundnerReply(lines);

  // Reply disposition policy:
  // - incorrect replies always go to incorrect_files
  // - correct replies are archived only when Archive IO is enabled
  if (!confirmed) {
    const moveRes = await quarantineGrundnerReplyFile({ grundnerFolder: folder, sourcePath: ansPath });
    if (moveRes.ok) {
      pushAppMessage(
        'grundner.file.quarantined',
        {
          fileName: 'get_production.erl',
          folder,
          reason: 'Reply did not match request.'
        },
        { source: 'grundner' }
      );
      return {
        confirmed,
        folder,
        checked: true,
        deleted: true,
        message: 'Delete confirmation did not match request'
      };
    }

    logger.warn({ folder, error: moveRes.error }, 'productionDelete: failed to quarantine get_production.erl');
    return {
      confirmed,
      folder,
      checked: true,
      deleted: false,
      message: 'Delete confirmation did not match request'
    };
  }

  if (archiveIoFiles) {
    const moveRes = await archiveGrundnerReplyFile({ grundnerFolder: folder, sourcePath: ansPath });
    if (moveRes.ok) {
      pushAppMessage(
        'grundner.erl.archived',
        {
          fileName: 'get_production.erl',
          archivedAs: moveRes.archivedPath,
          note: 'Reply matched request.'
        },
        { source: 'grundner' }
      );
      return { confirmed, folder, checked: true, deleted: true };
    }
    logger.warn({ folder, error: moveRes.error }, 'productionDelete: failed to archive get_production.erl');
    return { confirmed, folder, checked: true, deleted: false };
  }

  // Archive IO is disabled: delete successful reply.
  try {
    await fsp.unlink(ansPath);
    logger.info({ folder }, 'productionDelete: deleted get_production.erl after successful processing');
    return { confirmed, folder, checked: true, deleted: true };
  } catch (err) {
    logger.warn({ folder, err }, 'productionDelete: failed to delete get_production.erl');
    return { confirmed, folder, checked: true, deleted: false };
  }
}
