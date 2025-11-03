# NestWatcher To‑Do

Scope: Jobs table behavior, message rules, and archive/rerun flows. Each item includes concrete tasks and edge cases to watch for.

## 1) Keep completed jobs visible in Jobs table

- Current: Backend excludes completed jobs from Jobs view via a hard filter in `packages/main/src/repo/jobsRepo.ts` (`status <> 'NESTPICK_COMPLETE'`).
- Change: Remove that exclusion so completed rows remain visible alongside others.
- UI: No default hiding; keep existing filters working. Sorting and selection should continue to behave.

Acceptance
- Jobs with `CNC_FINISH` and `NESTPICK_COMPLETE` appear in `/jobs` list. - Taking into account the machine setting for Nestpick enabled.
- Row count and pagination still function; auto-refresh preserves visibility.

Implementation Notes
- Edit `listJobs()` to drop the `NESTPICK_COMPLETE` where-clause.
- Verify `JobsPage` renders all `JobStatus` values (badges already support all statuses).

Edge Cases
- Performance: Slightly larger result sets; keep limit and sorting intact.
- Status regressions: If a job reverts (rerun), it should no longer look completed.
- Locked and preReserved flags: ensure visuals remain correct for completed rows.
- Machine-less rows: Rows with `machineId = null` must still render and sort.

## 2) Add "Clear Completed" button in Jobs table (top-right)

- Button: `Clear Completed` in `packages/renderer/src/pages/JobsPage.tsx` header area.
- Behavior: Hide completed rows from the current view without deleting files or rows.
  - If the machine has Nestpick: hide rows in `NESTPICK_COMPLETE`.
  - If the machine does not have Nestpick: hide rows in `CNC_FINISH`.
- Scope: Applies to current view/session (client-side); do not modify DB.

Acceptance
- Clicking the button immediately removes matching completed rows from the table.
- New data loads honor the “cleared” state until the user resets it (e.g., page reload or a “Show Completed” quick toggle if we add one).

Implementation Options
- Simple client-side filter: build a map from `machineId -> nestpickEnabled` (already loaded in `JobsPage`) and filter rows before rendering. Persist a boolean in `localStorage` (e.g., `jobs:hideCompleted=true`).
- Server-side alternative (optional): add a request flag like `excludeCompletedByMachine` and apply a conditional where-clause using a join on `machines`. This keeps payloads lighter but requires API and repo changes.

Edge Cases
- Mixed-machine view (no machine filter): The filter is per-row using each row’s `machineId` to decide which status to hide.
- Unknown machine for a row (`machineId = null`): Treat as non-Nestpick and hide `CNC_FINISH`, or leave visible; pick one behavior and document it. Suggest: hide `CNC_FINISH` for null.
- Auto-refresh: Keep the hide-completed flag applied on refresh.
- Paging: If server still returns completed rows, client-side filter may yield fewer-than-expected rows; acceptable for simplicity or switch to server-side filter.

## 3) Message rules by machine Nestpick capability

- Goal: If machine has Nestpick, show a completion message only when the job hits `NESTPICK_COMPLETE`. If machine does not have Nestpick, show the `CNC_FINISH` completion message. Currently, we emit `cnc.completion` broadly.

Acceptance
- Nestpick-enabled machines: Do not emit a final “CNC complete” message at `CNC_FINISH`; emit a completion message when the job transitions to `NESTPICK_COMPLETE` (from Nestpick processed/unstack flows).
- Non-Nestpick machines: Emit `cnc.completion` on `CNC_FINISH` as today.

Implementation Notes
- In `watchersWorker.ts` AutoPAC flow, gate `emitAppMessage('cnc.completion', ...)` behind `!machine.nestpickEnabled`.
- In Nestpick completion flows (`handleNestpickProcessed` and `handleNestpickUnstack`): after a successful `updateLifecycle(..., 'NESTPICK_COMPLETE', ...)`, push a message. Options:
  - Reuse `nestpick.success` with clarified title/body (may imply “exported”), or
  - Add a new message key like `nestpick.completed`: “Nestpick completed for {{ncFile}} on {{machineName}}.”
- Ensure History already computes `finishAt` correctly (it does: Nestpick vs Cut by machine setting).

Edge Cases
- Double emits: When both processed and unstack flows run, guard against duplicate completion messages (e.g., only emit if lifecycle changed or by deduping on job+timestamp).
- Unknown machineId at event time: Include best-effort machine name; otherwise omit it gracefully.
- Jobs for Nestpick-enabled machine that never reach `NESTPICK_COMPLETE`: they will not show a “final” message; intermediate messages (e.g., forwarded to Nestpick) still allowed.

## 4) Archive folder + rerun from archive

Create an archive area and move completed job assets there. Use it as a source for reruns when the original processed folder no longer contains the files.

