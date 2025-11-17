# Woodtron Desktop — User Manual

This guide explains how to use the Woodtron desktop app end-to-end. It focuses on daily operator tasks, file formats, folder flows, statuses, and the Settings that matter to operators (folders and machines). It is not a developer reference and intentionally omits database setup details.

Use this manual to understand:

- Supported inputs and what is extracted (NC, LPT, PTS, CSV)
- What happens when you stage a job to a machine
- How statuses change over time (PENDING → STAGED → … → NESTPICK_COMPLETE)
- How Nestpick forwarding and completion work
- How the Grundner order saw handshake works (`order_saw.csv` ↔ `order_saw.erl`)
- Where files live across the workflow
- What each page does in the UI and which settings matter

---

## 1) Navigation Overview

Use the left sidebar to access the app’s pages:

- Dashboard: Summarizes active jobs and highlights machine health issues.
- Jobs: Search, filter, reserve/lock, and stage jobs to machines. Shows inline history.
- Router: Lists NC files currently in each machine’s Ready-To-Run folder with status, filters, auto-refresh, Clear Processed, Delete Selected, and CSV export.
- History: Browse completed jobs and see per-job timelines. Supports “Re-run” for a finished job.
- Grundner: View Grundner stock, available, and reserved totals. Filter and export CSV. Edit “Available” where permitted.
- Allocated: List of in-flight allocations mapped to Grundner inventory and job lock state.
- Telemetry: Machine RUN/READY/ALARM time breakdowns over a date range with live updates.
- CNC Alarms: Date- and machine-filtered list of CNC alarm history.
- Settings: Configure folders and machines. Optional database settings are visible here but out of scope for this manual. A Hypernest button is available from the sidebar to open Hypernest externally.

---

## 2) Key Concepts and Supported File Types

### NC files (`.nc`)

- Purpose: The core “sheet” program for routers.
- What we read from NC:
  - Material: From a line like `ID = <material>`. Example: `ID = Plywood_2400x1200`.
  - Size and thickness: From a G-code line starting with G100:
    - Format: `G100 X<length> Y<width> Z<thickness>`
    - Example: `G100 X2400 Y1200 Z18` (units typically mm)
- The app extracts:
  - Size (X×Y), for example `2400x1200`
  - Thickness (Z), for example `18`
  - Material from the `ID` tag
- Notes:
  - Decimals are accepted (e.g., `2400.0`). Display values may be rounded for readability.

### LPT files (`.lpt`) — Planit

- Purpose: Label mapping for Planit exports.
- What the app uses:
  - Reads each line as CSV. The 3rd column is treated as a label number.
  - Label numbers help map label images to parts using CSV hints (see “Images and CSV mapping” in Section 6).

Example accepted (comma-separated; at least 3 columns; numeric 3rd column):

```
PanelA,SomeInfo,101,Extra,Values
PanelB,SomeInfo,102
PanelC,Other,205
```

Example rejected (wrong delimiter or non-numeric 3rd column):

```
PanelX;SomeInfo;101           # uses semicolons — not parsed as CSV
PanelY,SomeInfo,LABEL12       # 3rd column not numeric — ignored
OnlyTwo,Cols                  # fewer than 3 columns — ignored
```

Note: “Rejected” here only affects label-image mapping. Staging still proceeds and images may still be copied by filename prefix (see Section 6).

### PTS files (`.pts`) — Alphacam

- Purpose: Part list for Alphacam exports.
- What the app uses:
  - Counts non-blank lines as the number of parts.
  - Presence of `.pts` puts the job into “Alphacam mode” for staging behavior (details in Section 5).

Example accepted:

```
PART-0001
PART-0002
PART-0003
```

Example rejected (empty or whitespace-only file):

```
   
   
```

### Project CSVs (per-file and family)

- Per-file CSV: `<base>.csv` — specific to the NC base name.
- Family CSV (Planit): `<first three letters>.csv` — shared mapping for a family of jobs.
  - Example: For base `RJT1234`, family CSV is `RJT.csv`.

Example accepted (family CSV used for image mapping):

