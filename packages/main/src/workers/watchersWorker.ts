﻿import chokidar, { type FSWatcher } from 'chokidar';
import { createHash } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { promises as fsp } from 'fs';
import net from 'net';
import { basename, join, normalize } from 'path';
import { parentPort } from 'worker_threads';
import type { Machine, MachineHealthCode } from '../../../shared/src';
import { loadConfig } from '../services/config';
import { logger } from '../logger';
import { appendJobEvent } from '../repo/jobEventsRepo';
import { listMachines } from '../repo/machinesRepo';
import { findJobByNcBase, findJobByNcBasePreferStatus, updateJobPallet, updateLifecycle } from '../repo/jobsRepo';
import { upsertCncStats } from '../repo/cncStatsRepo';
import { normalizeTelemetryPayload } from './telemetryParser';
import type { WatcherWorkerToMainMessage, MainToWatcherMessage } from './watchersMessages';

const { access, copyFile, readFile, readdir, rename, stat, unlink } = fsp;

const channel = parentPort;
const fsWatchers = new Set<FSWatcher>();

function postMessageToMain(message: WatcherWorkerToMainMessage) {
  if (!channel) {
    logger.debug({ messageType: message?.type }, 'watchersWorker: parentPort unavailable; skipping message');
    return;
  }
  try {
    channel.postMessage(message);
  } catch (err) {
    logger.warn({ err }, 'watchersWorker: failed to post message');
  }
}

function serializeError(error: unknown): { message: string; stack?: string | null } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack ?? null };
  }
  if (typeof error === 'string') {
    return { message: error };
  }
  try {
    return { message: JSON.stringify(error) };
  } catch {
    return { message: String(error) };
  }
}

function registerWatcher(name: string, label: string) {
  postMessageToMain({ type: 'registerWatcher', name, label });
}

function watcherReady(name: string, label: string) {
  postMessageToMain({ type: 'watcherReady', name, label });
}

function recordWatcherEvent(
  name: string,
  event: { label?: string; message: string; context?: Record<string, unknown> }
) {
  postMessageToMain({ type: 'watcherEvent', name, label: event.label, message: event.message, context: event.context });
}

function recordWatcherError(
  name: string,
  error: unknown,
  context?: Record<string, unknown> & { label?: string }
) {
  const { label, ...rest } = context ?? {};
  postMessageToMain({
    type: 'watcherError',
    name,
    label: label as string | undefined,
    error: serializeError(error),
    context: rest && Object.keys(rest).length ? rest : undefined
  });
}

function recordWorkerError(source: string, error: unknown, context?: Record<string, unknown>) {
  postMessageToMain({ type: 'workerError', source, error: serializeError(error), context });
}

function setMachineHealthIssue(params: {
  machineId: number | null;
  code: MachineHealthCode;
  message: string;
  severity?: 'info' | 'warning' | 'critical';
  context?: Record<string, unknown>;
}) {
  postMessageToMain({ type: 'machineHealthSet', payload: params });
}

function clearMachineHealthIssue(machineId: number | null, code: MachineHealthCode) {
  postMessageToMain({ type: 'machineHealthClear', payload: { machineId, code } });
}

function trackWatcher(watcher: FSWatcher) {
  fsWatchers.add(watcher);
  watcher.on('close', () => fsWatchers.delete(watcher));
}

let shuttingDown = false;

const autoPacHashes = new Map<string, string>();

const NESTPICK_UNSTACK_FILENAME = 'Report_FullNestpickUnstack.csv';

const AUTOPAC_WATCHER_NAME = 'watcher:autopac';
const AUTOPAC_WATCHER_LABEL = 'AutoPAC CSV Watcher';
const HEALTH_CODES: Record<'noParts' | 'nestpickShare' | 'copyFailure', MachineHealthCode> = {
  noParts: 'NO_PARTS_CSV',
  nestpickShare: 'NESTPICK_SHARE_UNREACHABLE',
  copyFailure: 'COPY_FAILURE'
};

function machineLabel(machine: Machine) {
  return machine.name ? `${machine.name} (#${machine.machineId})` : `Machine ${machine.machineId}`;
}

function nestpickProcessedWatcherName(machine: Machine) {
  return `watcher:nestpick-processed:${machine.machineId}`;
}

function nestpickProcessedWatcherLabel(machine: Machine) {
  return `Nestpick Processed (${machineLabel(machine)})`;
}

function nestpickUnstackWatcherName(machine: Machine) {
  return `watcher:nestpick-unstack:${machine.machineId}`;
}

