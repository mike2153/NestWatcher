## File Watchers, AutoPAC, and Nestpick (Beginner Lesson)

This app watches machine folders and CSVs to update job status and forward to Nestpick.

### Where the Logic Runs
- Worker: `packages/main/src/workers/watchersWorker.ts`
  - AutoPAC CSV watcher
  - Nestpick processed/unstack watchers
  - (CNC telemetry now flows directly into Postgres; no TCP clients remain in the worker)

### AutoPAC CSV Files
- Naming must include machine: `load_finishWT1.csv`, `label_finishWT2.csv`, `cnc_finishWT1.csv` (separators `_`/`-` allowed)
- CSV rows must have NC name in the first column (either `base` or `base.nc` only)
- We also require the CSV content to contain the machine token (e.g., `WT1`) somewhere in the file; mismatch → warning, file left untouched

Flow:
1) Watcher sees a file, waits briefly for writes to stabilize
2) Extract process (LOAD/LABEL/CNC) and machine from filename
3) Validate CSV contains same machine token
4) Extract bases from the first column and find matching DB jobs by `ncfile` (only `base` or `base.nc`)
5) Update lifecycle (e.g., `LOAD_FINISH`, `CNC_FINISH`), append history events
6) On success, delete the CSV
7) If `CNC_FINISH` and machine supports Nestpick, forward per‑file parts CSV to Nestpick folder

### Nestpick Forwarding
Triggered on `CNC_FINISH` if `machine.nestpickEnabled` and `nestpickFolder` are set.
- Finds the job’s parts CSV in Ready‑To‑Run
- Rewrites `Destination=99`, `SourceMachine=<machineId>`
- Writes `Nestpick.csv` atomically to the Nestpick share (waits if busy)
- Appends job events and updates lifecycle to `FORWARDED_TO_NESTPICK`

### Diagnostics & Health
The worker posts messages back; Main turns them into Diagnostics snapshot entries visible in the UI.
- Issues like “missing parts CSV”, “Nestpick share unreachable”, or copy failures appear as machine health pills.

### Tuning Watchers
- Stability and debounce times are configured in `watchersWorker.ts` (we use low latencies for responsiveness).