```
101,r59p0089.bmp
102,label_102.jpg,alt_102.jpeg
103,images/r60p0001.bmp
```

Example rejected:

```
Label,Image             # header or non-numeric — row ignored
A12,some.txt            # no .bmp/.jpg/.jpeg tokens — no image mapping
101;r59p0089.bmp        # semicolons — not parsed as CSV columns
```

Note: If no usable tokens are found, the app falls back to a `<base>.txt` Planit mapping (if present) or copies images that match the NC base prefix (see Section 6).

### Images (`.bmp`, `.jpg`, `.jpeg`)

- Automatically copied during staging:
  - Any image that shares the NC base prefix (e.g., `sheet1*.bmp|jpg|jpeg`)
  - For Planit, image file names can also be found via CSV mapping (see Section 5 and 6).

---

## 3) Job Lifecycle and What Statuses Mean

Jobs move through an easy-to-follow sequence. You will see these in the Jobs, Router, and History views.

- `PENDING`
  - Newly ingested or reset jobs. Available to stage.
  - Can be “Pre-Reserved” for material planning and can be “Locked” (lock is for PENDING jobs only).
- `STAGED`
  - Job has been staged to the machine’s Ready-To-Run folder.
- `LOAD_FINISH`
  - Recorded from AutoPAC CSVs to indicate the sheet was loaded.
- `LABEL_FINISH`
  - Recorded from AutoPAC CSVs to indicate labeling finished.
- `CNC_FINISH`
  - Recorded from AutoPAC CSVs to indicate CNC process finished for the sheet.
- `FORWARDED_TO_NESTPICK`
  - The job’s CSV was forwarded to Nestpick (the app writes `Nestpick.csv` in the machine’s Nestpick folder).
- `NESTPICK_COMPLETE`
  - Nestpick processed/unstack data confirms the sheet completed. Completed jobs are hidden from the Jobs view.

Notes:

- Transitions are ordered. For example, `NESTPICK_COMPLETE` only occurs after forwarding to Nestpick.
- Leaving `PENDING` automatically clears the “Pre-Reserved” flag.
- On `NESTPICK_COMPLETE`, any lock on the job is automatically cleared.

---

## 4) Where Files Live (Folders and Data Flow)

Configure these folders in Settings (see Section 8). Here’s how the system uses them:

### Processed Jobs Root

- Where the app discovers NC jobs.
- The app reads NC files to extract material, size (from G100), thickness (from G100), and counts parts via `.pts`/`.lpt` if present.
- Jobs appear in the Jobs view after ingestion.

### Machine “AP Job Folder” (Ready-To-Run)

- Staging destination when you add a job to a machine.
- The app copies NC + associated files (LPT/PTS/CSV/images). See Section 5 for the rules.
- The app records `STAGED` and history events.

### Grundner Folder (Order Saw and Stock)

- Order saw handshake: used to place an order CSV (`order_saw.csv`) and wait for an acknowledgement file (`order_saw.erl`). The app verifies the `.erl` content matches the order, records an event that it was checked, and deletes the `.erl` file after processing.
- Stock sync: periodically drops a `stock_request.csv` and ingests `stock.csv` replies to maintain Grundner inventory and reserved/available counts.

### AutoPAC CSV Directory

- The app watches this folder for “finish” CSVs named with a machine token (e.g., `load_finish<Machine>.csv`).
- On valid CSVs, the app marks `LOAD_FINISH`, `LABEL_FINISH`, or `CNC_FINISH` accordingly.

### Machine “Nestpick Folder”

- After staging, the app finds the staged CSV and forwards it (rewritten) to `Nestpick.csv` here. Status becomes `FORWARDED_TO_NESTPICK`.
- The app watches this folder for Nestpick “processed” and “unstack” reports. Those update the job to `NESTPICK_COMPLETE` and record pallet/source place information, then move those reports to `archive`.

---

## 5) Staging a Job (Jobs → Machine)

From the Jobs page:

1. Select one or more jobs.
2. Choose “Add to Worklist” and pick a machine.

### What staging does