Triggers
- Nestpick-enabled machines: on `NESTPICK_COMPLETE`, archive the job assets (BNP/LPT/PTS, NC, images, CSV, TXT as applicable).
- Non-Nestpick machines: on `CNC_FINISH`, archive the NC and associated files.

Destination & Structure
- Add a configurable `archiveRoot` under Settings (e.g., `settings.paths.archiveRoot`). Default could be `${processedJobsRoot}/_archive` if not set.
- Place files under `archiveRoot/<folderLeaf>` where `<folderLeaf>` is the job’s original folder leaf (same as used for Ready-To-Run staging). Preserve subfolder structure relative to the job’s source root.
- If `archiveRoot/<folderLeaf>` exists, reuse it; do not create a timestamped folder.

Copy/Move Semantics
- If possible, move (`rename`) files; if cross-volume or locked, fallback to copy+delete.
- Overwrite rules: If the destination already has the same-named file, overwrite the NC and associated files. Keep parity with staging overwrite patterns:
  - Overwrite: `.nc`, `.lpt`, `.pts`, images (`.bmp`, `.jpg`, `.jpeg`), `.csv`, `.txt` (when associated).
  - Preserve anything outside the associated set unless we are intentionally updating the same file.

Rerun from History
- Update `packages/main/src/services/rerun.ts`:
  - When rerun files are missing in `processedJobsRoot/<relDir>`, look in `archiveRoot/<folderLeaf>` for `<base>.*` and copy them back into the processed directory using `runN_` prefix logic (existing implementation already handles prefixing). Create the processed folder if missing.
  - If the processed folder already exists, place the new `runN_` files into that folder (do not create a new sibling directory).
- Update `jobs:rerun` IPC as needed to surface clearer errors when neither processed nor archive sources exist.

Acceptance
- Completed jobs’ assets are present in the archive with correct overwrites.
- Subsequent reruns from History succeed even when source files were archived.
- Rerun uses `runN_` naming (`run2_`, `run3_`, …) and inserts/updates the corresponding DB row (current `rerunAndStage` flow already does this for staging).

Implementation Notes
- Source root resolution: Reuse `resolveSourceRoot()` logic in `worklist.ts` to find the job’s source directory under the processed root; then archive relative to that.
- Record a `job event` like `archive:completed` with a file list for traceability.
- Add minimal retries for file-in-use errors (Windows), using the existing stable-file helpers where appropriate.

Edge Cases
- Permissions or path length issues when creating/renaming archive folders (Windows): retry or surface a clear message.
- Jobs without a resolvable source folder (e.g., hand-edited DB): skip archive and log a watcher warning.
- Nested or shared assets: only move files that match the job’s base (and known associated types), preserve unrelated siblings.
- Duplicate folder names for unrelated jobs: collision is expected to be “merge into existing folder”; ensure we don’t remove unrelated files.
- Case-insensitive filesystems: ensure base/extension matching handles case differences.
- Archive disabled/unset: If `archiveRoot` is not configured and default cannot be created, skip archive with a message and continue normal lifecycle.

---

Out of Scope (for now)
- Backfilling existing completions into the archive.
- Admin UI to manage/archive/unarchive jobs.
- Bulk rerun from archive.

## 5) Ordering tab (new left‑nav page)

Goal
- Add an `Ordering` tab in the sidebar. It shows materials that are short based on PENDING jobs vs Grundner available stock.

Data & Computation
- Required per material: count PENDING jobs grouped by material key.
  - Use the same material keying as Grundner reserved logic: `getGrundnerLookupColumn()` deciding between `type_data` and `customer_id`.
  - For jobs with empty/unknown material, either skip or show under “Unknown”; recommendation: show as “Unknown” row so shortages are visible.
- Available stock: controlled by a new setting (see below). Default uses Grundner `stockAvailable` as-is.
- Show only rows where `stockAvailable` is less than required.

Table Columns
- Type Data | Customer ID | Available Stock | Stock Required | Order Amount | Ordered | Comments
  - Order Amount = max(0, Required − Available)
  - Ordered: a tick control (green tick emoji ✅) that, once set, is locked so others see it as ordered and cannot edit unless unlocked by the same user or an admin.
  - Comments: free‑text input (max 20 chars) for notes (name, order number, etc.). Enforce limit in UI and IPC.

Setting: Include reserved stock in Ordering Table
- Add boolean app setting `ordering.includeReserved` (label: “Include reserved stock in Ordering Table”). Default: off.
- Computation when ON:
  - Effective Available = max(0, (stock ?? stockAvailable ?? 0) − (reservedStock ?? 0) − lockedCount)
  - Display a separate “Reserved” column (showing `reservedStock`) and optionally a “Locked” column (derived from `jobs.is_locked` aggregation) if helpful.
