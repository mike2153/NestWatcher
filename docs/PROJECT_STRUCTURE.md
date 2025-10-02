## Project Structure (Beginner Lesson)

This guide introduces how the repository is laid out and what each part does. It’s aimed at someone new to Electron, web dev, and TypeScript.

### Big Picture

The repo is a monorepo with separate packages for the Electron Main process, the Preload bridge, the Renderer UI, and shared types. You will mostly touch the Renderer (UI) and sometimes Preload/Main for new features.

### Top‑Level Files and Folders

- package.json — workspace metadata
- pnpm‑workspace.yaml — tells pnpm which folders are in the workspace
- docs/ — developer docs (start with INTRODUCTION.md)
- packages/
  - main/ — Electron Main process (Node side)
  - preload/ — the secure bridge exposing `window.api` to the UI
  - renderer/ — the React + Tailwind UI (Chromium side)
  - shared/ — shared TypeScript types and IPC schemas
- resources/ — app resources (e.g., static bundles used by features)
- tests/ — unit and integration tests

### The Four Packages

1) packages/main (Electron Main)
- Entry: `packages/main/src/main.ts` — creates the BrowserWindow and initializes app services
- IPC handlers: `packages/main/src/ipc/*.ts` — define what Main can do on request
- Services: `packages/main/src/services/*.ts` — business logic (worklist, ingest, diagnostics, etc.)
- Repo (DB): `packages/main/src/repo/*.ts` — DB queries and lifecycle transitions
- Workers: `packages/main/src/workers/watchersWorker.ts` — background watchers (AutoPAC, Nestpick, telemetry)
- Security/Logger: `packages/main/src/security.ts`, `packages/main/src/logger.ts`

2) packages/preload (Bridge)
- `packages/preload/src/index.ts` defines `window.api` using `contextBridge.exposeInMainWorld`
- Each method wraps `ipcRenderer.invoke(channel, args)` and returns a typed `{ ok, value | error }` envelope
- This keeps Renderer safe (no raw Node access) and strongly typed

3) packages/renderer (UI)
- Pages live in `packages/renderer/src/pages/*.tsx` (e.g., JobsPage, RouterPage)
- Shell layout: `packages/renderer/src/shell/AppLayout.tsx` (nav, header, theme application)
- Styling: `packages/renderer/src/index.css` (CSS variables + a few custom utilities) and Tailwind config
- Renderer calls `window.api.*` to talk to Main; renders results with React

4) packages/shared (Types)
- IPC schemas and types: `packages/shared/src/ipc.ts`
- Result envelope helpers: `packages/shared/src/result.ts`
- Shared enums and Zod schemas keep Main/Renderer in sync

### Typical Feature Flow (Add a new IPC)

1) Define the request/response types in `packages/shared/src/ipc.ts`
   - e.g., `MyFeatureReq`, `MyFeatureRes`, and add to `window.api` typings if needed

2) Implement the handler in Main under `packages/main/src/ipc/myFeature.ts`
   - Use `registerResultHandler('myFeature:doThing', async (_e, req) => ok(value))`
   - Put heavy logic in a `packages/main/src/services/*.ts` file

3) Expose it in Preload (`packages/preload/src/index.ts`)
   - Add `myFeature: { doThing: (req) => invokeResult('myFeature:doThing', req) }`

4) Call it from the Renderer
   - `const res = await window.api.myFeature.doThing(req)` and render `res.value` or show `res.error`

5) (Optional) Add a streaming update (subscription)
   - Main: `contents.send('myFeature:update', payload)` to push
   - Preload: helper subscribe/unsubscribe wrappers
   - Renderer: attach/detach listeners on mount/unmount

### Styling and Theming

Read `docs/STYLING.md`. In short:
- CSS variables on `:root` define color tokens and table font size
- Glass (frosted) panels are controllable per section (cards/nav/header) with presets
- Settings page updates localStorage and applies CSS variables immediately

### File Watchers & Job Flow

Read `docs/WATCHERS.md` and `docs/WORKLIST.md` for how AutoPAC CSVs and Worklist staging operate, including Nestpick forwarding.

### Tests

- `tests/unit/` — fast tests for small pieces
- `tests/integration/` — orchestrated tests across IPC/services
- You can follow existing tests to see usage patterns of IPC and services

### Running & Building (general guidance)

- Dev servers and scripts are defined in the root `package.json`
- Typical tasks:
  - Start UI/Main in dev mode (depends on project scripts)
  - Build main and renderer bundles for production
- Check existing scripts (without running anything you don’t intend to) to learn the flow

### Conventions to Follow

- Keep Main thin; put logic in `services/` and `repo/`
- Only expose safe, typed functions via Preload
- Renderer never uses Node APIs directly; use `window.api`
- Use the result envelope `{ ok, value | error }` and handle errors
- For subscriptions, always unsubscribe on unmount
- Use existing CSS variables and classes; extend via `docs/STYLING.md`

### Where to Start Reading Code

1) `packages/renderer/src/shell/AppLayout.tsx` — app structure & theme application
2) `packages/renderer/src/pages/JobsPage.tsx` — typical list+filters+IPC
3) `packages/preload/src/index.ts` — see what `window.api` contains
4) `packages/main/src/ipc/*` — IPC handlers and their services
5) `packages/shared/src/ipc.ts` — the shape of all IPC requests/responses

As you make changes, keep the flow in mind: Renderer (React) → Preload (`window.api`) → Main (IPC) → Service/Repo logic → back to Renderer.