function nestpickUnstackWatcherLabel(machine: Machine) {
  return `Nestpick Unstack (${machineLabel(machine)})`;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForStableFile(path: string, attempts = 5, intervalMs = 1000) {
  let lastSize = -1;
  let lastMtime = -1;
  for (let i = 0; i < attempts; i++) {
    const info = await stat(path);
    if (info.size === lastSize && info.mtimeMs === lastMtime) {
      return info;
    }
    lastSize = info.size;
    lastMtime = info.mtimeMs;
    await delay(intervalMs);
  }
  return stat(path);
}

async function hashFile(path: string) {
  const buffer = await readFile(path);
  return createHash('sha1').update(buffer).digest('hex');
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if ((ch === ',' || ch === ';') && !inQuotes) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map((cell) => cell.trim());
}

function parseCsvContent(content: string) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .map(splitCsvLine);
}

function extractBases(rows: string[][], fallback: string) {
  const bases = new Set<string>();
  for (const row of rows) {
    for (const raw of row) {
      const cell = raw.replace(/^"|"$/g, '').trim();
      if (!cell) continue;
      const match = cell.match(/^([A-Za-z0-9_.-]+)(?:\.nc)?$/);
      if (!match) continue;
      const candidate = match[1];
      if (candidate.length < 3) continue;
      bases.add(candidate);
      break;
    }
  }
  if (bases.size === 0 && fallback) {
    const fileBase = fallback.toLowerCase().split('_')[0]?.replace(/\.csv$/i, '').replace(/\.nc$/i, '');
    if (fileBase) bases.add(fileBase);
  }
  return Array.from(bases);
}

function sanitizeToken(input: string | null | undefined) {
  return (input ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function _inferMachineFromPath(path: string, machines: Machine[]): Machine | undefined {
  const normalizedPath = sanitizeToken(path);
  for (const machine of machines) {
    const candidates = [String(machine.machineId), machine.name];
    for (const candidate of candidates) {
      const token = sanitizeToken(candidate);
      if (token && normalizedPath.includes(token)) return machine;
    }
  }
  return undefined;
}

function deriveJobLeaf(folder: string | null, ncfile: string | null, key: string) {
  if (folder) {
    const parts = folder.split(/[\\/]/).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  if (ncfile) return ncfile.replace(/\.nc$/i, '');
  return key.replace(/\.nc$/i, '');
}

async function findMatchingCsv(root: string, base: string, depth = 0, maxDepth = 3): Promise<string | null> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const targetLower = base.toLowerCase();
    for (const entry of entries) {
      const entryPath = join(root, entry.name);
      if (entry.isFile()) {
        const nameLower = entry.name.toLowerCase();
        if (nameLower === `${targetLower}.csv` || (nameLower.startsWith(targetLower) && nameLower.endsWith('.csv'))) {
          return entryPath;
        }
      }
    }
    if (depth >= maxDepth) return null;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryPath = join(root, entry.name);
      const result = await findMatchingCsv(entryPath, base, depth + 1, maxDepth);
      if (result) return result;
    }
  } catch (err) {
    logger.debug({ err, root }, 'watcher: failed listing directory');
  }
  return null;
}

async function ensureDir(path: string) {
  if (existsSync(path)) return;
  mkdirSync(path, { recursive: true });
}

async function waitForNestpickSlot(path: string, timeoutMs = 5 * 60 * 1000) {
  const start = Date.now();
  while (await fileExists(path)) {
    if (Date.now() - start > timeoutMs) throw new Error('Nestpick.csv busy timeout');
    await delay(1000);
  }
}

