# Allocation Handling

## Core Concepts
- **Jobs table (`public.jobs`)** tracks every NC program discovered under the processed jobs root. Key fields: `pre_reserved`, `is_locked`, `material`, and `allocated_at`.
- **Grundner inventory (`public.grundner`)** stores sheet quantities. The view `public.allocated_material_view` joins jobs to matching Grundner rows so the UI can show reserved vs. available counts.
- **File handshakes** with Grundner drive stock changes:
  - `order_saw.csv` (lock) → Grundner replies with `order_saw.erl`.
  - `get_production.csv` (release) → Grundner returns `productionLIST_del.csv`.
  - `stock_request.csv` / `stock.csv` keeps the inventory table in sync.
- **Watchers worker** polls Ready-to-Run folders, processed jobs root, and the Grundner share so that file events and database state stay aligned.

## Normal Flow
1. **Reserve**: User reserves a job in the UI. The app toggles `jobs.pre_reserved = true` and raises a `allocated_material_changed` notification so the allocation grid refreshes.
2. **Lock**: When the job is ready to cut, the UI issues a batch lock:
   - Writes **one** `order_saw.csv` listing every selected job.
   - Waits for `order_saw.erl` to mirror the request.
   - Marks each job `is_locked = true` and times the action (`allocated_at`).
   - Broadcasts an `allocatedMaterial:refresh` so the allocation table updates immediately.
3. **Unlock**: On success or manual release:
   - The app writes **one** `get_production.csv` containing all NC files to release.
   - Awaits `productionLIST_del.csv`, validates the material/quantity, then flips `is_locked` (and `pre_reserved` when appropriate) to `false`.
   - A UI refresh message fires so the allocation page re-queries without waiting for postgres notify batching.

## Edge Cases We Handle
- **User deletes job files from Ready-to-Run**  
  The stage sanity poller notices locked jobs whose NC files disappeared. It reverts them to `PENDING`, sends a single `get_production.csv` for all missing sheets, and posts a message in the new *Messages* page summarising the release.

- **User removes jobs from processed root (File Explorer)**  
  The ingest poller runs every 5 s. When it prunes `public.jobs` rows that no longer have NC files on disk, it batches the missing NC names into `get_production.csv`, triggers Grundner to free the stock, and leaves a timeline entry plus a message for transparency.

- **Ready delete from the app**  
  When users delete staged assets via the Ready page we now emit one release CSV for the affected NC files and push a message so operators know Grundner was updated.

- **Grundner stock changes externally**  
  Periodic `stock_request.csv` syncs refresh the Grundner table. Any differences generate allocation refresh events so the UI reflects new available counts.

## Diagnostics & Visibility
- The *Allocated* page subscribes to live refresh events, so every lock/unlock or Grundner sync appears within ~2 s without manual reloads.
- The new *Messages* page aggregates human-readable notifications (e.g., “Released Sheet123.nc from Grundner (job deleted)”) with timestamps and event sources (`stage-sanity`, `jobs-ingest`, `ready-delete`).
- All watcher actions are logged via `diagnostics` and record watcher events for audit trails.