- Copies the NC file.
- Copies associated files:
  - Planit mode (when `.lpt` exists):
    - Copies `<base>.lpt`
    - Copies `<base>.csv` if present
    - Copies the family CSV `<prefix>.csv` (first 3 letters) if present, or reuses a previously staged copy
    - Parses `.lpt` (3rd column = label #) and the family CSV to locate label images; places images next to the NC file
    - If no usable mapping tokens exist in the CSV, looks for `<base>.txt` (pipe-delimited; 3rd column contains image path), stages that file, and copies referenced images if found
  - Alphacam mode (when `.pts` exists):
    - Copies `<base>.pts`
    - Copies images whose names start with `<base>`
  - Generic mode (no `.lpt` or `.pts`):
    - Copies images whose names start with `<base>`
  - In all modes:
    - If `<base>.csv` is found, it’s copied
    - Images matching the NC base prefix are copied
- Avoids overwriting certain files (for example, an existing family CSV in the destination) to preserve mappings.
- Sets job status to `STAGED` and records a `worklist:staged` event with copy details.

### Grundner order saw handshake (after staging)

- The app writes `order_saw.csv` into the Grundner folder and waits for `order_saw.erl`.
- It verifies that the `.erl` exactly matches the order content, records a `grundner:erlChecked` event (including confirmation status and that the file was deleted), and removes the `.erl` file after checking.
- You’ll see a confirmation dialog if the order is acknowledged. If it times out or mismatches, you’ll see a warning.

### Forwarding to Nestpick (after staging)

- The app finds the staged CSV and rewrites it for Nestpick:
  - Adds/sets two columns: `Destination = 99` and `SourceMachine = <machineId>`
  - Outputs `Nestpick.csv` to the machine’s Nestpick folder
- Job status becomes `FORWARDED_TO_NESTPICK` and the original staged CSV is removed.

### Completion (Nestpick)

- The app watches the Nestpick folder for two kinds of reports:
  - “Processed” reports: Marks `NESTPICK_COMPLETE` and archives the report.
  - “Unstack” reports: Updates the job pallet (source place), records a `nestpick:unstack` event, and marks `NESTPICK_COMPLETE`. The file is archived.

### Staging re-runs

- If you add to worklist a job that is not PENDING, or you choose a different machine while a job is already STAGED, the app will create a re-run (run2, run3, …) copy of the source files and stage that run to the selected machine.

---

## 6) CSV Formats (What’s Expected)

### A) Grundner Order Saw: `order_saw.csv`

- Location: Settings → Paths → Grundner Folder
- One row per job
- Semicolon-separated, no header
- Columns:
  1. NC file name (with `.nc`)
  2. Material name
  3. Quantity (always 1)
  4–10. Placeholders (0)
- Example:

```
sheet1.nc;Plywood_2400x1200;1;0;0;0;0;0;0;0;
```

- A matching acknowledgement `order_saw.erl` should appear with exactly the same content. The app checks and deletes it after verification and records an event.

### B) Grundner Stock Sync: `stock_request.csv` / `stock.csv`

- Location: Settings → Paths → Grundner Folder
- The app periodically writes `stock_request.csv` and ingests `stock.csv` (if present) to update Grundner inventory totals and available/reserved values.

### C) AutoPAC CSVs (to set LOAD/LABEL/CNC finish)

- Location: Settings → Paths → AutoPAC CSV Directory
- File naming:
  - `load_finish<Machine>.csv` — sets `LOAD_FINISH`
  - `label_finish<Machine>.csv` — sets `LABEL_FINISH`
  - `cnc_finish<Machine>.csv` — sets `CNC_FINISH`
- Format rules:
  - Must contain commas or semicolons
  - Should have multiple columns (not single-column lists)
  - The machine token in the file name must also appear in the CSV content
  - First column must contain NC base names (with or without `.nc`)
- Minimal example (commas or semicolons accepted; header optional):

```
NC,Machine
sheet1,RouterA
sheet2,RouterA
```

- Invalid files are deleted, and you’ll see an on-screen alert describing the issue.

### D) Nestpick Forwarded CSV (`Nestpick.csv`)

- Location: Machine → Nestpick Folder
- The app rewrites your staged CSV and outputs a combined CSV where:
  - A header row is set (or detected) and the following columns are ensured:
    - `Destination = 99`
    - `SourceMachine = <machineId>`
  - For files without a header, those values are applied on each row.
- You do not need to create this file manually; the app produces it from your staged CSV.

---

## 7) Locking and Reservation

### Reserve

- Use to earmark material while a job is still `PENDING`.
- Only `PENDING` jobs can be reserved.
- Leaving `PENDING` automatically clears the reserve flag.

### Lock

- Use to prevent changes while still in `PENDING`.
- Only `PENDING` jobs can be locked.
- Locks are automatically cleared when a job reaches `NESTPICK_COMPLETE`.

> Tip: If a job is already `STAGED` (or later), it cannot be manually locked. Use Reserve/Lock while still `PENDING` if you need to protect it.

---

## 8) Settings (Machines and Folders)

Open the Settings page to manage folders and machine details. Database settings are visible but out of scope for this manual.

### Paths

- Processed Jobs Root
  - Folder where the app discovers new jobs by scanning for `.nc` files.
  - The app reads NC content (`ID` = material, `G100 X/Y/Z`) and counts parts via `.pts`/`.lpt`.
- AutoPAC CSV Directory
  - Folder the app watches for AutoPAC CSVs:
    - `load_finish<Machine>.csv`, `label_finish<Machine>.csv`, `cnc_finish<Machine>.csv`
  - Validates those files and updates job lifecycle accordingly.
- Grundner Folder
  - Folder for the order saw handshake and stock sync:
    - Order saw: App writes `order_saw.csv`, waits for `order_saw.erl`, verifies contents, logs the check, and deletes it
    - Stock sync: App drops `stock_request.csv` and ingests `stock.csv` if present
- Test Data Folder (optional)
  - Used only when “Use test data mode” is enabled. For QA/demo purposes.

### Test / Grundner Options

- Use test data mode
  - Toggles test/demo behavior in certain screens.
- Sheet ID Mode
  - Affects how material keys are looked up for stock (e.g., `type_data` vs `customer_id`). Choose what matches your environment.
- Grundner Reserved Mode
  - `delta`: Apply increases/decreases relative to current reserved values.
  - `absolute`: Set reserved values to the provided totals exactly.

### Machines

- Name
  - Display name in the UI.
- CNC IP
  - Optional field that links telemetry rows to a machine. Set it to the host reported by the cncstats collector for accurate mapping.
- AP Job Folder
  - Ready-To-Run location for staged files.
- Nestpick Folder
  - Where the app writes `Nestpick.csv` and reads processed/unstack reports. Must be accessible to the Nestpick system.
- Nestpick Enabled
  - Toggle forwarding on/off. When disabled, the app does not send CSVs to Nestpick for that machine.

---

## 9) Page Reference

### Jobs

- Search and filter by quick status (cut/uncut), specific status, material, and machine.
- Pre-Reserve / Unreserve and Lock / Unlock are available from the right-click menu (PENDING-only rules enforced).
- Add to Worklist stages the selected jobs to the chosen machine. If the job is not PENDING or is already staged to a different machine, the app performs a re-run and stages the new run.
- Inline History drawer shows recent events for the selected job (status changes, Nestpick, AutoPAC, etc.).

### Router (Ready-To-Run)

- Lists `.nc` files present in each machine’s AP Job Folder with job linkage, material, size, parts, status, staged date, and whether the NC exists in the database.
- Filter by machine and status; enable auto-refresh and choose an interval.
- Actions:
  - Clear Processed: hides completed items already seen (per-session) so the list stays focused.
  - Delete Selected: removes matching assets for selected jobs (NC/CSV/LPT/PTS/images/mapping TXT) and prunes empty folders.
  - Export CSV: downloads the current view as CSV.

### History

- Browse completed jobs with filters (search, machine, date range, and limit).
- Per-job timeline shows key milestones (Imported, Staged, CNC Finish, Nestpick Complete, Finished) and events.
- “Re-run” creates a new run for the selected job to be re-ingested and optionally restaged later.

### Telemetry

- Live summarized RUN/READY/ALARM/B-STOP/OTHER time breakdowns by machine over a date range.
- Filter the date range and select specific machines.
- Note: For mapping to work, a machine’s CNC IP should match the cncstats API host recorded in `public.cncstats`.

### CNC Alarms

- Shows alarm history with date range and machine filters.
- Columns include Date/Time, Alarm ID, Description, Machine, and Duration (min).

### Grundner

- View Grundner stock and allocation details using the configured Sheet ID Mode (type_data or customer_id).
- Filters: search, only available, only reserved; adjustable limit.
- Edit “Available” where permitted. Export CSV of the current table.
- Updates live when the backend ingests new `stock.csv` data.

### Allocated Material

- Lists allocations tied to jobs: Type, Customer ID, Folder, NC, Dimensions (L×W×T), Status (Pre-Reserved or Locked), Stock, Available, Allocated Date.
- Updates live when allocations or Grundner stock change.

### Dashboard

- Highlights active jobs (STAGED, LOAD/LABEL/CNC FINISH, FORWARDED_TO_NESTPICK) and aggregates machine health issues.

### Settings

- Configure Processed Jobs Root, AutoPAC CSV Directory, Grundner Folder.
- Manage machines (name, folder paths, optional CNC IP, Nestpick toggle). Path fields are validated inline and show status.
- Test options include Test Data Folder, Use test data mode, Sheet ID Mode, and Grundner Reserved Mode (delta/absolute).
- Database settings show connectivity status and latency (informational for operators).

---

## 10) Troubleshooting Tips

- Nothing appears in Jobs:
  - Check Processed Jobs Root is set and reachable
  - Ensure it contains `.nc` files
- Staging says NC not found:
  - Ensure the job’s `ncfile` exists in the source folder (same folder structure the app discovered it from)
- Grundner timeout:
  - If `order_saw.erl` doesn’t appear, you’ll see a “Timed out” warning. Confirm Grundner Folder path and the external system are correct.
- AutoPAC errors:
  - The app deletes invalid CSVs and shows a banner explaining the problem. Check file name, machine token inside the file, and first column (NC base).
- Nestpick not updating:
  - Confirm the machine’s Nestpick Folder exists and is reachable
  - Make sure Nestpick Enabled is “Yes” for that machine
  - Ensure a staged CSV exists under the AP Job Folder to forward
- Telemetry page empty:
  - Ensure each machine’s PC IP matches the host string stored in `public.cncstats.pc_ip` and that `machine_name` aligns with the machine Name in Settings.
  - For test scenarios, enable “Use test data mode” and point to a folder with valid JSON/CSV telemetry samples.

---

## 12) Reference: Sample Formats

### G100 in NC

```
ID = Plywood_2400x1200
G100 X2400 Y1200 Z18
```

### `order_saw.csv` and `order_saw.erl` (acknowledgement)

```
sheet1.nc;Plywood_2400x1200;1;0;0;0;0;0;0;0;
```

> The `.erl` file should exactly match the content above. The app checks it, records an event that it was checked, then deletes it.

### AutoPAC CSV (minimal)

```
NC,Machine
sheet1,RouterA
sheet2,RouterA
```

---

## 13) Practical Workflow Checklist

1) Confirm Settings:
   - Processed Jobs Root, AutoPAC CSV Directory, Grundner Folder
   - For each machine: AP Job Folder, Nestpick Folder (if using Nestpick), Nestpick Enabled

2) Jobs appear automatically from Processed Jobs Root.
   - Reserve and/or Lock while `PENDING` (if you need to protect a job)

3) Add to Worklist → pick a machine.
   - Files copy to that machine’s AP Job Folder
   - Job becomes `STAGED`
   - The app sends `order_saw.csv`, checks and deletes `order_saw.erl`, and records that check

4) The app forwards `Nestpick.csv` automatically (if enabled and a CSV is available).
   - Job becomes `FORWARDED_TO_NESTPICK`

5) As production proceeds:
   - AutoPAC CSVs mark LOAD/LABEL/CNC finish
   - Nestpick processed/unstack reports mark `NESTPICK_COMPLETE` (and update pallet)

6) Use Router view to verify what’s staged or clean up artifacts.