function serializeCsv(rows: string[][]) {
  return rows
    .map((columns) =>
      columns
        .map((cell) => {
          if (cell.includes('"')) cell = cell.replace(/"/g, '""');
          if (cell.includes(',') || cell.includes('"')) return `"${cell}"`;
          return cell;
        })
        .join(',')
    )
    .join('\n');
}

function rewriteNestpickRows(rows: string[][], machineId: number) {
  if (rows.length === 0) return [];
  let destIndex = -1;
  let srcIndex = -1;
  const headerRow = rows[0];
  const isHeader = headerRow.some((cell) => /[A-Za-z]/.test(cell));

  if (isHeader) {
    destIndex = headerRow.findIndex((cell) => cell.toLowerCase() === 'destination');
    srcIndex = headerRow.findIndex((cell) => cell.toLowerCase() === 'sourcemachine');
    if (destIndex === -1) {
      headerRow.push('Destination');
      destIndex = headerRow.length - 1;
    } else {
      headerRow[destIndex] = 'Destination';
    }
    if (srcIndex === -1) {
      headerRow.push('SourceMachine');
      srcIndex = headerRow.length - 1;
    } else {
      headerRow[srcIndex] = 'SourceMachine';
    }
  } else {
    destIndex = headerRow.length;
    srcIndex = destIndex + 1;
    headerRow[destIndex] = '99';
    headerRow[srcIndex] = String(machineId);
  }

  const maxIndex = Math.max(destIndex, srcIndex);
  const dataStart = isHeader ? 1 : 0;
  for (let i = dataStart; i < rows.length; i++) {
    const row = rows[i];
    while (row.length <= maxIndex) row.push('');
    row[destIndex] = '99';
    row[srcIndex] = String(machineId);
  }
  return rows;
}

async function forwardToNestpick(base: string, job: Awaited<ReturnType<typeof findJobByNcBase>>, machine: Machine | undefined, machines: Machine[]) {
  if (!job) return;
  const resolvedMachine = machine ?? machines.find((m) => job.machineId != null && m.machineId === job.machineId);
  if (!resolvedMachine || !resolvedMachine.nestpickEnabled || !resolvedMachine.nestpickFolder) {
    logger.debug({ job: job.key }, 'watcher: nestpick forwarding skipped (no machine/folder)');
    return;
  }

  const apRoot = resolvedMachine.apJobfolder;
  if (!apRoot) {
    logger.warn({ machineId: resolvedMachine.machineId }, 'watcher: machine missing ap_jobfolder for nestpick forwarding');
    return;
  }

  const baseLower = base.toLowerCase();
  const leaf = deriveJobLeaf(job.folder, job.ncfile, job.key);
  const preferredDir = join(apRoot, leaf);
  let sourceCsv: string | null = null;
  if (await fileExists(preferredDir)) {
    sourceCsv = await findMatchingCsv(preferredDir, baseLower, 0, 2);
  }
  if (!sourceCsv) {
    sourceCsv = await findMatchingCsv(apRoot, baseLower, 0, 2);
  }
  if (!sourceCsv) {
    logger.warn({ job: job.key, apRoot, leaf }, 'watcher: staged CSV not found for nestpick forwarding');
    return;
  }

  try {
    await waitForStableFile(sourceCsv);
    const raw = await readFile(sourceCsv, 'utf8');
    const rows = parseCsvContent(raw);
    const rewritten = rewriteNestpickRows(rows, resolvedMachine.machineId);
    if (rewritten.length === 0) {
      logger.warn({ job: job.key, sourceCsv }, 'watcher: nestpick CSV empty after rewrite');
      return;
    }

    const outDir = resolvedMachine.nestpickFolder;
    await ensureDir(outDir);
    const outPath = join(outDir, 'Nestpick.csv');
    await waitForNestpickSlot(outPath);

    const tempPath = `${outPath}.tmp-${Date.now()}`;
    await fsp.writeFile(tempPath, `${serializeCsv(rewritten)}\n`, 'utf8');
    await rename(tempPath, outPath);

    await appendJobEvent(job.key, 'nestpick:forwarded', { source: sourceCsv, dest: outPath }, resolvedMachine.machineId);
    await updateLifecycle(job.key, 'FORWARDED_TO_NESTPICK', { machineId: resolvedMachine.machineId, source: 'nestpick-forward', payload: { source: sourceCsv, dest: outPath } });

    await unlink(sourceCsv).catch(() => {});
    clearMachineHealthIssue(resolvedMachine.machineId ?? null, HEALTH_CODES.copyFailure);
  } catch (err) {
    setMachineHealthIssue({
      machineId: resolvedMachine?.machineId ?? null,
      code: HEALTH_CODES.copyFailure,
      message: `Failed to forward Nestpick CSV for ${job?.key ?? base}`,
      severity: 'warning',
      context: {
        jobKey: job?.key,
        sourceCsv,
        destinationFolder: resolvedMachine?.nestpickFolder
      }
    });
    recordWorkerError('nestpick:forward', err, {
      jobKey: job.key,
      machineId: resolvedMachine?.machineId,
      sourceCsv,
      destinationFolder: resolvedMachine?.nestpickFolder
    });
    logger.error({ err, job: job.key }, 'watcher: nestpick forward failed');
  }
}

async function handleAutoPacCsv(path: string) {
  const fileName = basename(path);
  // Enforce naming: load_finish<machine>.csv, label_finish<machine>.csv, cnc_finish<machine>.csv
  const lower = fileName.toLowerCase();
  let to: 'LOAD_FINISH' | 'LABEL_FINISH' | 'CNC_FINISH' | null = null;
  let machineToken = '';
  if (lower.startsWith('load_finish')) { to = 'LOAD_FINISH'; machineToken = fileName.slice('load_finish'.length); }
  else if (lower.startsWith('label_finish')) { to = 'LABEL_FINISH'; machineToken = fileName.slice('label_finish'.length); }
  else if (lower.startsWith('cnc_finish')) { to = 'CNC_FINISH'; machineToken = fileName.slice('cnc_finish'.length); }
  if (!to) return;
  machineToken = machineToken.replace(/^[-_\s]+/, '').replace(/\.csv$/i, '').trim();
  if (!machineToken) return; // machine must be specified

  try {
    await waitForStableFile(path);
    const hash = await hashFile(path);
    if (autoPacHashes.get(path) === hash) return;
    autoPacHashes.set(path, hash);
    if (autoPacHashes.size > 200) {
      const firstKey = autoPacHashes.keys().next().value;
      if (firstKey) autoPacHashes.delete(firstKey);
    }

    const raw = await readFile(path, 'utf8');
    const rows = parseCsvContent(raw);
    // Enforce machine token appears in CSV and matches filename
    const wantedToken = sanitizeToken(machineToken);
    const csvHasMachine = rows.some((row) =>
      row.some((cell) => {
        const token = sanitizeToken(cell);
        return token === wantedToken;
      })
    );
    if (!csvHasMachine) {
      setMachineHealthIssue({
        machineId: null,
        code: HEALTH_CODES.copyFailure,
        message: `AutoPAC machine mismatch: file=${fileName} expects '${machineToken}', CSV does not contain matching machine`,
        severity: 'warning',
        context: { file: path, expected: machineToken }
      });
      recordWatcherError(AUTOPAC_WATCHER_NAME, new Error('AutoPAC machine mismatch'), {
        path,
        expected: machineToken,
        label: AUTOPAC_WATCHER_LABEL
      });
      return; // leave file alone
    }
    // Strict: first column is NC, only accept base or base.nc
    const bases = (() => {
      const set = new Set<string>();
      for (const row of rows) {
        if (!row.length) continue;
        const cell = row[0]?.trim() ?? '';
        if (!cell) continue;
        const m = cell.match(/^([A-Za-z0-9_.-]+)(?:\.nc)?$/i);
        if (m && m[1]) set.add(m[1]);
      }
      return Array.from(set);
    })();
    if (!bases.length) {
      logger.warn({ file: path }, 'watcher: autopac file had no identifiable bases');
      setMachineHealthIssue({
        machineId: null,
        code: HEALTH_CODES.noParts,
        message: `No parts found in AutoPAC CSV ${basename(path)}`,
        severity: 'warning',
        context: { file: path }
      });
      return;
    }

    const machines = await listMachines();
    // Resolve machine strictly from filename token (matches by name or numeric id)
    const wanted = sanitizeToken(machineToken);
    const machine = machines.find((m) => sanitizeToken(m.name) === wanted || sanitizeToken(String(m.machineId)) === wanted);
    if (!machine) {
      logger.warn({ file: path, machineToken }, 'watcher: autopac file specifies unknown machine');
      return;
    }
    let processedAny = false;

    for (const base of bases) {
      const job = await findJobByNcBase(base);
      if (!job) {
        logger.warn({ base, file: path }, 'watcher: job not found for AutoPAC CSV');
        continue;
      }
      const machineForJob = machine;
      const machineId = machineForJob.machineId;

      const lifecycle = await updateLifecycle(job.key, to, {
        machineId,
        source: 'autopac',
        payload: { file: path, base }
      });
      await appendJobEvent(job.key, `autopac:${to.toLowerCase()}`, { file: path, base }, machineId);

      if (lifecycle.ok && to === 'CNC_FINISH') {
        await forwardToNestpick(base, job, machineForJob, machines);
      }
      if (lifecycle.ok) {
        processedAny = true;
        const healthMachine = machineId ?? null;
        clearMachineHealthIssue(healthMachine, HEALTH_CODES.noParts);
      }
    }
    recordWatcherEvent(AUTOPAC_WATCHER_NAME, {
      label: AUTOPAC_WATCHER_LABEL,
      message: `Processed ${basename(path)}`
    });
    if (processedAny) {
      clearMachineHealthIssue(null, HEALTH_CODES.noParts);
      // Delete the source CSV after successful processing
      try { await unlink(path); } catch (e) { void e; }
    }
  } catch (err) {
    recordWatcherError(AUTOPAC_WATCHER_NAME, err, { path, label: AUTOPAC_WATCHER_LABEL });
    logger.error({ err, file: path }, 'watcher: AutoPAC processing failed');
  }
}

async function moveToArchive(source: string, archiveDir: string) {
  await ensureDir(archiveDir);
  const base = basename(source);
  let target = join(archiveDir, base);
  if (await fileExists(target)) {
    target = join(archiveDir, `${Date.now()}-${base}`);
  }
  try {
    await rename(source, target);
  } catch (err) {
    await copyFile(source, target);
    await unlink(source).catch((err) => { void err; });
    logger.debug({ err }, 'watcher: archive rename fallback to copy');
  }
  return target;
}

async function handleNestpickProcessed(machine: Machine, path: string) {
  try {
    await waitForStableFile(path);
    const raw = await readFile(path, 'utf8');
    const rows = parseCsvContent(raw);
    const bases = extractBases(rows, basename(path));
    let processedAny = false;
    for (const base of bases) {
      const job = await findJobByNcBase(base);
      if (!job) {
        logger.warn({ base, file: path }, 'watcher: nestpick processed job not found');
        continue;
      }
      const lifecycle = await updateLifecycle(job.key, 'NESTPICK_COMPLETE', { machineId: machine.machineId, source: 'nestpick-processed', payload: { file: path } });
      if (lifecycle.ok) {
        await appendJobEvent(job.key, 'nestpick:complete', { file: path }, machine.machineId);
        processedAny = true;
      }
    }
    await moveToArchive(path, join(machine.nestpickFolder, 'archive'));
    recordWatcherEvent(nestpickProcessedWatcherName(machine), {
      label: nestpickProcessedWatcherLabel(machine),
      message: `Processed ${basename(path)}`
    });
    if (processedAny) {
      clearMachineHealthIssue(machine.machineId ?? null, HEALTH_CODES.copyFailure);
    }
  } catch (err) {
    setMachineHealthIssue({
      machineId: machine.machineId ?? null,
      code: HEALTH_CODES.copyFailure,
      message: `Failed to archive Nestpick processed file ${basename(path)}`,
      severity: 'warning',
      context: { file: path, machineId: machine.machineId }
    });
    recordWatcherError(nestpickProcessedWatcherName(machine), err, {
      path,
      machineId: machine.machineId,
      label: nestpickProcessedWatcherLabel(machine)
    });
    logger.error({ err, file: path }, 'watcher: nestpick processed handling failed');
  }
}

async function handleNestpickUnstack(machine: Machine, path: string) {
  try {
    await waitForStableFile(path);
    logger.info({ file: path, machineId: machine.machineId }, 'watcher: unstack processing started');
    const raw = await readFile(path, 'utf8');
    const rows = parseCsvContent(raw);
    if (!rows.length) {
      logger.warn({ file: path }, 'watcher: unstack csv empty');
      await moveToArchive(path, join(machine.nestpickFolder, 'archive'));
      return;
    }

    const jobIdx = 0;
    const sourcePlaceIdx = 1;
    let processedAny = false;
    const unmatched: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.length <= jobIdx || row.length <= sourcePlaceIdx) {
        logger.warn({ file: path, row: i + 1 }, 'watcher: unstack row missing expected columns');
        continue;
      }

      const rawJob = (row[jobIdx] ?? '').trim().replace(/^"|"$/g, '');
      if (!rawJob) continue;

      const base = rawJob;
      const job = await findJobByNcBasePreferStatus(base, ['FORWARDED_TO_NESTPICK']);
      if (!job) {
        logger.warn({ base }, 'watcher: unstack no matching job in FORWARDED_TO_NESTPICK');
        unmatched.push(base);
        continue; // alert later; do not update any job
      }

      const sourcePlaceValue = (row[sourcePlaceIdx] ?? '').trim().replace(/^"|"$/g, '') || null;
      logger.debug({ jobKey: job.key, base, sourcePlace: sourcePlaceValue, row: i + 1 }, 'watcher: unstack updating pallet');
      const ok = await updateJobPallet(job.key, sourcePlaceValue);
      if (ok) {
        await appendJobEvent(
          job.key,
          'nestpick:unstack',
          { sourcePlace: sourcePlaceValue, pallet: sourcePlaceValue, file: path },
          null
        );
        logger.info({ jobKey: job.key, base, sourcePlace: sourcePlaceValue, row: i + 1 }, 'watcher: unstack row processed');
        // Progress lifecycle to NESTPICK_COMPLETE when unstack is recorded
        const lifecycle = await updateLifecycle(job.key, 'NESTPICK_COMPLETE', {
          machineId: null,
          source: 'nestpick-unstack',
          payload: { file: path, sourcePlace: sourcePlaceValue }
        });
        if (!lifecycle.ok) {
          const previous = 'previousStatus' in lifecycle ? lifecycle.previousStatus : undefined;
          logger.warn({ jobKey: job.key, base, previousStatus: previous }, 'watcher: unstack lifecycle not progressed');
        }
        processedAny = true;
      } else {
        logger.warn({ jobKey: job.key, base, sourcePlace: sourcePlaceValue, row: i + 1 }, 'watcher: unstack pallet update failed');
      }
    }
    const archiveDir = join(machine.nestpickFolder, 'archive');
    await moveToArchive(path, archiveDir);
    logger.info({ file: path, archiveDir, processedAny }, 'watcher: unstack archived');

    if (unmatched.length) {
      postMessageToMain({
        type: 'userAlert',
        title: 'Nestpick Unstack: No Matching Job',
        message: `No job in FORWARDED_TO_NESTPICK for: ${unmatched.join(', ')}`
      });
    }
    recordWatcherEvent(nestpickUnstackWatcherName(machine), {
      label: nestpickUnstackWatcherLabel(machine),
      message: `Processed ${basename(path)}`
    });
    if (processedAny) {
      clearMachineHealthIssue(machine.machineId ?? null, HEALTH_CODES.copyFailure);
    }
  } catch (err) {
    setMachineHealthIssue({
      machineId: machine.machineId ?? null,
      code: HEALTH_CODES.copyFailure,
      message: `Failed to process Nestpick unstack report ${basename(path)}`,
      severity: 'warning',
      context: { file: path, machineId: machine.machineId }
    });
    try {
      await moveToArchive(path, join(machine.nestpickFolder, 'archive'));
    } catch (e) { void e; }
    recordWatcherError(nestpickUnstackWatcherName(machine), err, {
      path,
      machineId: machine.machineId,
      label: nestpickUnstackWatcherLabel(machine)
    });
    logger.error({ err, file: path }, 'watcher: nestpick unstack handling failed');
  }
}

