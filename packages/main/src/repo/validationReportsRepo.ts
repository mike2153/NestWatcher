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
  return out;
}

