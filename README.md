# WoodtronWorkflow

Production-ready Qt 6.10 (QML + C++) desktop application for managing CNC job flow, Ready‑To‑Run (R2R) staging, AutoPAC/Nestpick integration, and shop-floor telemetry. This document gives developers a complete overview of features, data flow, back‑end functions, settings, and edge cases to help port the app (e.g., to Electron) or extend it safely.

## Table of Contents
- Overview
- Architecture
- Features
- UI Overview
- Data Flow (Mind Map)
- Back‑End APIs (Key Classes & Functions)
- CNC Status → Nestpick Workflow
- Ready‑To‑Run (R2R) Discovery & Staging
- Jobs Model, Filters, Worklist
- Settings
- Error Handling & Logging
- Edge Cases & Safeguards
- Build & Run
- Linting & Style
- Database Schema Notes
- Testing

## Overview
- Tracks CNC jobs from ingestion to cut/complete using a PostgreSQL database.
- Scans job folders and AutoPAC “status” CSVs (load/label/cnc finish) and updates job status.
- Stages selected jobs to machine R2R folders, copying NC and related assets.
- Forwards parts CSV to Nestpick and reconciles completion/unstack reports.
- Rich QML UI for Jobs, R2R, Alarms, Grundner stock, and Efficiency.

## Architecture
- Frontend: Qt Quick Controls 2 (QML) with a single `StackView` shell (`qml/main.qml`).
- Backend: C++17 Qt objects registered as a typed QML singleton `Backend`.
- Worker thread: `Worker` (aka JobWorker) runs file scans, TCP JSON ingestion (optional), and CSV processing in background.
- Persistence: PostgreSQL; schema validated at startup.

