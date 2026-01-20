import { existsSync, promises as fsp } from 'fs';
import { basename, extname, join, relative } from 'path';
import { app } from 'electron';
import { inArray } from 'drizzle-orm';
import {
  ValidationJsonSchema,
  type ValidationJson,
  type ValidationFileEntry,
  type ValidationResult
} from '../../../shared/src';
import { logger } from '../logger';
import { loadConfig } from './config';
import { upsertNcStats } from '../repo/ncStatsRepo';
import { pushAppMessage } from './messages';
import { withDb } from './db';
import { jobs } from '../db/schema';

const SCAN_INTERVAL_MS = 5000;
let interval: NodeJS.Timeout | null = null;
let processing = false;

export function getValidationJsonPath(): string {
  const userDataPath = app.getPath('userData');
  return join(userDataPath, 'validation.json');
}

function buildJobKeyFromMesEntry(root: string, folderPath: string, filename: string): string | null {
  if (!root) return null;
  const relFolder = relative(root, folderPath).replace(/\\/g, '/');
  if (relFolder.startsWith('..')) return null; // outside processedJobsRoot
  const baseNoExt = basename(filename, extname(filename)) || filename;
  const key = (relFolder ? `${relFolder}/${baseNoExt}` : baseNoExt).replace(/^\/+/, '').slice(0, 100);
  return key;
}

async function parseJson(filePath: string): Promise<ValidationJson | null> {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = ValidationJsonSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      const reason = parsed.error.message;
      pushAppMessage('mes.parseError', { reason }, { source: 'mes-validation' });
      logger.warn({ reason }, 'MES JSON parse failed');
      return null;
    }
    return parsed.data;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    pushAppMessage('mes.parseError', { reason }, { source: 'mes-validation' });
    logger.warn({ error }, 'MES JSON parse threw');
    return null;
  }
}

function sumCuttingDistance(files: ValidationFileEntry[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const entry of files) {
    const total = entry.toolUsage.reduce((acc, t) => acc + (t.cuttingDistanceMeters || 0), 0);
    totals.set(entry.filename, total);
  }
  return totals;
}

function collectFailures(entries: ValidationFileEntry[]): { failed: number; sampleFolder?: string } {
  const failing = entries.filter((f) => f.validation.status !== 'pass');
  return { failed: failing.length, sampleFolder: failing[0]?.folderName };
}

async function loadExistingJobKeys(keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const rows = await withDb((db) =>
    db.select({ key: jobs.key }).from(jobs).where(inArray(jobs.key, keys)).limit(keys.length)
  );
  return new Set(rows.map((r) => r.key));
}

export async function processValidationJson(): Promise<void> {
  if (processing) return;
  const jsonPath = getValidationJsonPath();
  if (!existsSync(jsonPath)) {
    logger.debug({ jsonPath }, 'MES scan: no validation.json found');
    return;
  }
  processing = true;
  try {
    const cfg = loadConfig();
    const root = cfg.paths.processedJobsRoot?.trim?.() ?? '';
    logger.info({ jsonPath, processedJobsRoot: root }, `MES scan: found validation.json at ${jsonPath}; processedJobsRoot=${root || '(not set)'}`);
    if (!root || !existsSync(root)) {
      logger.warn({ root, jsonPath }, 'MES JSON found but processedJobsRoot is missing/unreadable');
    }

    const parsed = await parseJson(jsonPath);
    if (!parsed) return;

    const files = parsed.files ?? [];
    logger.info({ fileCount: files.length, processedJobsRoot: root, jsonPath }, `MES scan: parsed validation.json (${files.length} files)`);
    const jobKeyMap = new Map<string, ValidationFileEntry>();
    const invalidPathKeys: string[] = [];

    for (const entry of files) {
      const jobKey = buildJobKeyFromMesEntry(root, entry.folderPath, entry.filename);
      if (!jobKey) {
        invalidPathKeys.push(`${entry.folderName}/${entry.filename}`);
        continue;
      }
      jobKeyMap.set(jobKey, entry);
    }

    const jobKeys = Array.from(jobKeyMap.keys());
    const existing = await loadExistingJobKeys(jobKeys);

    let updated = 0;
    let missing = 0;

    const cuttingDistanceByFile = sumCuttingDistance(files);

    for (const [jobKey, entry] of jobKeyMap.entries()) {
      if (!existing.has(jobKey)) {
        missing += 1;
        continue;
      }
      try {
        const estimatedRuntimeSeconds = Number.isFinite(entry.ncEstRuntime) ? entry.ncEstRuntime : null;

        await upsertNcStats({
          jobKey,
          ncEstRuntime: estimatedRuntimeSeconds != null ? Math.round(estimatedRuntimeSeconds) : null,
          yieldPercentage: entry.yieldPercentage,
          wasteOffcutM2: entry.wasteOffcutM2,
          wasteOffcutDustM3: entry.wasteOffcutDustM3,
          totalToolDustM3: entry.TotalToolDustM3,
          totalDrillDustM3: entry.TotalDrillDustM3,
          sheetTotalDustM3: entry.SheetTotalDustM3,
          cuttingDistanceMeters: cuttingDistanceByFile.get(entry.filename) ?? null,
          usableOffcuts: entry.usableOffcuts,
          toolUsage: entry.toolUsage,
          drillUsage: entry.drillUsage,
          validation: entry.validation as ValidationResult,
          nestPick: entry.nestPick,
          mesOutputVersion: parsed.exportMetadata?.mesOutputVersion ?? null
        });
        updated += 1;
      } catch (error) {
        const errObj = error as { code?: unknown; detail?: unknown };
        logger.warn(
          {
            err: error,
            code: errObj?.code,
            detail: errObj?.detail,
            jobKey,
            validationStatus: entry.validation?.status,
            folderPath: entry.folderPath,
            filename: entry.filename,
            mesOutputVersion: parsed.exportMetadata?.mesOutputVersion ?? null
          },
          'Failed to upsert nc_stats'
        );
      }
    }

    const { failed, sampleFolder } = collectFailures(files);

    if (failed > 0) {
      pushAppMessage('mes.validationFailure', { failed, folder: sampleFolder ?? 'MES export' }, { source: 'mes-validation' });
    }

    if (missing > 0 || invalidPathKeys.length > 0) {
      pushAppMessage('mes.jobsNotFound', { missing: missing + invalidPathKeys.length }, { source: 'mes-validation' });
    }

    pushAppMessage('mes.processed', { processed: files.length, updated }, { source: 'mes-validation' });
    logger.info(
      { processed: files.length, updated, missing, invalidPathKeys, jsonPath, processedJobsRoot: root },
      `MES scan: completed processing; processed=${files.length}, updated=${updated}, missing=${missing}`
    );
  } finally {
    try {
      await fsp.unlink(jsonPath);
    } catch (err) {
      logger.warn({ err }, 'Failed to delete validation.json after processing');
    }
    processing = false;
  }
}

export function initMesValidationScanner(): void {
  if (interval) return;
  interval = setInterval(() => {
    processValidationJson().catch((err) => logger.warn({ err }, 'MES validation scan failed'));
  }, SCAN_INTERVAL_MS);
}

export function stopMesValidationScanner(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