function stableProcess(
  fn: (path: string) => Promise<void>,
  delayMs = 1000,
  options?: { watcherName?: string; watcherLabel?: string }
) {
  const pending = new Map<string, NodeJS.Timeout>();
  return (path: string) => {
    const normalizedPath = normalize(path);
    const watcher = options?.watcherName ?? 'watcher';
    const label = options?.watcherLabel ?? watcher;
    logger.info({ path: normalizedPath, watcher, label }, 'watcher: scan queued');
    if (pending.has(normalizedPath)) clearTimeout(pending.get(normalizedPath)!);
    pending.set(
      normalizedPath,
      setTimeout(() => {
        pending.delete(normalizedPath);
        fn(normalizedPath)
          .then(() => {
            logger.info({ path: normalizedPath, watcher, label }, 'watcher: scan complete');
          })
          .catch((err) => {
            if (options?.watcherName) {
              recordWatcherError(options.watcherName, err, {
                path: normalizedPath,
                label: options.watcherLabel ?? options.watcherName
              });
            } else {
              recordWorkerError('watcher', err, { path: normalizedPath });
            }
            logger.error({ err, path: normalizedPath, watcher, label }, 'watcher error');
          });
      }, delayMs)
    );
  };
}

class TelemetryClient {
  private socket: net.Socket | null = null;
  private buffer = '';
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stopped = false;
  private lastSignature: string | null = null;
  private readonly watcherName: string;
  private readonly watcherLabel: string;

