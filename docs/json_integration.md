# MES JSON / Validation Processing Implementation Plan

## Overview

Process `validation.json` files from NC Catalyst, store MES/MES-adjacent data in a dedicated `nc_stats` table keyed by `jobs.key`, and display the data in a modal when users double-click NC files.

Key principles:
- The JSON describes **files that already exist (or will exist) under the configured `processedJobsRoot`**.
- We compute the job key **exactly** the same way as `ingestProcessedJobsRoot` so MES data always lines up with `public.jobs.key`.
- We expect the JSON field name `ncRuntime` and map it to a DB column named `nc_est_runtime`.

---

## 1. TypeScript Interfaces

### New File: `packages/shared/src/mesValidation.ts`

Create Zod schemas and TypeScript types aligned with `docs/MES-JSON-SPECIFICATION.md` and the `nc_stats` table.

```typescript
// Core data structures (per MES spec)
export type Offcut = { x: number; y: number; z: number }; // mm dimensions

export type ToolUsage = {
  toolNumber: string;
  toolName: string;
  cuttingDistanceMeters: number;
  toolDustM3: number;
};

export type DrillUsage = {
  drillNumber: string;
  drillName: string;
  holeCount: number;
  drillDistanceMeters: number;
  drillDustM3: number;
};

export type ValidationResult = {
  status: 'pass' | 'warnings' | 'errors';
  warnings: string[];
  errors: string[];
  syntax: string[];
};

export type NestPickResult = {
  canAllBePicked: boolean | null;
  partsTooLargeForPallet: { partNumber: string; reason: string }[];
  failedParts: { partNumber: string; reason: string }[];
  palletAdjustedVolumeM3: number | null;
};

// File entry (per NC file in MES JSON)
export type ValidationFileEntry = {
  filename: string;      // NC file name with extension
  folderName: string;    // leaf folder name (from spec)
  folderPath: string;    // absolute path of the folder under processedJobsRoot

  // Core metrics
  ncRuntime: number;     // seconds
  yieldPercentage: number; // %

  // Offcuts and dust
  usableOffcuts: Offcut[];
  wasteOffcutM2: number;
  wasteOffcutDustM3: number;
  TotalToolDustM3: number;
  TotalDrillDustM3: number;
  SheetTotalDustM3: number;

  // Usage details
  toolUsage: ToolUsage[];
  drillUsage: DrillUsage[];

  // Validation and NestPick details
  validation: ValidationResult;
  nestPick: NestPickResult | null;
};

// Root JSON structure (per docs/MES-JSON-SPECIFICATION.md)
export type ValidationJson = {
  exportMetadata?: {
    exportDate?: string | null;        // we do not persist this
    exportedBy?: string | null;
    mesOutputVersion?: string | null;  // persisted as mes_output_version
    folderName?: string | null;
    Status?: 'pass' | 'fail' | string | null;
    originalFolderPath?: string | null;
    newFolderPath?: string | null;
  };
  files: ValidationFileEntry[];
};

// IPC types
export type ValidationDataReq = { key: string };

export type ValidationDataRes = {
  key: string;                   // jobs.key
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
```

---

## 2. Database Schema: `nc_stats` Table

### New table: `public.nc_stats`

Use a dedicated table for MES/MES-adjacent data, keyed by `jobs.key`.

Columns:

| Column                 | Type        | Description |
|------------------------|-------------|-------------|
| `job_key`              | varchar(100) PK, FK → `public.jobs(key)` | Job key, built exactly like `ingestProcessedJobsRoot` |
| `nc_est_runtime`       | integer     | Estimated runtime in seconds (from `ncRuntime`) |
| `yield_percentage`     | real        | Yield percentage |
| `waste_offcut_m2`      | real        | Waste area in m² |
| `waste_offcut_dust_m3` | real        | Waste offcut dust volume (m³) |
| `total_tool_dust_m3`   | real        | Total router tool dust volume (m³) |
| `total_drill_dust_m3`  | real        | Total drill dust volume (m³) |
| `sheet_total_dust_m3`  | real        | Total sheet dust volume (m³) |
| `cutting_distance_meters` | real     | Sum of all `toolUsage[].cuttingDistanceMeters` |
| `usable_offcuts`       | jsonb       | Array of offcuts ({x,y,z}) |
| `tool_usage`           | jsonb       | Full `toolUsage` array |
| `drill_usage`          | jsonb       | Full `drillUsage` array |
| `validation`           | jsonb       | Full `validation` object |
| `nestpick`             | jsonb       | Full `nestPick` object |
| `mes_output_version`   | text        | `exportMetadata.mesOutputVersion` |

