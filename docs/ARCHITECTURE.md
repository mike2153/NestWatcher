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
`watchersWorker.ts` runs background watchers (AutoPAC CSVs, Nestpick outputs) and telemetry sockets. It posts events back to Main over Node worker messaging, and Main forwards status into Diagnostics.

### Why the Bridge (Preload)?
- Security: Renderer doesn’t get Node APIs directly
- DX: A single `window.api` surface is easy to reason about and type