  constructor(private readonly machine: Machine) {
    this.watcherName = `watcher:telemetry:${machine.machineId}`;
    this.watcherLabel = `Telemetry (${machineLabel(machine)})`;
    registerWatcher(this.watcherName, this.watcherLabel);
  }

  start() {
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.clearReconnect();
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }

  private clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(reason: string) {
    if (this.stopped) return;
    this.clearReconnect();
    const delay = Math.min(30_000, Math.pow(2, Math.min(this.attempt, 5)) * 1000);
    recordWatcherEvent(this.watcherName, {
      label: this.watcherLabel,
      message: `${reason}; retrying in ${Math.round(delay / 1000)}s`,
      context: { machineId: this.machine.machineId }
    });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    if (typeof this.reconnectTimer.unref === 'function') {
      this.reconnectTimer.unref();
    }
  }

  private connect() {
    if (this.stopped) return;
    const host = this.machine.pcIp?.trim();
    const port = this.machine.pcPort ?? 0;
    if (!host || !port) {
      recordWatcherEvent(this.watcherName, {
        label: this.watcherLabel,
        message: 'Telemetry disabled (missing PC IP/port)',
        context: { machineId: this.machine.machineId }
      });
      return;
    }

    this.attempt += 1;
    this.clearReconnect();

    this.socket = net.createConnection({ host, port }, () => {
      this.attempt = 0;
      this.buffer = '';
      this.lastSignature = null;
      watcherReady(this.watcherName, this.watcherLabel);
      recordWatcherEvent(this.watcherName, {
        label: this.watcherLabel,
        message: 'Connected to telemetry stream',
        context: { host, port, machineId: this.machine.machineId }
      });
    });

    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk) => this.handleData(chunk));
    this.socket.on('error', (err) => {
      recordWatcherError(this.watcherName, err, {
        host,
        port,
        machineId: this.machine.machineId,
        label: this.watcherLabel
      });
    });
    this.socket.on('close', () => {
      if (this.stopped) return;
      this.socket?.removeAllListeners();
      this.socket = null;
      this.scheduleReconnect('Telemetry connection closed');
    });
  }

  private handleData(chunk: string | Buffer) {
    if (this.stopped) return;
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const raw = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (raw.length > 0) {
        void this.processLine(raw);
      }
      index = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > 64_000) {
      this.buffer = '';
    }
  }

  private async processLine(line: string) {
    try {
      const payload = JSON.parse(line);
      const normalized = normalizeTelemetryPayload(this.machine, payload);
      const signature = JSON.stringify(normalized);
      if (signature === this.lastSignature) {
        return;
      }
      this.lastSignature = signature;
      await upsertCncStats(normalized);
      const statusSummary = normalized.status ? `status=${normalized.status}` : 'status updated';
      recordWatcherEvent(this.watcherName, {
        label: this.watcherLabel,
        message: `Telemetry update (${statusSummary})`,
        context: { machineId: this.machine.machineId }
      });
    } catch (err) {
      recordWatcherError(this.watcherName, err, {
        machineId: this.machine.machineId,
        label: this.watcherLabel,
        sample: line.slice(0, 500)
      });
    }
  }
}

