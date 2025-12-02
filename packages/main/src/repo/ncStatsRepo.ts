import { eq } from 'drizzle-orm';
import { ncStats } from '../db/schema';
import { withDb } from '../services/db';
import type {
  DrillUsage,
  NestPickResult,
  Offcut,
  ToolUsage,
  ValidationDataRes,
  ValidationResult
} from '../../../shared/src';

export type NcStatsUpsert = {
  jobKey: string;
  ncEstRuntime?: number | null;
  yieldPercentage?: number | null;
  wasteOffcutM2?: number | null;
  wasteOffcutDustM3?: number | null;
  totalToolDustM3?: number | null;
  totalDrillDustM3?: number | null;
  sheetTotalDustM3?: number | null;
  cuttingDistanceMeters?: number | null;
  usableOffcuts?: Offcut[] | null;
  toolUsage?: ToolUsage[] | null;
  drillUsage?: DrillUsage[] | null;
  validation?: ValidationResult | null;
  nestPick?: NestPickResult | null;
  mesOutputVersion?: string | null;
};

export async function upsertNcStats(input: NcStatsUpsert): Promise<void> {
  const {
    jobKey,
    ncEstRuntime,
    yieldPercentage,
    wasteOffcutM2,
    wasteOffcutDustM3,
    totalToolDustM3,
    totalDrillDustM3,
    sheetTotalDustM3,
    cuttingDistanceMeters,
    usableOffcuts,
    toolUsage,
    drillUsage,
    validation,
    nestPick,
    mesOutputVersion
  } = input;

  await withDb((db) =>
    db
      .insert(ncStats)
      .values({
        jobKey,
        ncEstRuntime: ncEstRuntime ?? null,
        yieldPercentage: yieldPercentage ?? null,
        wasteOffcutM2: wasteOffcutM2 ?? null,
        wasteOffcutDustM3: wasteOffcutDustM3 ?? null,
        totalToolDustM3: totalToolDustM3 ?? null,
        totalDrillDustM3: totalDrillDustM3 ?? null,
        sheetTotalDustM3: sheetTotalDustM3 ?? null,
        cuttingDistanceMeters: cuttingDistanceMeters ?? null,
        usableOffcuts: usableOffcuts ?? null,
        toolUsage: toolUsage ?? null,
        drillUsage: drillUsage ?? null,
        validation: validation ?? null,
        nestpick: nestPick ?? null,
        mesOutputVersion: mesOutputVersion ?? null
      })
      .onConflictDoUpdate({
        target: ncStats.jobKey,
        set: {
          ncEstRuntime: ncEstRuntime ?? null,
          yieldPercentage: yieldPercentage ?? null,
          wasteOffcutM2: wasteOffcutM2 ?? null,
          wasteOffcutDustM3: wasteOffcutDustM3 ?? null,
          totalToolDustM3: totalToolDustM3 ?? null,
          totalDrillDustM3: totalDrillDustM3 ?? null,
          sheetTotalDustM3: sheetTotalDustM3 ?? null,
          cuttingDistanceMeters: cuttingDistanceMeters ?? null,
          usableOffcuts: usableOffcuts ?? null,
          toolUsage: toolUsage ?? null,
          drillUsage: drillUsage ?? null,
          validation: validation ?? null,
          nestpick: nestPick ?? null,
          mesOutputVersion: mesOutputVersion ?? null
        }
      })
  );
}

export async function getNcStats(jobKey: string): Promise<ValidationDataRes | null> {
  const rows = await withDb((db) =>
    db
      .select()
      .from(ncStats)
      .where(eq(ncStats.jobKey, jobKey))
      .limit(1)
  );
  const row = rows[0];
  if (!row) return null;

  return {
    key: jobKey,
    ncEstRuntime: row.ncEstRuntime ?? null,
    yieldPercentage: row.yieldPercentage ?? null,
    usableOffcuts: (row.usableOffcuts as Offcut[] | null) ?? [],
    wasteOffcutM2: row.wasteOffcutM2 ?? null,
    wasteOffcutDustM3: row.wasteOffcutDustM3 ?? null,
    totalToolDustM3: row.totalToolDustM3 ?? null,
    totalDrillDustM3: row.totalDrillDustM3 ?? null,
    sheetTotalDustM3: row.sheetTotalDustM3 ?? null,
    cuttingDistanceMeters: row.cuttingDistanceMeters ?? null,
    toolUsage: (row.toolUsage as ToolUsage[] | null) ?? [],
    drillUsage: (row.drillUsage as DrillUsage[] | null) ?? [],
    validation: (row.validation as ValidationResult | null) ?? null,
    nestPick: (row.nestpick as NestPickResult | null) ?? null,
    mesOutputVersion: row.mesOutputVersion ?? null
  };
}
