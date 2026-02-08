# Developer Guide (Condensed)

Audience: developers new to Electron/TypeScript. This replaces the older INTRODUCTION, ARCHITECTURE, IPC, PROJECT_STRUCTURE, and user-auth docs.

## Architecture in one page
- **Main** (`packages/main/src`): Node process. Creates windows, registers IPC handlers, runs services, repos, and the watchers worker.
- **Preload** (`packages/preload/src/index.ts`): secure bridge. Exposes a typed `window.api` surface only.
- **Renderer** (`packages/renderer/src`): React + Tailwind UI. No Node APIs; always call `window.api`.
- **Shared** (`packages/shared/src`): IPC schemas, result helpers, shared enums.

Security defaults: keep `contextIsolation: true`, `nodeIntegration: false`. Only expose minimal, validated functions via Preload.

## IPC pattern to follow
1) Renderer calls `window.api.feature.method(req)`.
2) Preload wraps `ipcRenderer.invoke('feature:method', req)`.
3) Main registers `registerResultHandler('feature:method', handler)` and returns an envelope `{ ok: true, value } | { ok: false, error }`.
4) Renderer handles both branches.

Push updates use `contents.send(channel, payload)` with subscribe/unsubscribe helpers in Preload; always detach on unmount.

## Repository map (what to open first)
- Main entry: `packages/main/src/main.ts`
- IPC: `packages/main/src/ipc/*`
- Services: `packages/main/src/services/*`
- Database repos: `packages/main/src/repo/*`
- Worker: `packages/main/src/workers/watchersWorker.ts`
- Renderer shell: `packages/renderer/src/shell/AppLayout.tsx`
- Jobs UI example: `packages/renderer/src/pages/JobsPage.tsx`
- IPC types: `packages/shared/src/ipc.ts`
- Result helpers: `packages/shared/src/result.ts`

## Database quick reference
Local Postgres is the system of record. Full DDL lives in `docs/schema.sql`.
- `jobs`: `key` (stable identifier), `status` enum (`PENDING` → `STAGED` → `LOAD_FINISH` → `LABEL_FINISH` → `CNC_FINISH` → `FORWARDED_TO_NESTPICK` → `NESTPICK_COMPLETE`), machine linkage, timestamps, locking flags. `FORWARDED_TO_NESTPICK` is conditional and can be skipped when Nestpick mode is off at CNC finish time.
- `job_events`: append-only history.
- `machines`: AutoPAC and Nestpick folders per machine, PC IP for telemetry mapping.
- `grundner`: stock import from `stock.csv` (notably `reserved_stock`).
- `ordering_status`: ordering flags/comments per Grundner row.
- `nc_stats`: MES metrics from `validation.json` (see `docs/MES_AND_DATA.md`).
- `app_users`: local accounts with roles; `locked_by`/`staged_by` on jobs reference these users.

## Authentication (summary)
- Table `public.app_users` stores username, display name, scrypt-hashed password, three hashed security answers, and `role` (`admin` or `operator`).
- On app launch Renderer calls `auth:me`; without a session the login modal blocks the UI.
- Successful login/register/reset issues an in-memory session token tied to `WebContents`; not persisted to disk.
- Main guards privileged IPC with `requireSession` / `requireAdminSession`; admin is still required for privileged settings writes, while per-user table view preferences are renderer-local.
- Locks/stages and ordering events are attributed using the authenticated display name.

## Commands (run from repo root)
- Install: `pnpm install`
- Dev: `pnpm dev`
- NC-Cat embedded: `pnpm nc`
- Tests: `pnpm exec vitest`
- Format: `pnpm format` or `pnpm format:check`

## Conventions to keep
- Keep Main thin; push business rules into `services/` and DB access into `repo/`.
- Renderer never touches filesystem; always go Renderer → Preload → Main.
- Always return the result envelope and surface meaningful `error.message` to the UI.
- Validate all IPC inputs in Main; treat Renderer input as untrusted.
- For subscriptions, track listeners per `WebContents` and clean up on unmount.
- Follow existing CSS variables and themes (`docs/STYLING.md`).

## Where to look for flows
- Lifecycle overview: `docs/JOB-FLOW.md`
- File handling and staging rules: `docs/OPERATIONS_GUIDE.md`
- MES ingest: `docs/MES_AND_DATA.md`
- NC-Catalyst specifics: `docs/NC-CATALYST-INTEGRATION.md` (left untouched)