const telemetryClients: TelemetryClient[] = [];

async function startTelemetryClients() {
  try {
    const machines = await listMachines();
    for (const machine of machines) {
      const host = machine.pcIp?.trim();
      const port = machine.pcPort ?? 0;
      if (!host || !port) continue;
      const client = new TelemetryClient(machine);
      telemetryClients.push(client);
      client.start();
    }
    if (telemetryClients.length === 0) {
      logger.debug('watchersWorker: no telemetry endpoints configured');
    }
  } catch (err) {
    recordWorkerError('telemetry:init', err);
    logger.error({ err }, 'watchersWorker: failed to initialize telemetry clients');
  }
}

async function shutdown(reason?: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ reason }, 'watchersWorker: shutting down background services');
  const watchers = Array.from(fsWatchers);
  for (const watcher of watchers) {
    try {
      await watcher.close();
    } catch (err) {
      logger.warn({ err }, 'watchersWorker: failed to close file watcher');
    } finally {
      fsWatchers.delete(watcher);
    }
  }
  for (const client of telemetryClients) {
    try {
      client.stop();
    } catch (err) {
      logger.warn({ err }, 'watchersWorker: failed to stop telemetry client');
    }
  }
  telemetryClients.length = 0;
}

function setupAutoPacWatcher(dir: string) {
  registerWatcher(AUTOPAC_WATCHER_NAME, AUTOPAC_WATCHER_LABEL);
  const onAdd = stableProcess(handleAutoPacCsv, 250, {
    watcherName: AUTOPAC_WATCHER_NAME,
    watcherLabel: AUTOPAC_WATCHER_LABEL
  });
  const watcher = chokidar.watch(dir, {
    ignoreInitial: true,
    depth: 3,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
  });
  trackWatcher(watcher);
  watcher.on('add', onAdd);
  watcher.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException)?.code;
    setMachineHealthIssue({
      machineId: null,
      code: HEALTH_CODES.copyFailure,
      message: `AutoPAC watcher error${code ? ` (${code})` : ''}`,
      severity: 'critical',
      context: { dir, code }
    });
    recordWatcherError(AUTOPAC_WATCHER_NAME, err, { dir, label: AUTOPAC_WATCHER_LABEL });
    logger.error({ err, dir }, 'watcher: AutoPAC error');
  });
  watcher.on('ready', () => {
    watcherReady(AUTOPAC_WATCHER_NAME, AUTOPAC_WATCHER_LABEL);
    clearMachineHealthIssue(null, HEALTH_CODES.copyFailure);
  });
  logger.info({ dir }, 'AutoPAC watcher started');
}

