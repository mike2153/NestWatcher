# Watcher Reliability Todo

Goal

- Make Watchers virtually uncrashable.
- Network folders going offline must never freeze the app or spam logs.
- Operators should get clear, actionable feedback with minimal noise.
- All watcher-read files are handled deterministically:
  - success equals archive
  - failure equals incorrect_files

Core Rules

1) Exponential backoff capped at 60 seconds

- Retry delays:
  - 7.5 seconds
  - 15 seconds
  - 30 seconds
  - 60 seconds
  - 60 seconds forever

2) Popup and Messages notification pattern for retryable failures

- First failure of an episode
  - Show one popup dialog describing what happened and what to check.
  - Write one persistent Messages entry with the same details.
  - Update Diagnostics watcher status text.
- During retries
  - No more popups.
  - Update Diagnostics status text with retry schedule and time of day.
- Entering long retry mode
  - When backoff first reaches the 60 second cap, show one popup.
  - Write one persistent Messages entry.
- Recovery
  - When the condition clears and the watcher successfully continues, show one popup.
  - Write one persistent Messages entry.

Episode state

- Track episode state per stable key, for example:
  - watcher name plus folder path
  - watcher name plus machineId
  - watcher name plus file name

3) Watcher error status vs watcher event status

- Use watcher error status only for real offline or broken conditions:
  - example: network share unreachable
  - example: chokidar error
  - example: stat probe fails
- Do not mark a watcher as error for workflow backpressure:
  - example: ChangeMachNr.csv exists and we are waiting

4) Strict file matching and no subfolder traversal

- Each watcher root folder must only look for its expected files.
- If a file name does not match what the watcher expects, the watcher must not touch it.
- Watchers must not traverse subfolders for "single file drop" integration folders:
  - AutoPAC CSV Directory
  - Machine Nestpick Folder
  - Grundner Folder Path
  - Watch the configured folder only.
  - Ignore archive and incorrect_files subfolders.
  
Allowed traversal

- Jobs Root watchers are allowed to traverse because job folders can be nested.
- Test data watcher is allowed to traverse.

5) File disposition policy

For any watcher root folder ROOT:

- ROOT/archive
  - successful processed files
- ROOT/incorrect_files
  - invalid format
  - unexpected contents
  - mismatched replies

Rules

- Success equals archive
- Failure equals incorrect_files
- Timestamp naming
  - keep the same timestamp format used today: dd.mm_hh.mm.ss

Systematic Work List

- AutoPAC CSV Directory watcher
  - Only process files that match:
    - load_finish*.csv
    - label_finish*.csv
    - cnc_finish*.csv
    - order_saw*.csv
  - Any invalid AutoPAC CSV goes to AutoPAC CSV Directory/incorrect_files
  - Any successfully processed AutoPAC CSV goes to AutoPAC CSV Directory/archive
  - Ignore AutoPAC CSV Directory/archive and AutoPAC CSV Directory/incorrect_files
  - Apply offline retry pattern to AutoPAC CSV Directory being unreachable

- Grundner Folder Path
  - Any Grundner CSV or ERL we read:
    - success goes to Grundner Folder Path/archive
    - mismatch or invalid goes to Grundner Folder Path/incorrect_files

- Machine Nestpick Folder
  - Only watch and read:
    - Nestpick.erl
    - Report_FullNestpickUnstack.csv
  - Any mismatch or invalid file content goes to Machine Nestpick Folder/incorrect_files
  - Any successfully processed file we read goes to Machine Nestpick Folder/archive

- Stage sanity poller
  - Keep retry and backoff behavior, but cap at 60 seconds.
  - Popups must not spam when multiple machines are offline.

- Source sanity poller
  - Keep retry and backoff behavior, but cap at 60 seconds.

- Jobs ingest poller
  - Keep retry and backoff behavior, but cap at 60 seconds.

- NC-Cat and Geist
  - Out of scope. Existing quarantine logic stays.

