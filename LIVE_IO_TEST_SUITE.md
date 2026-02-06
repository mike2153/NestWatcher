# Live IO Test Suite

This suite runs watcher IO tests against your real configured folders so you can watch files and logs in real time.

## Files and scripts

- Live integration suite: `tests/ioLiveWatchers.test.ts`
- Unit fuzz catalog: `tests/ioFuzzUnit.test.ts`
- Electron mock: `tests/setup/electronMock.ts`
- Reports folder: `tests/reports`

Scripts:

- `pnpm test`
- `pnpm run test:live-io`
- `pnpm run test:live-io:autopac`
- `pnpm run test:live-io:grundner` or `pnpm run test:live-io:grun`
- `pnpm run test:live-io:nestpick` or `pnpm run test:live-io:nestp`
- `pnpm run test:live-io:fuzz`

## Required settings

`settings.json` must include:

- `paths.autoPacCsvDir`
- `paths.grundnerFolderPath`
- `paths.processedJobsRoot`
- `integrations.archiveIoFiles: true`

Machine requirements in DB:

- `nestpickEnabled = true`
- `nestpickFolder` configured
- `apJobfolder` configured

## Fixture model

The suite auto-selects one fixture from `processedJobsRoot` where both files exist:

- `<base>.nc`
- `<base>.nsp` (preferred) or `<base>.npt` legacy

It creates temporary DB job rows using that base and stages the **entire fixture source folder** into machine ready-to-run under the same leaf folder name.

This means related files in that source folder are copied too, such as `.pts`, `.lpt`, `.bmp`, `.jpg`, family CSVs, and payload files, so live tests behave like real staged job folders.

Important behavior requested by you:

- Fixture source files under `processedJobsRoot` are never deleted.
- Copied ready-to-run files are left in place after the run.

## Full chain covered

The end-to-end scenario now validates this chain on one fixture job:

1. Start job in `STAGED`
2. Drop `order_saw<machine>.csv`
3. App writes `ChangeMachNr.csv`
4. Test writes matching `ChangeMachNr.erl`
5. Test simulates production by deleting `ChangeMachNr.csv`
6. Job advances `STAGED -> RUNNING`
7. Drop AutoPAC lifecycle files: `load_finish`, `label_finish`, `cnc_finish`
8. Job advances to `CNC_FINISH`
9. App forwards `Nestpick.csv` from staged Nestpick payload `.nsp` or `.npt`
10. Test writes matching `Nestpick.erl`
11. Test simulates production by deleting `Nestpick.csv`
12. Job advances `CNC_FINISH -> FORWARDED_TO_NESTPICK`
13. Test writes `Report_FullNestpickUnstack.csv`
14. Job advances to `NESTPICK_COMPLETE`

## Archive and incorrect file behavior asserted

With `integrations.archiveIoFiles = true`, the suite asserts:

- AutoPAC inbound success CSVs are archived
- AutoPAC invalid CSVs go to `incorrect_files`
- Outbound `ChangeMachNr.csv` and `Nestpick.csv` have `_sent` archive copies
- Inbound `ChangeMachNr.erl`, `Nestpick.erl`, and unstack report are archived
- Invalid inbound files are moved to `incorrect_files`

This mirrors production where Grundner/Nestpick consume and remove slot CSVs after producing replies.

## Live fuzz smoke

`pnpm run test:live-io:fuzz` runs named live scenarios (AutoPAC, Grundner, Nestpick).

Each fuzz scenario now gets a unique derived base name by cloning the selected fixture folder and renaming base-matching files. This prevents cross-scenario collisions when multiple jobs share the same original NC base.

Env vars:

- `WOODTRON_LIVE_IO_FUZZ=1` enable fuzz smoke mode
- `WOODTRON_LIVE_IO_FUZZ_SCENARIOS=12` number of named smoke scenarios to run
- `WOODTRON_LIVE_IO_FUZZ_DELAY_S=10` wait time between file writes so you can observe Explorer and logs

Each live fuzz scenario has a stable ID like:

- `L-FZ-AUTOPAC-001`
- `L-FZ-GRUNDNER-006`
- `L-FZ-NESTPICK-010`

## Unit fuzz catalog

`tests/ioFuzzUnit.test.ts` contains **50 named fuzz scenarios** with stable IDs:

- `UF-AUTOPAC-FN-001` through `UF-AUTOPAC-C-024`
- `UF-ORDER-FN-025` through `UF-ORDER-C-034`
- `UF-NESTPICK-S-035` through `UF-NESTPICK-S-042`
- `UF-NESTPICK-U-043` through `UF-NESTPICK-U-050`

Coverage includes filename parsing, CSV content structure, delimiter variations, machine mismatches, empty inputs, and stack/unstack payload checks.

## Reports

Every live run writes:

- `tests/reports/live-io-report-YYYYMMDD-HHMMSS.html`
- `tests/reports/live-io-report-YYYYMMDD-HHMMSS.json`
- `tests/reports/live-io-latest.html`
- `tests/reports/live-io-latest.json`

When a scenario fails, input payload copies and a manifest are also saved to:

- `tests/failed_files/<timestamp>_<scenario>/inputs/*`
- `tests/failed_files/<timestamp>_<scenario>/manifest.json`

Report sections include:

- Scenario status and duration
- Top summary cards with pass/fail and bad-input attempt counts by watcher family
- Named step logs
- Exact files written and contents
- File outcomes like `archive`, `incorrect_files`, `consumed`
- App messages emitted
- Watcher status snapshots
