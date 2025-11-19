# Material Reservation & Ordering Plan

Last updated: {auto}

## Goals
- Retire the “Pre‑Reserved” concept from the UI and language.
- Use a single term “Reserved” (maps to `is_locked` in DB for now).
- Improve visibility at the folder level (Reserved / Partially Reserved) in the Jobs and Allocation views.
- Allow manual reservations (without a job) with comments and traceability.
- Keep ordering simple: compute shortage from all PENDING jobs vs. available stock.

---

## Current Logic (as of today)

Where relevant, code references are included for traceability.

- Job ingest
  - New jobs are inserted with `pre_reserved = true`.
    - packages/main/src/services/ingest.ts:154
  - After inserts and prunes, the app resyncs Grundner `pre_reserved` counts for impacted materials so the Grundner table reflects pre‑reserved totals.
    - packages/main/src/services/ingest.ts:201, 278 → calls into jobsRepo
    - packages/main/src/repo/jobsRepo.ts: syncGrundnerPreReservedCount()

- Allocation view
  - Backed by `public.allocated_material_view`. It joins `jobs` to `grundner` and exposes both pre‑reserved and locked rows for display.
    - docs/schema.sql: allocated_material_view
    - packages/main/src/db/schema.ts: allocatedMaterialView
  - Renderer groups rows Material → Folder → NC File.
    - packages/renderer/src/pages/AllocatedMaterialPage.tsx

- Ordering
  - Computes shortage per material using ALL `PENDING` jobs, not only pre‑reserved.
  - Shortage = `pending_count (PENDING) − stock_available` (fallback to `stock` if `stock_available` null).
    - packages/main/src/repo/orderingRepo.ts: computeOrderingRows()

- Locking flows (aka “Reserved” in the new language)
  - Batch/single locking:
    - Write `order_saw.csv` to Grundner share, wait for `.erl` confirmation, then set `is_locked = true`, clear `pre_reserved`.
      - packages/main/src/services/orderSaw.ts
      - packages/main/src/ipc/jobs.ts: lockBatch → placeOrderSawCsv() → lockJobAfterGrundnerConfirmation()
  - Unlocking writes a production-delete CSV and clears `is_locked` after confirmation.
    - packages/main/src/ipc/jobs.ts: unlockBatch → placeProductionDeleteCsv()/unlockJob()

- Grundner table
  - Shows per‑material stock, stock_available, reserved_stock, pre_reserved.
    - packages/main/src/repo/grundnerRepo.ts
    - packages/renderer/src/pages/GrundnerPage.tsx

Notes:
- The `pre_reserved` flag can be cleared while a job remains `PENDING` (e.g., when it’s locked). That’s why ordering counts PENDING (full demand) rather than only pre‑reserved.

---

## New Logic & Terminology

- Language
  - Remove “Pre‑Reserved” everywhere in UI.
  - Rename “Locked” → “Reserved” in UI and messages.
  - Keep the DB field name `is_locked` for now to avoid risky schema churn.

- Jobs & ingest
  - Target end state: do not set `pre_reserved` at ingest. Keep jobs as `PENDING` without a pre‑reserve flag. (Phased rollout below.)

- Allocation page
  - Remove the “Pre‑Reserved” status and columns.
  - Show only “Reserved” counts.
  - Compute folder‑level status:
    - Reserved: all PENDING jobs in folder are reserved (`lockedCount >= pendingCount`).
    - Partially Reserved: `0 < lockedCount < pendingCount`.
    - Not Reserved: `lockedCount = 0`.

- Jobs table (folder grouping)
  - Add folder‑level badges: Reserved / Partially Reserved (X/Y) / Not Reserved.
  - Right‑click folder → “Reserve all PENDING in folder”.
  - Optionally: “Reserve by Material” submenu when a folder contains multiple materials.

- Grundner table
  - Remove “Pre‑Reserved” column.
  - Rename “Locked” column to “Reserved”.
  - Allow expanding a material row to show folders using that material with counts (no NC‑file granularity needed).

- Ordering (unchanged computation)
  - Keep: `required = jobs where status = 'PENDING'` per material.
  - Shortage = `required − stock_available` (fallback to `stock`).
  - Rationale: ordering should cover the full PENDING backlog beyond what’s physically available, regardless of which subset is already reserved.

---

## Manual Reservations (no job)

- UI
  - In Grundner table: right‑click a material → “Reserve Qty…”.
  - Modal fields: Quantity (integer), Comment (free text).
  - `order_saw.csv` NC filename field uses the user’s display name truncated to 8 characters (Grundner limit). The UI still shows the full display name and comment.

- Flow
  1) Validate available stock for the material.
  2) Place Grundner order (CSV), wait for `.erl` confirmation.
  3) Persist N manual reservations in the database for traceability and consistent counts.

