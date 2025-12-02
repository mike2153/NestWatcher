import { eq, inArray } from 'drizzle-orm';
import { ncStats } from '../db/schema';
import { withDb } from '../services/db';
import type {
  AggregatedValidationDataRes,
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

export async function getAggregatedNcStats(jobKeys: string[]): Promise<AggregatedValidationDataRes | null> {
  if (!jobKeys.length) return null;

  const rows = await withDb((db) =>
    db
      .select()
      .from(ncStats)
      .where(inArray(ncStats.jobKey, jobKeys))
  );

  if (!rows.length) return null;

  // Aggregate numeric values
  let totalRuntime = 0;
  let totalYield = 0;
  let yieldCount = 0;
  let totalWasteOffcutM2 = 0;
  let totalWasteOffcutDustM3 = 0;
  let totalToolDustM3 = 0;
  let totalDrillDustM3 = 0;
  let totalSheetDustM3 = 0;
  let totalCuttingDistance = 0;
  let totalPalletVolume = 0;
  let allPickable = true;
  let passCount = 0;
  let warningsCount = 0;
  let errorsCount = 0;

  // Aggregate tool and drill usage by tool/drill name
  const toolMap = new Map<string, { toolNumber: string; toolName: string; cuttingDistanceMeters: number; toolDustM3: number }>();
  const drillMap = new Map<string, { drillNumber: string; drillName: string; holeCount: number; drillDistanceMeters: number; drillDustM3: number }>();

  for (const row of rows) {
    if (row.ncEstRuntime != null) totalRuntime += row.ncEstRuntime;
    if (row.yieldPercentage != null) {
      totalYield += row.yieldPercentage;
      yieldCount += 1;
    }
    if (row.wasteOffcutM2 != null) totalWasteOffcutM2 += row.wasteOffcutM2;
    if (row.wasteOffcutDustM3 != null) totalWasteOffcutDustM3 += row.wasteOffcutDustM3;
    if (row.totalToolDustM3 != null) totalToolDustM3 += row.totalToolDustM3;
    if (row.totalDrillDustM3 != null) totalDrillDustM3 += row.totalDrillDustM3;
    if (row.sheetTotalDustM3 != null) totalSheetDustM3 += row.sheetTotalDustM3;
    if (row.cuttingDistanceMeters != null) totalCuttingDistance += row.cuttingDistanceMeters;

    const nestPick = row.nestpick as NestPickResult | null;
    if (nestPick) {
      if (nestPick.palletAdjustedVolumeM3 != null) totalPalletVolume += nestPick.palletAdjustedVolumeM3;
      if (nestPick.canAllBePicked === false) allPickable = false;
    }

    const validation = row.validation as ValidationResult | null;
    if (validation) {
      if (validation.status === 'pass') passCount += 1;
      else if (validation.status === 'warnings') warningsCount += 1;
      else if (validation.status === 'errors') errorsCount += 1;
    }

    // Aggregate tool usage
    const tools = row.toolUsage as ToolUsage[] | null;
    if (tools) {
      for (const tool of tools) {
        const existing = toolMap.get(tool.toolName);
        if (existing) {
          existing.cuttingDistanceMeters += tool.cuttingDistanceMeters;
          existing.toolDustM3 += tool.toolDustM3;
        } else {
          toolMap.set(tool.toolName, { ...tool });
        }
      }
    }

    // Aggregate drill usage
    const drills = row.drillUsage as DrillUsage[] | null;
    if (drills) {
      for (const drill of drills) {
        const existing = drillMap.get(drill.drillName);
        if (existing) {
          existing.holeCount += drill.holeCount;
          existing.drillDistanceMeters += drill.drillDistanceMeters;
          existing.drillDustM3 += drill.drillDustM3;
        } else {
          drillMap.set(drill.drillName, { ...drill });
        }
      }
    }
  }

  return {
    jobCount: rows.length,
    totalNcEstRuntime: totalRuntime || null,
    avgYieldPercentage: yieldCount > 0 ? totalYield / yieldCount : null,
    totalWasteOffcutM2: totalWasteOffcutM2 || null,
    totalWasteOffcutDustM3: totalWasteOffcutDustM3 || null,
    totalToolDustM3: totalToolDustM3 || null,
    totalDrillDustM3: totalDrillDustM3 || null,
    totalSheetDustM3: totalSheetDustM3 || null,
    totalCuttingDistanceMeters: totalCuttingDistance || null,
    allPartsPickable: allPickable,
    totalPalletAdjustedVolumeM3: totalPalletVolume || null,
    toolUsage: Array.from(toolMap.values()),
    drillUsage: Array.from(drillMap.values()),
    validationSummary: {
      passCount,
      warningsCount,
      errorsCount
    }
  };
}