UI and Database Work

- Jobs table view hiding rule
  - Folder group is job.folder.
  - Hide completed jobs only when the entire job.folder group is complete.
  - Completion definition:
    - Nestpick enabled machine: complete at NESTPICK_COMPLETE
    - Non-Nestpick machine: complete at CNC_FINISH

- Router page context menu
  - Context menu exists only on the Router page.
  - Menu label is Change Status.
  - Modal requires:
    - reason text box
    - dropdown of forward-only statuses after current status
  - Save an audit record:
    - add a JSONB column on jobs to store manual lifecycle pushes
    - also record a job event

Implementation Notes

- Prefer shared helpers:
  - capped backoff calculator
  - move to archive with timestamp
  - move to incorrect_files with timestamp
  - ignore archive and incorrect_files
  - per episode popup rules

Status Snapshot

- Done
  - AutoPAC watcher: strict file match, depth 0 only, archives or quarantines (never deletes), offline retry.
  - Grundner replies and CSV: archive on success, incorrect_files on mismatch or invalid.
  - Nestpick watcher: watches only `Nestpick.erl` and `Report_FullNestpickUnstack.csv` (no folder traversal) and archives or quarantines.
  - Stage sanity poller: capped backoff at 60 seconds.
  - Source sanity poller: capped backoff at 60 seconds.
  - Jobs ingest poller: capped backoff at 60 seconds.
  - Offline notifications: episode model (first failure, long retry mode, recovery).
  - Jobs table hiding rule: hide only when entire folder group is complete.
  - Router Change Status: Router-only context menu with forward-only statuses + required reason + audit trail.
  - Router Change Status modal spacing: larger modal and padded layout.
  - Ready To Run folder subscription watcher: allowed to traverse job folders.

- Allowed traversal by design
  - NC-Cat jobs watcher: depth 10 under Jobs Root (correct and should not change).
  - Ready To Run folder watcher: depth 10 under ap_jobfolder (job folders can be nested).
  - Test data watcher: depth 4 under test data root (correct and should not change).

- Remaining
  - None in this file at the moment.

Code changes must be documented in this file

- As each watcher is updated, add a short section explaining:
  - what was changed
  - why this is safest
  - a small code snippet showing the new behavior

Progress Log

- 2026-01-30 AutoPAC strict matching and quarantine
  - Changed AutoPAC chokidar watcher to `depth: 0` so it does not traverse subfolders.
  - Updated ignore rules so the AutoPAC watcher never touches unknown filenames.
  - Invalid AutoPAC CSV files now move into `incorrect_files` instead of being deleted.

  Code snippet

  ```ts
  // AutoPAC watcher only watches the configured folder root.
  chokidar.watch(dir, {
    depth: 0,
    ignored: shouldIgnoreAutoPacPath,
    ignoreInitial: true,
  })

  // Invalid CSVs are quarantined, not deleted.
  const quarantinedAs = await quarantineAutoPacCsv(path, dirname(path))
  ```

- 2026-01-30 Backoff cap changed to 60 seconds
  - Changed the watcher backoff cap from 240 seconds to 60 seconds.
  - This matches the one minute reconnect cadence requirement while still preserving exponential behavior.

  Code snippet

  ```ts
  const WATCHER_BACKOFF_INITIAL_MS = 7_500
  const WATCHER_BACKOFF_MAX_MS = 60_000
  ```

- 2026-01-30 Nestpick invalid file quarantine
  - Nestpick.erl mismatch is quarantined to `incorrect_files` so it cannot re-trigger forever.
  - Report_FullNestpickUnstack.csv quarantines when it is empty or contains unmatched rows.
  - Success moves to `archive`, failure moves to `incorrect_files`.

  Code snippet

  ```ts
  enqueueFileMoveTask({
    source: path,
    targetDir: join(machine.nestpickFolder, 'incorrect_files'),
    purpose: 'incorrect_files',
    watcherName: nestpickAckWatcherName(machine),
  })
  ```