- Computation when OFF:
  - Effective Available = `stockAvailable` (fallback to `stock − lockedCount` if `stockAvailable` is null).
  - Hide the “Reserved” column in the UI (data can still be returned by IPC and ignored client‑side).
- Locked definition: `lockedCount` = number of jobs with `jobs.is_locked = true` mapped to that Grundner key (all statuses except fully archived/completed, or include all — pick one policy; recommendation below).

Navigation & UI
- Add left‑nav link in `packages/renderer/src/components/AppSidebar.tsx` (after Grundner) → `/ordering`.
- Add route in `packages/renderer/src/main.tsx` to render `OrderingPage`.
- Implement `packages/renderer/src/pages/OrderingPage.tsx` using the shared table components. Support:
  - Refresh, search by material/customer ID, CSV/PDF export buttons.
  - Live updates: poll or subscribe if we later add an IPC channel for changes.

IPC & Backend
- Add IPC endpoints:
  - `ordering:list`: returns rows with fields: `id` (grundner id), `typeData`, `customerId`, `stockAvailable`, `reservedStock`, `required`, `orderAmount`, `orderedBy`, `orderedAt`, `comments`.
  - `ordering:update`: body { id, ordered?: boolean, comments?: string }. Enforce locking rules.
  - `ordering:exportCsv`: returns a CSV string or writes to a chosen path.
  - `ordering:exportPdf`: renders a PDF to a chosen path.
- SQL for required counts: `SELECT material, COUNT(*) FROM public.jobs WHERE status = 'PENDING' GROUP BY material` plus mapping to Grundner key via `sheetIdMode`. Join to `public.grundner` on the chosen key.
- Settings wire‑up: surface `ordering.includeReserved` in Settings UI; persist in Settings schema; Ordering list handler reads it and applies the availability formula above. Always include `reservedStock` in the response; renderer hides/shows column based on setting.

State & Locking
- Persistence: create `public.ordering_status` table (or extend `public.grundner`) to track UI flags across users:
  - Columns: `grundner_id` (PK/FK), `ordered` boolean, `ordered_by` text, `ordered_at` timestamptz, `comments` varchar(20), `updated_at` timestamptz.
  - Unique on `grundner_id`.
- Lock semantics:
  - First user to tick sets `ordered=true`, records `ordered_by` (OS username or workstation name), timestamp.
  - Other users cannot change `ordered` unless they are the owner or an admin override (optional future flag). Provide a clear error message on conflict.
  - Optionally add a TTL/override path for stale locks (recommendation below).

Export (CSV/PDF)
- CSV: simple header row + table rows. Offer file save dialog.
- PDF: use Electron `webContents.printToPDF` on a headless window rendering the same table with print CSS for A4 portrait, one‑page width. Scale font/column widths to fit; wrap long values; truncate comments to 20 chars.

Acceptance
- Ordering tab appears and loads within 1–2s.
- Only materials where `Available < Required` are listed with computed `Order Amount`.
- Ticking Ordered reflects instantly for other clients; only owner can untick/change comments.
- Comments enforce 20‑char limit and persist.
- CSV and PDF exports produce accurate snapshots and fit A4 width (PDF).

Recommendations & Possible Issues
- Available vs Reserved: If `stockAvailable` already nets out reserved, the ON formula will still be safe (subtracting `reservedStock` results in a conservative number). Document which CSV/source field semantics we rely on.
- Material key mismatches: Some `jobs.material` values may not match Grundner keys (format, casing). Normalize (trim, case‑insensitive), and, for `type_data`, ensure numeric parse; otherwise show as “Unknown”. Surface a warning count somewhere.
- Concurrency: Two users could tick at once. Use a single `UPDATE ... WHERE grundner_id = ? AND ordered = false` pattern to ensure only one succeeds; return conflict to the loser.
- Stale locks: Consider auto‑unlock after N hours or allow admin to clear in DB. Log `ordered_at` for audit.
- Performance: Counting PENDING jobs per material is cheap but do it server‑side with a single grouped query. Cache for a few seconds if needed.
- Permissions: No auth exists; `ordered_by` is best‑effort (OS username). Consider adding a lightweight “User Name” setting in app settings for clearer attribution.
- PDF layout: Long tables may span >1 page; requirement says fit width to one page, but height may paginate. Ensure headers repeat on new pages; test dark/light themes for contrast.
- Live data: If Grundner updates while page is open, numbers might change. Either auto‑refresh or indicate last updated timestamp.
- Locked policy: Whether `lockedCount` should include only active jobs (e.g., `PENDING`/`STAGED`) or also historical locks. Recommendation: count only non‑completed jobs to reflect near‑term consumption.