## Features
- Jobs table with filters, search, multi‑select, reserve/unreserve, add to worklist.
- R2R table (per machine): lists files in machine R2R, joins against DB, highlights unknown files.
- Staging: copies NC and associated assets recursively to machine R2R.
- AutoPAC/Nestpick integration:
  - Detects `load_finish*.csv`, `label_finish*.csv`, `cnc_finish*.csv` (case‑insensitive).
  - Forwards `<ncBase>.csv` to Nestpick as `Nestpick.csv` with Destination=99 and SourceMachine=machineId.
  - Waits if a `Nestpick.csv` is already present (1s poll, 5‑min safety).
  - Consumes Nestpick completion (processed/*complete) and unstack report to mark jobs complete and update pallet.
- Machines config persisted in DB and mirrored in settings for compatibility.
- Theming (dark/light), palette, and professional table styling.

## UI Overview
- Top navigation: “Jobs”, Router (per‑machine pages: ReadyToRun, Alarm, Efficiency). Home/Dashboard removed.
- Default landing: Jobs table page (`Pages.JobTablePage`).
- R2R page per machine (`Pages.ReadyToRunTablePage`).

## Data Flow (Mind Map)
```
QML Shell (StackView)
 ├─ JobsPage (QML) ⇄ Backend.jobsModel (C++)
 │   └─ Worker (C++ thread): ScanFilesForNewJobs → Update DB
 ├─ ReadyToRun (QML) → Backend.getJobsForNcFilesInFolder
 │   └─ Worker: sendJobsToMachine(jobKeys, machineId) → copy assets
 └─ AutoPAC Folder Scan (Worker)
     ├─ load/label/cnc_finish*.csv → update job status
     ├─ cnc_finish → forwardToNestpick(jobKey, machine)
     │   └─ write Nestpick/Nestpick.csv (Destination=99, SourceMachine=machineId)
     └─ Nestpick processed/* & Report_NestpickUnstack.csv → finalize jobs/pallet
```

## Exact Data Flow (Deep Dive)

This section describes the runtime behavior step‑by‑step, including file discovery rules, case handling, and state transitions.

1) Jobs Ingestion (ScanFilesForNewJobs)
- Watches the configured Jobs root (`ProcessedJobPath`).
- Discovers job folders and scans recursively for:
  - NC files: `*.nc` (all case variants)
  - Parts count files: `*.pts` or `*.lpt`
- For each NC:
  - `parseNCFile()` extracts material (`ID=...`) and size (`G100 X.. Y.. Z..`), tolerant of format issues.
  - If a matching PTS/LPT is present, `parsePTS_File()` counts rows to infer `parts` (Planit CSV: count non‑empty lines; Alphacam fallback: 2nd line).
  - Builds a unique key `<folder>/<ncBase>` and `INSERT ... ON CONFLICT UPDATE` into `jobs` with `status='PENDING'` (unreserved).

2) Jobs Table (QML)
- `Backend.jobsModel` binds to a `QSqlTableModel` with searchable/filterable columns.
- “ReSync” button calls `Backend.refreshJobs()` which refreshes the model and triggers `Worker::InitTableModelUpdates()` to re‑scan the filesystem and re‑insert missing jobs even if previously deleted from the UI.

3) Staging to R2R (sendJobsToMachine)
- Source resolution: derives the source directory robustly from the jobs root and the DB `folder` value (absolute/relative handled).
- Destination: `ap_jobfolder/<leaf-from-DB-folder>`; created if missing.
- Files copied (recursively) without overwrite:
  - Required: NC (`*.nc` exact name)
  - Associated assets: `<base>.csv`, `<base>*.csv`, `<base>.lpt`, `<base>.pts`, and preview images `<base>.(bmp|jpg|jpeg)` (including wildcards and case variants).
- Planit extras:
  - If an `LPT` exists anywhere under the source job tree, copy the Planit prefix mapping CSV (e.g., `RJT.csv`) by deriving a 3‑letter prefix from `<base>` and searching recursively.
  - Images referenced by Planit mapping CSV are copied when discovered by pattern.
- Safety: existing files in R2R are never overwritten; each skip is logged.

4) AutoPAC Status Scan (ScanForIsCut)
- Watches a single configured AutoPAC folder (`AutoPAC_CSV_Directory`).
- Case‑insensitive detection by scanning all CSVs, classifying by regex:
  - `^load_finish([A-Za-z0-9_-]+)\.csv$`
  - `^label_finish([A-Za-z0-9_-]+)\.csv$`
  - `^cnc_finish([A-Za-z0-9_-]+)\.csv$`
- Stability and dedup:
  - Must remain unchanged for `file_stable_ms` (default 3000ms) before processing.
  - Content hash avoids reprocessing unchanged files. Files modified in the last 10 seconds are forced to reprocess (useful during testing).

5) Status Transitions
- LOAD_FINISH: From `PENDING` or `STAGED` → `LOAD_FINISH`. If the job is unassigned (`machine_id IS NULL`), it is safely assigned to the reporting machine.
- LABEL_FINISH: Only from `LOAD_FINISH` → `LABEL_FINISH`.
- CNC_FINISH: From `LABEL_FINISH` or `LOAD_FINISH` (or `STAGED`) → `CNC_FINISH` and `cut_at=NOW()` with pallet allocation.
  - After `CNC_FINISH`, if `nestpick_enabled`, the job is forwarded to Nestpick (see below).
- Legacy compatibility: the app can interpret some older flows including `CNC_PROCESSING` and `CUT` where present.

6) Forward to Nestpick (forwardToNestpick)
- Compute `stagedDir = <ap_jobfolder>/<leaf-from-DB-folder>`.
- Discover the parts CSV recursively by exact base name: `<ncBase>.csv` (case‑insensitive). This is the only accepted input for Nestpick forwarding.
- Comma‑delimited CSV handling:
  - If the first line is a header that includes `Destination` and `SourceMachine`, write the header unchanged.
  - Modify every data row (including row 0 if no header):
    - `Destination = 99`
    - `SourceMachine = <machine.machineId>` (the DB primary key)
- Write atomically to `<nestpick_folder>/Nestpick.csv`.
  - If `Nestpick.csv` currently exists, wait with a 1s poll until it disappears (max 5 minutes). This cooperates with downstream consumers that require exclusivity.
  - On success, delete the staged source `<ncBase>.csv`, set job `status='FORWARDED_TO_NESTPICK'`, persist `pallet=99`, and emit an event in `job_events`.
- Extensive logging identifies the resolved paths, expected file name, and sample CSVs found during discovery to help diagnose placement.

7) Nestpick Responses (processNestpickOutput)
- Completion: watch `<nestpick_folder>/processed/` for `*_complete.csv`, `*Processed*.csv`, `*_done.csv` (case‑insensitive). For each job in the file, update to `NESTPICK_COMPLETE`, set `nestpick_completed_at=NOW()`, log `job_events`, and archive the file.
- Unstack Report: watch `<nestpick_folder>/Report_NestpickUnstack.csv` (comma). Extract `JobNumber8ASCII` and `Destination` and update `jobs.pallet` accordingly; archive the report.

## File Discovery Rules & Case Handling

- All filesystem matching is case‑insensitive on names and extensions.
- Recursive searches are used for:
  - Source NC and associated assets when staging to R2R
  - Planit mapping CSV (prefix‑based)
  - R2R parts CSV `<ncBase>.csv` for Nestpick forwarding
- DB lookups for `jobs.ncfile` are case‑insensitive using `LOWER(ncfile) = LOWER(?)`.
- Stability windows and hash dedup are used on CSVs in AutoPAC and Nestpick folders.

## Supported Software Producers

Alphacam
- NC + parts CSV generation is supported. Parts CSVs are comma‑delimited.
- Detection uses `isAlphacamPartsCsv()`: header must include `material` or `mat`, and `x` or `width`.
- When forwarding to Nestpick, only `<ncBase>.csv` is accepted; legacy Alphacam fallback (adding `PalletNumber`) is no longer used for forwarding but still supported during staging copy.

Planit
- `.lpt` files indicate Planit labeling; we parse and use the 3rd column per row (label number) to associate images.
- Prefix mapping CSV (e.g., `RJT.csv`) is discovered recursively by 3‑letter prefix and copied to R2R.
- Preview images referenced in mapping are copied when found by pattern (`*.bmp`, `*.jpg`, `*.jpeg`).
- During staging, these are additive assets; forwarding to Nestpick still relies on `<ncBase>.csv`.

Other Producers
- The system is tolerant of mixed case, variable folder layouts, and missing optional files. Core requirement is a valid NC file and, for Nestpick, a matching `<ncBase>.csv` in R2R.

## Status Model & Transitions

States (typical):
- `PENDING` → `STAGED` → `LOAD_FINISH` → `LABEL_FINISH` → `CNC_FINISH` → `FORWARDED_TO_NESTPICK` → `NESTPICK_COMPLETE`

Allowed transitions (enforced in SQL updates):
- `PENDING | STAGED` → `LOAD_FINISH`
- `LOAD_FINISH` → `LABEL_FINISH`
- `LABEL_FINISH | LOAD_FINISH | STAGED` → `CNC_FINISH`
- `CNC_FINISH` → `FORWARDED_TO_NESTPICK`
- `FORWARDED_TO_NESTPICK` → `NESTPICK_COMPLETE`

## Settings Reference (Expanded)

Core Paths
- `ProcessedJobPath`: Root folder to scan for jobs (NC/PTS/LPT). Staging reads from here.
- `AutoPAC_CSV_Directory`: Folder with `*_finish*.csv` from AutoPAC.
- `grundnerFolderPath`: Folder for stock request/response integration (optional).

Theme & UI
- `theme` (dark|light), `feyAccentColor`.

Database
- `dbHost`, `dbPort`, `dbName`, `dbUser`, `dbPassword`.

Machines (mirrored for compatibility; source of truth is DB `machines`)
- `cncMachineCount`: number of entries in `cncMachines`.
- `cncMachines[]`: objects with `name`, `pc_ip`, `pc_port`, `cnc_ip`, `ap_jobfolder`, `nestpick_folder`, `nestpick_enabled`.

Test Mode
- `testDataFolderPath`, `useTestDataMode`.

Grundner
- `grundnerStockRequestFileName` (default `Stock_Request.txt`), `sheetIdMode` (`type_data`|`customer_id`).

## Error Handling & Logging (Expanded)

- Worker emits signals with human‑readable messages; QML displays them in a status area/dialog.
- Key checkpoints logged:
  - Machine configuration & scan setup
  - AutoPAC classification, stability, hashes
  - Status UPDATE SQL result counts
  - Staging copy actions & skips
  - Nestpick CSV discovery diagnostics, including expected file name and sample files found
  - Nestpick write/commit and response processing
- Machine Health Codes: `✓ Ready`, `⚠️ No parts CSV in Ready-To-Run`, `⚠️ Nestpick share unreachable`, `⚠️ File copy failed`, `⚠️ NC file not found`.

## Edge Cases & Safeguards (Expanded)

- Case‑insensitive everywhere for filenames and DB lookups.
- CSV stability (mtime/size unchanged) prior to processing to avoid partial reads.
- Dedup by content hash with a 10‑second “force reprocess if modified” rule.
- R2R staging never overwrites files; graceful skip with logs.
- Nestpick write waits for exclusivity with a 5‑minute safety timeout.
- Unstack report parsing handles both header‑present and headerless single‑line forms.
- Defensive SQL: transactions for multi‑step updates; verifies rows affected; rolls back on mismatch.

## Database Schema Notes (Expanded)

- `jobs` stores `ncfile` without the `.nc` extension.
- Suggested index for performance and case‑insensitive lookups:
  - `CREATE INDEX IF NOT EXISTS idx_jobs_ncfile_lower ON jobs (LOWER(ncfile));`
- `machines` contains `ap_jobfolder`, `nestpick_folder`, `nestpick_enabled` and networking fields used by the worker.
- `job_events` captures transitions with JSON payloads for auditing.

## Porting Notes (Electron)

- Model the `Worker` as a background process/service that:
  - Scans job roots and AutoPAC folders on a timer with jitter and stability windows.
  - Performs recursive file discovery and copy rules for staging.
  - Parses CSVs (comma‑delimited) and updates a DB (PostgreSQL recommended).
  - Emits structured logs and progress events for the UI.
- Ensure DB updates mirror the same transition and verification rules (rows affected checks).
- Preserve the Nestpick write lock behavior: wait if `Nestpick.csv` exists, then atomic write.
- Keep case‑insensitive comparisons for filenames and DB `ncfile`.

## Build, Linting & Testing (Recap)

- Build: Qt 6.10, CMake ≥ 3.24; ensure Postgres reachable and schema applied.
- Lint: `qmllint`, `clang-format`, `clang-tidy` as configured.
- Manual test flows:
  1. Add NC/PTS/LPT under Jobs root; ReSync → jobs appear with metadata.
  2. Stage jobs to a machine; confirm recursive copy of NC/assets to R2R.
  3. Drop `load_finish*`, `label_finish*`, `cnc_finish*` in AutoPAC folder; verify transitions.
  4. Place `<ncBase>.csv` in R2R (root or subfolder); verify forward to Nestpick and that `Destination` and `SourceMachine` are rewritten on every row (including row 0 when headerless).
  5. Copy Nestpick processed completion and unstack reports; verify status and pallet updates; archived files present.

## Back‑End APIs (Key Classes & Functions)

BackendController (src/backend/BackendController.*)
- QML singleton `Backend` with properties for models, themes, folders, machine list.
- `initialize()`: connects DB, sets up models, worker and timers.
- `refreshJobs()`: refreshes model and invokes `Worker::InitTableModelUpdates()`.
- `cncMachines` (QVariantList): machine configs loaded from DB (name, ip, ap_jobfolder, nestpick_folder, enabled flags).
- Jobs actions: `reserveJob`, `unreserveJob`, `addJobToWorklist`, `addJobsToWorklistForMachine` (dispatches to Worker).
- File utilities for UI: `listNcFiles(folder)`, `getJobsForNcFilesInFolder(folder)` (joins on ncfile; adds NOT_IN_DB rows).
- Manual imports: `importNcFileToDatabase(ncFilePath, folderName)`; creates minimal row (STAGED), used for unknown files.

Worker (src/JobWorker.cpp, src/JobWorkerNestpick.cpp)
- Threaded engine for:
  - File scans (jobs folder, AutoPAC status folder).
  - TCP JSON status (optional), Grundner stock sync.
  - Staging to R2R (`sendJobsToMachine`).
  - AutoPAC/Nestpick CSV processing.
- Initialization: `loadMachineConfigurations()`, `initializeScanning()`.
- Jobs ingestion: `ScanFilesForNewJobs()` parses .nc/.pts and inserts/updates jobs.
- AutoPAC scan: `ScanForIsCut()` detects `load/label/cnc_finish*.csv` (case‑insensitive) and calls:
  - `processLoadFinish(csv, machine)` → status LOAD_FINISH (from STAGED/PENDING)
  - `processLabelFinish(csv, machine)` → status LABEL_FINISH (from LOAD_FINISH)
  - `processCncFinish(csv, machine)` → status CNC_FINISH & pallet allocation; then `forwardToNestpick()` if enabled
- Nestpick forwarding: `forwardToNestpick(jobKey, machine)` (details below).
- Nestpick completion: `processNestpickOutput()` reads processed/*complete and Report_NestpickUnstack.csv.

JobsTableModel (src/models/JobsTableModel.*)
- Backed by `QSqlTableModel`. Roles expose key fields (folder, ncfile, material, parts, size, thickness, reserved, status, machine).
- Filtering: by folder/material/size/thickness and “Cut/Uncut” (mapped to status).
/- Search across multiple columns.

## CNC Status → Nestpick Workflow
1) AutoPAC detection
   - Scans the configured AutoPAC folder for `load_finish*.csv`, `label_finish*.csv`, `cnc_finish*.csv` (case‑insensitive).
   - File stability (mtime/size unchanged for configurable window) and dedup by content hash to avoid re‑processing unchanged files.

2) Status updates
   - LOAD_FINISH: assign machine if unassigned; allow PENDING→STAGED→LOAD_FINISH.
   - LABEL_FINISH: require LOAD_FINISH.
   - CNC_FINISH: set `cut_at=NOW()` and allocate pallet (currently fixed 99) and transition (from LABEL/LOAD/STAGED).

3) Forward to Nestpick (upon CNC_FINISH and if machine.nestpick_enabled)
   - Determine staged R2R folder for the job: `<ap_jobfolder>/<leaf-from-DB-folder>`.
   - Search recursively for `<ncBase>.csv` (exact, case‑insensitive). Log search context and sample CSVs if not found.
   - Read comma‑delimited CSV with headers; set for each row:
     - `Destination = 99`
     - `SourceMachine = <machine.machineId>` (DB PK)
   - Write atomically to `<nestpick_folder>/Nestpick.csv`.
   - If `Nestpick.csv` already exists, poll every 1s until free (max 5 minutes) before writing.
   - Delete the staged source CSV after a successful commit. Update job to `FORWARDED_TO_NESTPICK` and log an event.

4) Nestpick response
   - Completion files in `<nestpick_folder>/processed`: `*_complete.csv`, `*Processed*.csv`, `*_done.csv` (case‑insensitive) → mark each job as `NESTPICK_COMPLETE`.
   - Unstack report in `<nestpick_folder>`: `Report_NestpickUnstack.csv` (comma with header). Extract `JobNumber8ASCII` and `Destination` to update `jobs.pallet` and log.
   - All processed reports are archived into an `archive/` subfolder.

## Ready‑To‑Run (R2R) Discovery & Staging
- R2R UI (`Pages.ReadyToRunTablePage.qml`):
  - Computes a machine’s ready folder (ap_jobfolder) and calls `Backend.getJobsForNcFilesInFolder()`.
  - Lists files and DB metadata; shows unknown files as `NOT_IN_DB` in red.
- Staging (`Worker::sendJobsToMachine`):
  - Builds a source directory from configured job folder and the job’s folder.
  - Copies NC file recursively and associated assets recursively:
    - `<base>.csv`, `<base>*.csv`, `<base>.lpt`, `<base>.pts`, `<base>.bmp/jpg/jpeg` (wildcards and case variants).
  - If an LPT exists, attempts to copy the Planit prefix mapping CSV (e.g., `RJT.csv`) recursively.
  - Never overwrites existing files in R2R; logs when skipping.

## Jobs Model, Filters, Worklist
- Jobs table supports:
  - Filters: folder, material, size, thickness, and status (Cut/Uncut mapping).
  - Search across multiple columns.
  - Reserve/Unreserve updates DB and Grundner stock reserved counts atomically.
  - Add to Worklist for a machine → dispatches to Worker to stage files.
  - “ReSync” button triggers a rescan that re‑adds any missing jobs found on disk.

## Settings
- Stored in `settings.json` near the executable (also reflected live in `BackendController`).
- Keys:
  - `ProcessedJobPath` (jobs root), `AutoPAC_CSV_Directory`, `grundnerFolderPath`.
  - Theme: `theme`, `feyAccentColor`.
  - DB: `dbHost`, `dbPort`, `dbName`, `dbUser`, `dbPassword`.
  - Machines: `cncMachineCount`, `cncMachines[]` (mirrored for compatibility, but source of truth is DB `machines`).
  - Test data: `testDataFolderPath`, `useTestDataMode`.
  - Grundner: `grundnerStockRequestFileName`, `sheetIdMode`.

## Error Handling & Logging
- UI shows non‑blocking dialogs for errors; status bar shows transient log messages.
- `Worker` emits `errorOccurred`, `warningMessage`, `statusMessage`, and `logMessage` for key steps.
- File stability checks and deduping prevent transient or repeated processing.
- Machine “health” codes reflect common issues (no NC, copy failed, no CSV in R2R, Nestpick share unreachable).

## Edge Cases & Safeguards
- Case‑insensitive matching for AutoPAC CSV names/patterns and DB `ncfile` lookups.
- Stability window for CSV processing (size/mtime unchanged) to avoid partial reads.
- Dedup by file content hash; force reprocess if modified within 10s (useful during testing).
- R2R never overwrites existing files; logs and continues.
- Nestpick write waits for `Nestpick.csv` to be consumed (1s polling, 5‑minute safety timeout).
- Unstack report parsing falls back to sensible defaults when headers missing and archives reports.

## Build & Run
- Qt 6.10.x (MinGW 64 or MSVC), CMake ≥ 3.24.
- Ensure PostgreSQL reachable and schema applied (see “Database Schema Notes”).
- Run the built executable; `BackendController::initialize()` loads settings, DB, worker thread, and QML.

## Linting & Style
- QML: `qmllint` with builtins; prefer versioned imports where practical.
- C++: `clang-tidy` (`-p build`) and `clang-format -i` on changed files.
- Follow project `.editorconfig`, coding conventions, and Qt best practices.

## Database Schema Notes
- Core tables: `jobs`, `machines`, `history`, `job_events`, `grundner`, `settings`, `cncstats`.
- `jobs.ncfile` stored without `.nc` extension; code strips `.nc` when comparing.
- Suggested index for case‑insensitive matches:
  - `CREATE INDEX IF NOT EXISTS idx_jobs_ncfile_lower ON jobs (LOWER(ncfile));`
- `machines`: `machine_id` (PK), `name`, `pc_ip`, `pc_port`, `cnc_ip`, `ap_jobfolder`, `nestpick_folder`, `nestpick_enabled`.

## Testing
- Unit tests via Qt Test (where present); manual testing flows:
  - Drop AutoPAC `*_finish*.csv` and verify status transitions.
  - Stage jobs to a machine; confirm recursive copy of NC and assets.
  - Place `<ncBase>.csv` in R2R (root or subfolders) and validate Nestpick forwarding.
  - Simulate Nestpick processed and unstack reports and verify job completion and pallet updates.

---

If you are porting to Electron:
- Map `BackendController` APIs to IPC/Node services; keep long‑running scans and file IO off the UI thread.
- Replicate the timed scan loop for AutoPAC and Nestpick folders with file stability checks and content hash dedup.
- Mirror the DB API (PostgreSQL) with prepared statements and case‑insensitive `LOWER(ncfile)` comparisons.
- Preserve the R2R recursive copy rules and Nestpick write‑locking behavior (wait for exclusive `Nestpick.csv`).
