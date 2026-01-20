## Architecture: Main, Preload, Renderer (Beginner Lesson)

This document explains how the app is organized and how data flows.

### High‑Level
- Main (Node) controls windows, OS access, file IO, watchers, and DB.
- Renderer (React) displays UI and calls `window.api.*` for work.
- Preload is the safe bridge that defines `window.api`.

### Where Code Lives
- Main: `packages/main/src`
  - IPC registration: `packages/main/src/ipc/*`
  - Services: `packages/main/src/services/*` (worklist, ingest, diagnostics, etc.)
  - Repos/DB access: `packages/main/src/repo/*`
  - Background watchers worker: `packages/main/src/workers/watchersWorker.ts`
- Preload: `packages/preload/src/index.ts` (exposes `window.api`)
- Renderer: `packages/renderer/src` (pages, layout, styling)

### Database quick map

NestWatcher uses a local Postgres database as the system of record.

Where to look:
- Code schema used by the app: `packages/main/src/db/schema.ts`
- Human readable full dump: `docs/schema.sql`

Key tables you will touch when changing job flow:
- `public.jobs`
  - `key` string is the stable job identifier used everywhere.
  - `status` enum is the lifecycle state.
  - `pre_reserved` boolean is the planning flag set by ingestion.
  - `is_locked` boolean is the sheet allocation lock.
  - `machine_id` is set when staged.
  - `staged_at`, `cut_at`, `nestpick_completed_at` are timestamps for the lifecycle.
- `public.job_events`
  - Append only event log for lifecycle changes and actions.
- `public.machines`
  - Per machine folders like `ap_jobfolder` and `nestpick_folder`.
- `public.grundner`
  - Inventory snapshot imported from Grundner stock.csv.
  - `reserved_stock` comes from Grundner.
  - `pre_reserved` is a computed count of pending jobs that are pre reserved.
- `public.ordering_status`
  - Tracks ordered and comments per Grundner row.
- `public.nc_stats`
  - Stores MES metrics imported from `validation.json`.
- `public.app_users`
  - Local operator accounts and session enforcement.

### The Request/Response Pattern
1) Renderer calls `window.api.jobs.list(req)` (typed request)
2) Preload forwards to Main with `ipcRenderer.invoke('jobs:list', req)`
3) Main registered a handler with `registerResultHandler('jobs:list', ...)`
4) Main returns `{ ok, value | error }` envelope (neverthrow‑style ergonomic result)
5) Renderer renders the response

### Subscriptions (push from Main)
Some features stream updates (DB status, Ready‑To‑Run folder):
- Renderer subscribes → Preload attaches an IPC `on(channel)` listener
- Main sends updates with `contents.send('channel', payload)`
- Renderer unsubscribes on unmount; Main cleans up listeners

### Worker Threads
`watchersWorker.ts` runs background watchers (AutoPAC CSVs, Nestpick outputs). CNC telemetry is written directly into PostgreSQL by an external cncstats collector service; the worker does not handle telemetry ingestion and focuses exclusively on filesystem-driven job status flows. It posts events back to Main over Node worker messaging, and Main forwards status updates into Diagnostics.

### Why the Bridge (Preload)?
- Security: Renderer doesn’t get Node APIs directly
- DX: A single `window.api` surface is easy to reason about and type