We intentionally do **not** store a separate `export_date` or process timestamp; these are either redundant or not needed.

### Migration SQL

```sql
CREATE TABLE public.nc_stats (
  job_key varchar(100) PRIMARY KEY REFERENCES public.jobs(key) ON DELETE CASCADE,
  nc_est_runtime integer,
  yield_percentage real,
  waste_offcut_m2 real,
  waste_offcut_dust_m3 real,
  total_tool_dust_m3 real,
  total_drill_dust_m3 real,
  sheet_total_dust_m3 real,
  cutting_distance_meters real,
  usable_offcuts jsonb,
  tool_usage jsonb,
  drill_usage jsonb,
  validation jsonb,
  nestpick jsonb,
  mes_output_version text
);
```

---

## 3. MES / Validation JSON Scanner Service

### New File: `packages/main/src/services/mesValidation.ts`

**Scanner Logic:**
1. Run every 5 seconds via `setInterval`
2. Check for `validation.json` in AppData folder (`app.getPath('userData')`)
3. If found:
   - Parse JSON with Zod validation (using the `ValidationJson` schema)
   - For **each file entry**:
     - Compute the job key relative to `processedJobsRoot`:

       ```ts
       const root = cfg.paths.processedJobsRoot; // same as ingestProcessedJobsRoot
       const folderPath = entry.folderPath;      // absolute path where NC lives under root
       const filename = entry.filename;          // NC file name with extension

       const relFolder = path.relative(root, folderPath).replace(/\\/g, '/');
       const baseNoExt = filename.replace(/\.[^./]+$/, '') || filename;
       const jobKey = (relFolder ? `${relFolder}/${baseNoExt}` : baseNoExt).slice(0, 100);
       ```

     - Look up the job by `jobKey` in `public.jobs`.
     - Upsert a row in `public.nc_stats` with:
       - All core metrics (runtime, yield, offcuts, dust)
       - Tool/drill usage
       - Full `validation` and `nestPick` objects
       - `mes_output_version` from `exportMetadata.mesOutputVersion` (if present)

   - Independently of DB updates, aggregate validation failures across all files to drive user-facing messages (see Messages section).
   - **Always delete** `validation.json` after processing (NC Catalyst handles quarantining failed jobs / folders).

**Key Functions:**
```typescript
getValidationJsonPath(): string  // AppData/validation.json
// NOTE: jobKey is derived from processedJobsRoot + folderPath + filename,
// not from AP job folders.

buildJobKeyFromMesEntry(root: string, folderPath: string, filename: string): string;

formatValidationFailure(file): string  // Human-readable error format
processValidationJson(): Promise<void>  // Main processing logic
initMesValidationScanner(): void  // Start 5s interval
stopMesValidationScanner(): void  // Cleanup on app quit
```

**Failure Message Format:**
```
Folder: JobFolder
File: sheet1.nc
Status: errors
Errors: Tool T5 not found; Invalid G-code on line 234
Warnings: Feed rate exceeds maximum
Syntax: Missing end-of-program marker
```

---

## 4. Repository Functions

### New File: `packages/main/src/repo/ncStatsRepo.ts`

Add helpers to work with `public.nc_stats`:

```typescript
// Input shape for upsert from MES JSON (ncRuntime maps to ncEstRuntime)
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
  usableOffcuts?: Offcut[];
  toolUsage?: ToolUsage[];
  drillUsage?: DrillUsage[];
  validation?: ValidationResult | null;
  nestPick?: NestPickResult | null;
  mesOutputVersion?: string | null;
};

// Upsert MES stats for a job
upsertNcStats(row: NcStatsUpsert): Promise<void>;

// Get MES stats for a job (for modal display)
getNcStats(jobKey: string): Promise<ValidationDataRes | null>;
```

**Note:** `cuttingDistanceMeters` is calculated as the sum of all `toolUsage[].cuttingDistanceMeters` from the JSON.

---

## 5. IPC Handlers

### New File: `packages/main/src/ipc/mesData.ts`

