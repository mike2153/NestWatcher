import { z } from 'zod';

// Core shapes
export const OffcutSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number()
});
export type Offcut = z.infer<typeof OffcutSchema>;

export const ToolUsageSchema = z.object({
  toolNumber: z.string(),
  toolName: z.string(),
  cuttingDistanceMeters: z.number(),
  toolDustM3: z.number()
}).passthrough();
export type ToolUsage = z.infer<typeof ToolUsageSchema>;

export const DrillUsageSchema = z.object({
  drillNumber: z.string(),
  drillName: z.string(),
  holeCount: z.number(),
  drillDistanceMeters: z.number(),
  drillDustM3: z.number()
}).passthrough();
export type DrillUsage = z.infer<typeof DrillUsageSchema>;

export const ValidationResultSchema = z.object({
  status: z.enum(['pass', 'warnings', 'errors']),
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
  syntax: z.array(z.string())
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

export const NestPickResultSchema = z.object({
  canAllBePicked: z.boolean().nullable(),
  partsTooLargeForPallet: z
    .array(z.object({ partNumber: z.string(), reason: z.string() }).passthrough())
    .default([]),
  failedParts: z
    .array(z.object({ partNumber: z.string(), reason: z.string() }).passthrough())
    .default([]),
  palletAdjustedVolumeM3: z.number().nullable()
});
export type NestPickResult = z.infer<typeof NestPickResultSchema>;

export const ValidationFileEntrySchema = z.object({
  filename: z.string(),
  folderName: z.string(),
  folderPath: z.string(),

  // Estimated runtime in seconds (may be float)
  ncEstRuntime: z.number(),
  yieldPercentage: z.number(),

  usableOffcuts: z.array(OffcutSchema),
  wasteOffcutM2: z.number(),
  wasteOffcutDustM3: z.number(),
  TotalToolDustM3: z.number(),
  TotalDrillDustM3: z.number(),
  SheetTotalDustM3: z.number(),

  toolUsage: z.array(ToolUsageSchema),
  drillUsage: z.array(DrillUsageSchema),

  validation: ValidationResultSchema,
  nestPick: NestPickResultSchema.nullable()
}).passthrough();
export type ValidationFileEntry = z.infer<typeof ValidationFileEntrySchema>;

export const ExportMetadataSchema = z.object({
  exportDate: z.string().nullable().optional(),
  exportedBy: z.string().nullable().optional(),
  mesOutputVersion: z.string().nullable().optional(),
  folderName: z.string().nullable().optional(),
  Status: z.string().nullable().optional(),
  originalFolderPath: z.string().nullable().optional(),
  newFolderPath: z.string().nullable().optional()
}).passthrough();

export const ValidationJsonSchema = z.object({
  exportMetadata: ExportMetadataSchema.optional(),
  files: z.array(ValidationFileEntrySchema)
}).passthrough();
export type ValidationJson = z.infer<typeof ValidationJsonSchema>;

export type ValidationDataReq = { key: string };

export type ValidationDataRes = {
  key: string;
  ncEstRuntime: number | null;
  yieldPercentage: number | null;
  usableOffcuts: Offcut[];
  wasteOffcutM2: number | null;
  wasteOffcutDustM3: number | null;
  totalToolDustM3: number | null;
  totalDrillDustM3: number | null;
  sheetTotalDustM3: number | null;
  cuttingDistanceMeters: number | null;
  toolUsage: ToolUsage[];
  drillUsage: DrillUsage[];
  validation: ValidationResult | null;
  nestPick: NestPickResult | null;
  mesOutputVersion: string | null;
};

export type AggregatedValidationDataReq = { keys: string[] };

export type AggregatedValidationDataRes = {
  jobCount: number;
  totalNcEstRuntime: number | null;
  avgYieldPercentage: number | null;
  totalWasteOffcutM2: number | null;
  totalWasteOffcutDustM3: number | null;
  totalToolDustM3: number | null;
  totalDrillDustM3: number | null;
  totalSheetDustM3: number | null;
  totalCuttingDistanceMeters: number | null;
  allPartsPickable: boolean;
  totalPalletAdjustedVolumeM3: number | null;
  toolUsage: ToolUsage[];
  drillUsage: DrillUsage[];
  validationSummary: {
    passCount: number;
    warningsCount: number;
    errorsCount: number;
  };
};
