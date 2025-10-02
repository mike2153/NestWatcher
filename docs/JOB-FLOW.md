# Job Processing Flow

Quick reference for how jobs move through the system from ingestion to completion.

## Flow Diagram

```
1. PENDING       → Job ingested from processedJobsRoot folder
                   (ingest.ts scans .nc files, reads metadata)

2. STAGED        → Operator adds job to worklist for a machine
                   (worklist.ts copies files to machine's ap_jobfolder)

3. LOAD_FINISH   → AutoPAC signals material loaded
                   (load_finish<machine>.csv → autoPacCsvDir)

4. LABEL_FINISH  → AutoPAC signals labeling complete
                   (label_finish<machine>.csv → autoPacCsvDir)

5. CNC_FINISH    → AutoPAC signals CNC cutting complete
                   (cnc_finish<machine>.csv → autoPacCsvDir)
                   → Auto-forwards CSV to Nestpick folder

6. FORWARDED_TO_NESTPICK → CSV written to Nestpick.csv
                           (watchersWorker forwards parts CSV)

7. NESTPICK_COMPLETE → Nestpick writes "processed" CSV
                       (nestpickFolder/processed/*.csv detected)
```

## File Structure Requirements

### 1. Ingestion (PENDING)
**Location**: `processedJobsRoot` (configured in Settings)

**Structure**:
```
processedJobsRoot/
  └─ JobFolderName/
      ├─ JobName.nc        (required - CNC program)
      ├─ JobName.lpt       (optional - Planit label file)
      ├─ JobName.pts       (optional - Alphacam parts file)
      ├─ JobName.csv       (optional - per-file parts CSV)
      ├─ RJT.csv           (optional - Planit family CSV, first 3 chars)
      └─ images/           (optional - .bmp, .jpg, .jpeg files)
```

**Metadata Extracted** from `.nc` file:
- `ID=<material>` → material field
- `G100 X<x> Y<y> Z<z>` → size (XxY), thickness (Z)
- Parts count from `.lpt` or `.pts` file

### 2. Staging (STAGED)
**Trigger**: Operator clicks "Add To Worklist" in Jobs page

**Destination**: Machine's `ap_jobfolder` (e.g., `\\Machine1\ReadyToRun`)

**Files Copied**:
- **Always**: `.nc`, `.lpt`, `.pts`, exact-match `.csv` (JobName.csv)
- **Planit mode** (has `.lpt`, no `.pts`): Also copy family CSV (`RJT.csv`)
- **Alphacam mode** (has `.pts`): Copy all `JobName*.bmp|jpg|jpeg`
- **Images**: Resolved via Planit family CSV or Alphacam wildcard

**CSV Rules**:
- `JobName.csv` = per-file parts CSV (forwarded to Nestpick later)
- `RJT.csv` = family CSV (first 3 letters, Planit only, for image mapping)

### 3. Processing Events (LOAD_FINISH, LABEL_FINISH, CNC_FINISH)
**Location**: `autoPacCsvDir` (configured in Settings)

**File Naming** (strict):
- `load_finish<machine>.csv`
- `label_finish<machine>.csv`
- `cnc_finish<machine>.csv`

Where `<machine>` = machine name or ID (e.g., `load_finish_Machine1.csv` or `load_finish_1.csv`)

**CSV Format**:
```csv
JobName1
JobName2
Machine1
```
- First column = NC base name (with or without `.nc` extension)
- CSV must contain matching machine identifier somewhere in content

**Processing**:
- Watcher detects file in `autoPacCsvDir`
- Updates job status to `LOAD_FINISH`, `LABEL_FINISH`, or `CNC_FINISH`
- On `CNC_FINISH`: Auto-forwards parts CSV to Nestpick folder
- Deletes source CSV after successful processing

### 4. Nestpick Forwarding (FORWARDED_TO_NESTPICK)
**Automatic** after `CNC_FINISH` if machine has Nestpick enabled

**Process**:
1. Finds `JobName.csv` in staged folder (`ap_jobfolder/JobFolderName/`)
2. Rewrites CSV with machine columns (destination=99, source=machineId)
3. Waits for `Nestpick.csv` slot to be available (5min timeout)
4. Writes to `machine.nestpickFolder/Nestpick.csv`
5. Deletes source CSV from staged folder

### 5. Nestpick Completion (NESTPICK_COMPLETE)
**Location**: `machine.nestpickFolder/processed/`

**Trigger**: Watcher detects any `.csv` file in processed folder

**Processing**:
- Reads CSV, extracts NC base names
- Updates job status to `NESTPICK_COMPLETE`
- Archives CSV to `machine.nestpickFolder/archive/`

### 6. Pallet Assignment (Optional)
**Location**: `machine.nestpickFolder/Report_FullNestpickUnstack.csv`

**Format**:
```csv
JobName,SourcePlace,Dest,...
RJT123,Pallet_A05,...
```
- Column 0 = Job name
- Column 1 = Pallet (e.g., `Pallet_A05`)

**Processing**:
- Updates `pallet` field on job record
- Archives CSV after processing

## Status Transitions

**Allowed Transitions** (enforced in `jobsRepo.ts`):
- `PENDING` → `PENDING` only (reingestion)
- `STAGED` → from `PENDING`, `STAGED`
- `LOAD_FINISH` → from `PENDING`, `STAGED`, `LOAD_FINISH`
- `LABEL_FINISH` → from `STAGED`, `LOAD_FINISH`, `LABEL_FINISH`
- `CNC_FINISH` → from `STAGED`, `LOAD_FINISH`, `LABEL_FINISH`, `CNC_FINISH`
- `FORWARDED_TO_NESTPICK` → from `CNC_FINISH`, `FORWARDED_TO_NESTPICK`
- `NESTPICK_COMPLETE` → from `FORWARDED_TO_NESTPICK`, `NESTPICK_COMPLETE`

Invalid transitions are rejected (e.g., cannot jump from `PENDING` to `CNC_FINISH`).

## Key Configuration Paths

Set these in **Settings** page:

| Setting | Purpose | Example |
|---------|---------|---------|
| `processedJobsRoot` | Source folder for job ingestion | `C:\Jobs\Processed` |
| `autoPacCsvDir` | Where AutoPAC writes status CSVs | `C:\AutoPAC\CSV` |
| `machines[].apJobfolder` | Machine's ready-to-run folder | `\\Machine1\ReadyToRun` |
| `machines[].nestpickFolder` | Nestpick input/output folder | `\\Machine1\Nestpick` |
| `machines[].nestpickEnabled` | Enable Nestpick forwarding | `true` |

## Quick Troubleshooting

**Job stuck in PENDING?**
- Check if `processedJobsRoot` is set and folder exists
- Verify `.nc` file is present
- Check Diagnostics panel for watcher errors

**Job not staging?**
- Verify `ap_jobfolder` is accessible (network share permissions)
- Check for folder name collisions (timestamped folders created automatically)

**AutoPAC CSV not processing?**
- File must be named `load_finish<machine>.csv` (exact format)
- CSV must contain machine identifier in content
- Check `autoPacCsvDir` setting and file permissions

**Nestpick not forwarding?**
- Machine must have `nestpickEnabled=true`
- `nestpickFolder` must be set and accessible
- `JobName.csv` must exist in staged folder
- Check for `Nestpick.csv` lock/busy timeout (5min)

**Nestpick completion not detected?**
- Check watcher is running (Diagnostics panel)
- Verify files appear in `nestpickFolder/processed/`
- CSV must contain recognizable NC base names
