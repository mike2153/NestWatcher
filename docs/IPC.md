## IPC Guide: Calling Main From Renderer (Beginner Lesson)

IPC (Inter‑Process Communication) is how the React UI (Renderer) asks the Node side (Main) to do work. This project uses a consistent, type‑safe pattern.

### The Pattern
1) Preload defines `window.api.*` methods that wrap `ipcRenderer.invoke(channel, args...)`
2) Main registers `registerResultHandler(channel, handler)` that returns `{ ok, value | error }`
3) Renderer calls `await window.api.something.method(args)` and gets an envelope back

### Typed Result Envelope
Every call resolves to `{ ok: true, value }` or `{ ok: false, error }` so the UI never deals with thrown exceptions across the boundary.

### Example: Listing Router Jobs (DB View)
- Renderer: `window.api.router.list({ limit, machineId?, statusIn? })`
- Preload: wires `router:list`
- Main: `packages/main/src/ipc/router.ts` calls into `routerRepo.listMachineJobs`

### Example: Ready‑To‑Run Files (Filesystem View)
- Renderer: `window.api.files.listReady(machineId)`
- Main: `packages/main/src/ipc/files.ts` walks the machine’s folder and enriches each `.nc` with DB details

### Push Updates (Subscriptions)
Some features push data from Main to Renderer over channels:
- DB status: `db:status:update`
- Diagnostics: `diagnostics:update`
- Ready‑To‑Run files: `files:ready:update`

Flow:
1) Renderer subscribes → Preload attaches `.on(channel, handler)` and sends a subscribe request
2) Main keeps a map of subscribers (by `WebContents.id`) and `.send(...)`s updates
3) Renderer unsubscribes → Main removes listeners and cleans up

### Good Practices
- Don’t pass DOM objects or class instances over IPC; send plain data
- Always handle `{ ok: false, error }` in the UI to inform the user
- Unsubscribe on unmount to avoid leaks