```typescript
// Handler: 'validation:getData'
// Input: { key: string }
// Output: ValidationDataRes | error if not found
```

### Modify: `packages/main/src/ipc/index.ts`
- Register `mesData` IPC handlers

### Modify: `packages/preload/src/index.ts`
- Add `validation.getData(key)` to API bridge

---

## 6. Message Definitions

### Modify: `packages/shared/src/messages.ts`

Add messages:

| Key | Tone | Description |
|-----|------|-------------|
| `mes.parseError` | error | Failed to parse validation.json |
| `mes.validationFailure` | error | Files failed validation (with formatted details) |
| `mes.processed` | info | Successfully updated N jobs |
| `mes.jobsNotFound` | warning | N jobs from JSON not found in database |

---

## 7. Frontend Components

### New File: `packages/renderer/src/components/ValidationDataModal.tsx`

A Sheet (slide-out panel) component displaying:

**Summary Cards (2x2 grid):**
- Estimated Runtime (formatted as Xh Xm Xs)
- Yield Percentage (X.X%)
- Total Cutting Distance (X.XX m)
- Waste Offcut (X.XX m²)

**Dust Data Section:**
- Waste Offcut Dust (X.XXXXX m³)
- Total Tool Dust (X.XXXXX m³)
- Total Drill Dust (X.XXXXX m³)
- Total Sheet Dust (X.XXXXX m³)

**Usable Offcuts Table:** (if any exist)
| X (mm) | Y (mm) | Z (mm) |
|--------|--------|--------|

**Tool Usage Table:**
| # | Tool Name | Cutting Distance (m) | Dust (m³) |
|---|-----------|----------------------|-----------|

**Drill Usage Table:**
| # | Drill Name | Holes | Distance (m) | Dust (m³) |
|---|------------|-------|--------------|-----------|

**Footer:** "Processed: [timestamp]"

---

## 8. Double-Click Handler

### Modify: `packages/renderer/src/components/table/GlobalTable.tsx`

Add `onRowDoubleClick` prop to GlobalTable:

```typescript
onRowDoubleClick?: (row: Row<TData>, event: MouseEvent) => void;
```

### Modify: `packages/renderer/src/pages/JobsPage.tsx`

1. Add state for modal: `validationModalOpen`, `validationModalJob`
2. Add `handleRowDoubleClick` callback that opens modal with job data
3. Pass `onRowDoubleClick` to GlobalTable
4. Render `<ValidationDataModal />` component

### Modify: `packages/renderer/src/pages/RouterPage.tsx`

Apply same pattern for ready-to-run table.

---

## 9. Main Process Initialization

### Modify: `packages/main/src/main.ts` (or entry point)

```typescript
// On app ready:
initMesValidationScanner();

// On app quit:
stopMesValidationScanner();
```

---

## Files to Create

1. `packages/shared/src/mesValidation.ts` - Types and schemas
2. `packages/main/src/services/mesValidation.ts` - Scanner service
3. `packages/main/src/ipc/mesData.ts` - IPC handler
4. `packages/renderer/src/components/ValidationDataModal.tsx` - Display modal

## Files to Modify

1. `packages/main/src/db/schema.ts` - Add `nc_stats` table
2. `packages/main/src/repo/ncStatsRepo.ts` - Add nc_stats helpers
3. `packages/main/src/ipc/mesData.ts` - IPC handler
4. `packages/main/src/ipc/index.ts` - Register handlers
5. `packages/preload/src/index.ts` - Add API bridge
6. `packages/shared/src/mesValidation.ts` - Zod schemas & types
7. `packages/shared/src/messages.ts` - Add message definitions
8. `packages/renderer/src/components/table/GlobalTable.tsx` - Add double-click
9. `packages/renderer/src/pages/JobsPage.tsx` - Add modal and handler
10. `packages/renderer/src/pages/RouterPage.tsx` - Add modal and handler
11. `packages/main/src/main.ts` - Initialize scanner

---

## Implementation Order

1. **Types & Schema** - Create interfaces/Zod schemas, add `nc_stats` table
2. **Backend** - Scanner service, `ncStatsRepo`, IPC handlers
3. **Preload & Messages** - API bridge, message definitions
4. **Frontend** - Modal component, double-click handlers
5. **Testing** - Test with sample `validation.json` files and verify job key mapping against `processedJobsRoot`