- 2026-01-30 Grundner stock.csv archive and quarantine
  - Grundner Stock Poller no longer deletes stock.csv after reading.
  - It moves stock.csv into `archive` on successful parse.
  - It moves stock.csv into `incorrect_files` when parsing fails.

- 2026-01-30 Grundner ERL reply file policy
  - order_saw.erl and get_production.erl are now always moved:
    - match equals archive
    - mismatch equals incorrect_files

- 2026-01-30 DB patch for manual lifecycle history
  - Added `jobs.manual_lifecycle` JSONB column.
  - Added a startup DB patch so older databases do not crash due to missing column.

- 2026-01-30 Router Change Status UI
  - Added a right-click context menu on the Router page with one action: Change Status.
  - The modal requires a reason and only allows forward-only statuses after the current status.
  - Save calls `window.api.router.changeStatus` which invokes `jobs:lifecycleManual` in Main.
  - After a successful change, the Router list refreshes only for that machine so operators see the new status quickly.

  Code snippet

  ```ts
  const res = await window.api.router.changeStatus({ key: row.jobKey, to, reason })
  if (res.ok && res.value.ok) {
    await refreshReadyForMachine(row.machineId)
  }
  ```

- 2026-01-30 Grundner reply files never deleted
  - Replaced "delete stale reply" behavior with quarantine to `incorrect_files` for:
    - `order_saw.erl`
    - `get_production.erl`
  - This keeps traceability while still ensuring we do not accidentally accept an old confirmation.

- 2026-01-30 ChangeMachNr.erl always archived or quarantined
  - AutoPAC `order_saw*.csv` handler writes `ChangeMachNr.csv` to the Grundner folder and waits for `ChangeMachNr.erl`.
  - Changed the reply handling to be deterministic:
    - match equals archive
    - mismatch equals incorrect_files
  - Removed config gating that sometimes deleted the reply file.

- 2026-01-30 AutoPAC CSV files are never deleted
  - Updated AutoPAC CSV disposal so successful files are always moved into `archive`.
  - If the move fails due to network share issues, the move is queued and retried with backoff instead of deleting the CSV.

- 2026-01-30 Offline episode notifications
  - Watcher offline alerts now follow an "episode" model:
    - one Messages entry + at most one popup when a watcher goes offline
    - one Messages entry + throttled popup when long retry mode starts (60 second retry)
    - one Messages entry + throttled popup when the watcher recovers
  - Implemented this in Main so all watchers share the same throttle and the UI is not spammed.

- 2026-02-03 Jobs table hide completed folder groups
  - Implemented the Jobs table hiding rule using `job.folder` as the folder group.
  - When enabled, folders are hidden only if every job in that folder is complete.
  - Completion definition depends on machine Nestpick setting.

  Code snippet

  ```ts
  if (hideCompletedFolders) {
    conditions.push(sql`... GROUP BY j2.folder HAVING bool_and(
      CASE
        WHEN COALESCE(m2.nestpick_enabled, false) THEN j2.status = 'NESTPICK_COMPLETE'
        ELSE j2.status IN ('CNC_FINISH', 'FORWARDED_TO_NESTPICK', 'NESTPICK_COMPLETE')
      END
    )`)
  }
  ```

- 2026-02-03 Router Change Status modal padding
  - Increased modal width and added consistent padding so the title, inputs, and textarea do not touch the modal edges.

  Code snippet

  ```tsx
  <DialogContent className="sm:max-w-[720px]">
    <div className="p-6 sm:p-7">...</div>
  </DialogContent>
  ```

- 2026-02-03 Ready To Run watcher does not traverse
  - The Ready subscription watcher for `ap_jobfolder` uses `depth: 10` so nested job folders update Router/Ready-To-Run.
  - This is intentionally different from the CSV integration watchers which remain depth 0 only.

  Code snippet

  ```ts
  chokidar.watch(root, { depth: 10 })
  ```
