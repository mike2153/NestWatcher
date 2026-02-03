# MES and Data Capture Guide

This replaces `MES-JSON-SPECIFICATION.md` and `json_integration.md`. It explains how `validation.json` is processed and what we persist.

## What we ingest
- Source file: `validation.json` written by NC Catalyst into Electron `userData`.
- Scan interval: every 5 seconds (service in Main).
- Scope guard: entries are only trusted if their `folderPath` is inside `processedJobsRoot`.
- Job key: `relative folder under processedJobsRoot + base filename without extension` (same as ingest poller). Truncated to 100 chars.
- After processing, `validation.json` is deleted.

## Where data is stored
- Table: `public.nc_stats` keyed by `job_key` (FK to `public.jobs.key`).
- Columns we populate:
  - `nc_est_runtime` (seconds), `yield_percentage`
  - `usable_offcuts` (array of `{x,y,z}`), `waste_offcut_m2`, `waste_offcut_dust_m3`
  - `total_tool_dust_m3`, `total_drill_dust_m3`, `sheet_total_dust_m3`
  - `cutting_distance_meters` (sum of tool usage)
  - `tool_usage` and `drill_usage` JSON arrays
  - `validation` object (`status`, `warnings`, `errors`, `syntax`)
  - `nestpick` object (`canAllBePicked`, failures/oversize parts, `palletAdjustedVolumeM3`)
  - `mes_output_version` from `exportMetadata`

## Minimal field guide (per file entry)
- `filename`, `folderPath`: used with `processedJobsRoot` to build the job key.
- `ncEstRuntime`: estimated runtime (seconds).
- `yieldPercentage`: sheet utilisation percent.
- `usableOffcuts`: list of `{x,y,z}` in millimetres.
- `toolUsage`: array of `{toolNumber, toolName, cuttingDistanceMeters, toolDustM3}`.
- `drillUsage`: array of `{drillNumber, drillName, holeCount, drillDistanceMeters, drillDustM3}`.
- `validation`: `{status: pass|warnings|errors, warnings[], errors[], syntax[]}`.
- `nestPick`: `{canAllBePicked, partsTooLargeForPallet[], failedParts[], palletAdjustedVolumeM3}`.

## UI surface
- Renderer calls `validation.getData({ key })` via `window.api` to populate the MES modal (double-click in Jobs/Router).
- Missing rows return `{ ok: false, error }` so callers can show a friendly message.

## What to check when data is missing
- Confirm `validation.json` actually points into `processedJobsRoot`.
- Ensure the `jobs.key` matches the folder + base name in the JSON.
- Look for parse errors surfaced as Messages entries (`mes.parseError`, `mes.jobsNotFound`).
- Verify the MES scanner is running (started on app ready; stopped on quit).