async function setupNestpickWatchers() {
  try {
    const machines = await listMachines();
    for (const machine of machines) {
      if (!machine.nestpickEnabled || !machine.nestpickFolder) continue;
      const folder = machine.nestpickFolder;
      const processedDir = join(folder, 'processed');
      const processedWatcherName = nestpickProcessedWatcherName(machine);
      const processedWatcherLabel = nestpickProcessedWatcherLabel(machine);
      registerWatcher(processedWatcherName, processedWatcherLabel);
      const processedWatcher = chokidar.watch(processedDir, {
        ignoreInitial: true,
        depth: 1,
        awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 250 }
      });
      trackWatcher(processedWatcher);
      const handleProcessed = stableProcess(
        (path) => handleNestpickProcessed(machine, path),
        500,
        { watcherName: processedWatcherName, watcherLabel: processedWatcherLabel }
      );
      processedWatcher.on('add', handleProcessed);
      processedWatcher.on('error', (err) => {
        const code = (err as NodeJS.ErrnoException)?.code;
        setMachineHealthIssue({
          machineId: machine.machineId ?? null,
          code: HEALTH_CODES.nestpickShare,
          message: `Processed folder unavailable${code ? ` (${code})` : ''}`,
          severity: 'critical',
          context: { folder: processedDir, machineId: machine.machineId, code }
        });
        recordWatcherError(processedWatcherName, err, {
          folder: processedDir,
          machineId: machine.machineId,
          label: processedWatcherLabel
        });
        logger.error({ err, folder: processedDir }, 'watcher: nestpick processed error');
      });
      processedWatcher.on('ready', () => {
        watcherReady(processedWatcherName, processedWatcherLabel);
        clearMachineHealthIssue(machine.machineId ?? null, HEALTH_CODES.nestpickShare);
      });

      const reportPath = join(folder, NESTPICK_UNSTACK_FILENAME);
      const unstackWatcherName = nestpickUnstackWatcherName(machine);
      const unstackWatcherLabel = nestpickUnstackWatcherLabel(machine);
      registerWatcher(unstackWatcherName, unstackWatcherLabel);
      const reportWatcher = chokidar.watch(reportPath, {
        ignoreInitial: true,
        depth: 0,
        awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 250 }
      });
      trackWatcher(reportWatcher);
      const handleReport = stableProcess(
        (path) => handleNestpickUnstack(machine, path),
        500,
        { watcherName: unstackWatcherName, watcherLabel: unstackWatcherLabel }
      );
      reportWatcher.on('add', handleReport);
      reportWatcher.on('change', handleReport);
      reportWatcher.on('error', (err) => {
        const code = (err as NodeJS.ErrnoException)?.code;
        setMachineHealthIssue({
          machineId: machine.machineId ?? null,
          code: HEALTH_CODES.nestpickShare,
          message: `Nestpick unstack share unreachable${code ? ` (${code})` : ''}`,
          severity: 'critical',
          context: { file: reportPath, machineId: machine.machineId, code }
        });
        recordWatcherError(unstackWatcherName, err, {
          folder: reportPath,
          machineId: machine.machineId,
          label: unstackWatcherLabel
        });
        logger.error({ err, folder: reportPath }, 'watcher: nestpick unstack error');
      });
      reportWatcher.on('ready', () => {
        watcherReady(unstackWatcherName, unstackWatcherLabel);
        clearMachineHealthIssue(machine.machineId ?? null, HEALTH_CODES.nestpickShare);
      });

      logger.info({ folder }, 'Nestpick watcher started');
    }
  } catch (err) {
    logger.error({ err }, 'watcher: failed to initialize nestpick watchers');
  }
}

function initWatchers() {
  const cfg = loadConfig();
  if (cfg.paths.autoPacCsvDir) {
    setupAutoPacWatcher(cfg.paths.autoPacCsvDir);
  }
  void setupNestpickWatchers();
  void startTelemetryClients();
}

try {
  initWatchers();
} catch (err) {
  recordWorkerError('watchers:init', err);
  logger.error({ err }, 'watchersWorker: failed to initialize watchers');
}

if (channel) {
  channel.on('message', (message: MainToWatcherMessage) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'shutdown') {
      void shutdown(message.reason).finally(() => process.exit(0));
    }
  });
}

process.on('SIGINT', () => {
  void shutdown('SIGINT').finally(() => process.exit(0));
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM').finally(() => process.exit(0));
});

process.on('uncaughtException', (err) => {
  recordWorkerError('watchers-worker', err);
  logger.error({ err }, 'watchersWorker: uncaught exception');
});

process.on('unhandledRejection', (reason) => {
  recordWorkerError('watchers-worker', reason);
  logger.error({ reason }, 'watchersWorker: unhandled rejection');
});
