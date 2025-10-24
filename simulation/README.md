Simulation Test Suite

Purpose
- Simulate an end-to-end job workflow by driving the same file-based watchers the app uses (AutoPAC CSVs and Nestpick folders).
- Useful for smoke testing environments, watcher behavior, and DB lifecycle transitions without manual operator actions.

What it does
- Picks a random job from the `jobs` table.
- Optionally stages it to a target machine (copies NC/CSV/.PTS/.LPT/images into the machine’s `ap_jobfolder`). If the per‑file parts CSV `<base>.csv` is missing, the script synthesizes one using `.pts/.lpt` to estimate part rows.
- Generates AutoPAC CSVs in sequence: `load_finish<machine>.csv`, `label_finish<machine>.csv`, `cnc_finish<machine>.csv`.
- Lets the app forward the parts CSV to Nestpick (watchers write `Nestpick.csv`).
- Reads `Nestpick.csv` (forwarded by the app) to pick a `PalletName` if present, deletes it, then writes an Unstack report (`Report_FullNestpickUnstack.csv`) to complete the lifecycle and set `jobs.pallet`. Falls back to a random pallet if none found.
- Adds a random delay (0–120s) between steps to mimic real timing.

Prerequisites
- The Electron app must be running with watchers enabled.
- `settings.json` must be configured with valid DB and paths (autoPacCsvDir, machines’ ap_jobfolder and nestpick_folder).
- Python 3.9+ and pip.

Install deps
- pip install -r simulation/requirements.txt

Grundner stock simulator
- Simulates Grundner responding to order_saw.csv and stock_request.csv.
- Maintains a local inventory CSV `grun_stock.csv` and serves it as `stock.csv` upon request.

Run Grundner simulator
- python simulation/grundner_sim.py --folder "D:\\SoftwareTesting\\Nestpick"
- Use `--id-mode customer_id` if your material key is `customer_id` instead of `type_data`.

Behavior
- On `order_saw.csv`:
  - Writes `order_saw.erl` with the same content (acknowledgement).
  - Parses each line (`<nc>;<material>;<qty>;...`), increments `reserved_stock` for that material by `qty`, and sets `stock_available = max(0, stock - reserved_stock)` in `grun_stock.csv`.
  - Renames the processed CSV to `order_saw.<timestamp>.processed.csv` to avoid blocking future orders.
- On `stock_request.csv`:
  - Copies `grun_stock.csv` to `stock.csv` and deletes the request file.

Tips
- Initialize `grun_stock.csv` by running the simulator once; it will create an empty, headered file if missing.
- Keep the Electron app’s Grundner folder path pointing to the same `--folder` so the watcher can drop `stock_request.csv` and read `stock.csv`.

Run the simulator
- Repeat forever (prompts for machine):
  - python simulation/simulate_workflow.py
- Repeat forever (explicit machine):
  - python simulation/simulate_workflow.py --machine WT1
- Run once and exit:
  - python simulation/simulate_workflow.py --once --machine WT1

Useful options
- `--machine`  Machine name token (e.g. WT1) or numeric id (e.g. 1). If omitted, prompts.
- `--ask-machine`  Always prompt for the machine, ignoring `--machine`.
- `--min-delay`, `--max-delay`  Seconds between steps inside a cycle. Defaults 0 and 120.
- `--between-min`, `--between-max`  Seconds between cycles. Defaults 3 and 15.
- `--once`  Run one cycle and exit.
- `--dry-run`  Print planned actions without writing files.
- `--no-stage`  Skip staging if you only want to drive AutoPAC/Nestpick for already staged jobs.

Notes on staging
- The script mirrors key parts of `worklist.ts` to stage a job:
  - Derives a destination folder under `ap_jobfolder/<leaf>` where `<leaf>` is taken from job.folder or the NC base name.
  - Copies the `.nc` and, if found, the per-file parts CSV `JobName.csv` (this is forwarded to Nestpick on CNC_FINISH).
  - If the destination exists, a timestamped suffix is appended to avoid collisions.
- We intentionally do not run the app’s IPC to update STAGED; watchers accept `LOAD_FINISH` directly from `PENDING` and will set `staged_at` on the first AutoPAC event.
- Copies `.nc`, `.pts`, `.lpt`, and images matching `<base>*.bmp|jpg|jpeg` from the job source to the staged folder.
- If `<base>.csv` is missing, creates a headered CSV with columns: `X-pos,Y-pos,reserve,ElementID,LengthX,LengthY,Thickness,Destination,SourceMachine,Type,Additional,Category,PalletName,X-posTarget,YposTarget,RposTarget`, and N data rows (N derived from `.pts` or `.lpt`, else 1). The app’s watcher will fill `Destination=99` and `SourceMachine=<id>`.

Unstack (pallet) file format
- Written to `<nestpick_folder>/Report_FullNestpickUnstack.csv`.
- No header required; the script writes rows like: `JobBase,Pallet_A05`.
- The watcher updates `jobs.pallet` and completes the lifecycle to `NESTPICK_COMPLETE`.

Troubleshooting
- Nothing happens: confirm the app is running and `autoPacCsvDir`/Nestpick folders match `settings.json`.
- Job not found by AutoPAC: ensure the first column in the AutoPAC CSV is the NC base name and the CSV contains the machine token (e.g., WT1).
- Not forwarded to Nestpick: ensure the job’s parts CSV `JobBase.csv` exists in the staged folder.
