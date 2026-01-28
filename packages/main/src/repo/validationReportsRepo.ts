import { desc, sql } from 'drizzle-orm';
import type { NcCatValidationReport } from '../../../shared/src';
import { validationReports } from '../db/schema';
import { withDb } from '../services/db';

const MAX_ROWS = 2000;

function parseReport(value: unknown): NcCatValidationReport | null {
  if (value && typeof value === 'object') {
    return value as NcCatValidationReport;
  }
  return null;
}

function mergeReports(a: NcCatValidationReport, b: NcCatValidationReport): NcCatValidationReport {
  const byName = new Map<string, NcCatValidationReport['files'][number]>();
  const severity = (s: 'pass' | 'warnings' | 'errors') => (s === 'errors' ? 2 : s === 'warnings' ? 1 : 0);

  const addFile = (f: NcCatValidationReport['files'][number]) => {
    const existing = byName.get(f.filename);
    if (!existing) {
      byName.set(f.filename, {
        filename: f.filename,
        status: f.status,
        warnings: [...(f.warnings ?? [])],
        errors: [...(f.errors ?? [])]
      });
      return;
    }
    existing.status = severity(existing.status) >= severity(f.status) ? existing.status : f.status;
    existing.warnings = Array.from(new Set([...(existing.warnings ?? []), ...(f.warnings ?? [])]));
    existing.errors = Array.from(new Set([...(existing.errors ?? []), ...(f.errors ?? [])]));
  };

  for (const f of a.files) addFile(f);
  for (const f of b.files) addFile(f);

  const files = Array.from(byName.values()).sort((x, y) => x.filename.localeCompare(y.filename));
  const hasErrors = files.some((f) => f.status === 'errors');
  const hasWarnings = files.some((f) => f.status === 'warnings');
  const overallStatus = hasErrors ? 'errors' : hasWarnings ? 'warnings' : 'pass';

  // Keep the newest processedAt for display purposes.
  const processedAt = new Date(a.processedAt).getTime() >= new Date(b.processedAt).getTime() ? a.processedAt : b.processedAt;

  return {
    ...a,
    processedAt,
    profileName: a.profileName ?? b.profileName ?? null,
    overallStatus,
    files
  };
}

function coalesceReports(reports: NcCatValidationReport[]): NcCatValidationReport[] {
  // Reports come in newest-first.
  const COALESCE_WINDOW_MS = 30_000;
  const out: NcCatValidationReport[] = [];

  const norm = (s: string) => s.trim().replace(/\s+/g, ' ');
  const ts = (iso: string) => new Date(iso).getTime();

  for (const report of reports) {
    const reportTs = ts(report.processedAt);
    // Search backwards through the "recent" window only.
    let merged = false;
    for (let i = out.length - 1; i >= 0; i -= 1) {
      const candidate = out[i];
      const candidateTs = ts(candidate.processedAt);
      if (Number.isFinite(candidateTs) && Number.isFinite(reportTs)) {
        if (Math.abs(candidateTs - reportTs) > COALESCE_WINDOW_MS) {
          break;
        }
      }

      const sameFolder = norm(candidate.folderName) === norm(report.folderName);
      const sameReason = candidate.reason === report.reason;
      const sameProfile = (candidate.profileName ?? null) === (report.profileName ?? null);
      if (sameFolder && sameReason && sameProfile) {
        out[i] = mergeReports(candidate, report);
        merged = true;
        break;
      }
    }
    if (!merged) {
      out.push(report);
    }
  }

  return out;
}

export async function insertValidationReport(report: NcCatValidationReport): Promise<void> {
  await withDb(async (db) => {
    await db.insert(validationReports).values({
      reason: report.reason,
      folderName: report.folderName,
      profileName: report.profileName ?? null,
      processedAt: new Date(report.processedAt),
      overallStatus: report.overallStatus,
      reportData: report
    });

    await db.execute(sql`
      DELETE FROM validation_reports
      WHERE id IN (
        SELECT id
        FROM validation_reports
        ORDER BY processed_at DESC
        OFFSET ${MAX_ROWS}
      )
    `);
  });
}

export async function listValidationReports(limit: number): Promise<NcCatValidationReport[]> {
  const rows = await withDb((db) =>
    db
      .select({
        reportData: validationReports.reportData
      })
      .from(validationReports)
      .orderBy(desc(validationReports.processedAt), desc(validationReports.createdAt))
      .limit(limit)
  );

  const out: NcCatValidationReport[] = [];
  for (const row of rows) {
    const parsed = parseReport(row.reportData);
    if (parsed) out.push(parsed);
  }
  return coalesceReports(out);
}