- Persistence model (clean approach)
  - Insert N “manual jobs” in `public.jobs` so they show as reserved entries everywhere:
    - `key`: generated (e.g., `__MANUAL__/material/<ts>/<uuid>/<i>`)
    - `folder`: NULL (render as “N/A” in UI)
    - `ncfile`: e.g., `MANUAL_<USER8>_<stamp>_<i>`
    - `material`: selected material
    - `status`: `PENDING`
    - `is_locked = true`, `pre_reserved = false`, `allocated_at = now()`, `locked_by = displayName`
  - Add a side table to store comments (and richer metadata):
    - `manual_locks(job_key PK → jobs.key, material, comment, created_by, created_at)`
  - Unlocking: select these entries in UI and use the existing unlock flow.

---

## Before / After (Diagrams)

- Ingest
```
BEFORE:
NC files → Ingest → jobs(pre_reserved = true) → Grundner.pre_reserved resynced → Allocation shows Pre‑Reserved + Locked

AFTER:
NC files → Ingest → jobs(PENDING, no pre‑reserve) → Allocation shows Reserved only (folder status computed)
```

- Ordering
```
BEFORE & AFTER (same computation):
required = COUNT(jobs WHERE status = 'PENDING')
shortage = required − stock_available (fallback to stock)
show row only if shortage > 0
```

- Reservation (Lock)
```
BEFORE:
UI lock → order_saw.csv → wait .erl → jobs.is_locked = true, jobs.pre_reserved = false

AFTER:
UI reserve → order_saw.csv (NC name = USER8) → wait .erl → jobs.is_locked = true (called “Reserved” in UI)
```

- Manual Reservation
```
NEW:
Grundner → Right‑click material → Reserve Qty… (qty, comment)
 → order_saw.csv (USER8) → wait .erl
 → Insert N manual jobs + manual_locks(comment,user,time)
 → Visible as Reserved (folder: N/A) with comment/user/time
```

- Folder status (Jobs/Allocation)
```
Reserved:            lockedCount >= pendingCount
Partially Reserved:  0 < lockedCount < pendingCount
Not Reserved:        lockedCount = 0
```

---

## Data Model & Schema Changes

- Phase 2 (Manual reservations)
  - New table `manual_locks` (proposed):
    - `job_key text PRIMARY KEY REFERENCES jobs(key) ON DELETE CASCADE`
    - `material text NOT NULL`
    - `comment text`
    - `created_by text`
    - `created_at timestamptz DEFAULT now()`

- Phase 3–4 (Pre‑reserve retirement)
  - Stop setting `jobs.pre_reserved` in ingest.
  - Update `allocated_material_view` to exclude pre‑reserve semantics (only reflect reserved/locked if needed).
  - Eventually drop `jobs.pre_reserved` and `grundner.pre_reserved` after a deprecation period.

- No change to `is_locked` (DB), only UI label → “Reserved”.

---

## API & UI Changes (High Level)

- UI
  - Jobs page: folder badges, folder context menu for “Reserve all” and “Reserve by Material”.
  - Allocation page: remove pre‑reserve column/status, show reserved counts only.
  - Grundner page: remove Pre‑Reserved, rename Locked→Reserved, expandable rows per material to show folders and counts.

- IPC / Backend
  - New: `grundner:listMaterialUsage(material)` → folders and counts for that material.
  - New: `grundner:lockManual({ material, qty, comment })` → places order_saw, inserts manual reservations, returns summary.
  - New: `grundner:unlockManual({ jobKeys[] | byComment })` → unlocks selected manual reservations.
  - Adjust: stop using pre‑reserve in new queries; continue to support legacy until removal.

---

## Rollout Plan

- Phase 1: Language & UI surface
  - Rename Locked→Reserved in UI and events/messages.
  - Remove pre‑reserve from Allocation/Grundner UI.
  - Add folder‑level status badges and folder context menus in Jobs.

- Phase 2: Manual reservations
  - Add modal + CSV placement + `.erl` confirmation.
  - Create manual jobs + `manual_locks` entries; show in UI; enable unlock.

- Phase 3: Ingest change
  - Stop setting `pre_reserved` on ingest.
  - Ensure Allocation and Grundner views remain correct without pre‑reserve.

- Phase 4: Cleanup
  - Remove `pre_reserved` fields and view dependencies after a deprecation window.

---

## Open Questions / Decisions
- Group manual reservations in UI by (comment, user) or list individually? (Proposed: group with count, allow drill‑down.)
- Keep ordering as PENDING − stock_available (recommended), or subtract reserved as well? (Current plan: keep it as-is.)
- Manual reservation comment length limits (DB/UI): e.g., 200 chars; CSV only needs USER8.

---

## Notes & Constraints
- Grundner CSV NC field is limited; we will truncate username to 8 characters for `order_saw.csv`. UI will show full display name and full comment.
- Concurrency: keep existing file writing approach (atomic temp rename), and `.erl` stability checks.
- Backward compatibility: DB keeps `is_locked`; UI labels change only. Pre‑reserve removed from UI first, dropped from DB later.

