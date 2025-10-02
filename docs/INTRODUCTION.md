## Welcome: Electron + TypeScript + Tailwind (Beginner Lesson)

This project is an Electron desktop app written in TypeScript with a Tailwind-assisted UI. If you are brand new to Electron or desktop development, start here.

### What Electron Is (and is not)
- Electron lets you build desktop apps using web technologies (HTML, CSS, JavaScript).
- It bundles two major pieces: Chromium (for the UI) and Node.js (for system access).
- Your code runs in separate processes that talk over a bridge called IPC.
- Electron is not a browser and not a web server; it is a desktop runtime that ships with your app.

### Big Picture: Main, Preload, Renderer
- Main process (Node.js): Starts your app, creates windows, talks to the OS, reads files, and owns powerful APIs.
- Renderer process (Chromium): Runs your UI (e.g., React). It is like a browser tab for your app window.
- Preload script (bridge): Runs before the Renderer loads. It safely exposes a small, controlled API (`window.api`) so your UI can ask Main to do work.

---

## Deep Dive: The Key Components (Beginner Friendly)

### What is Node.js?
- Node.js is a JavaScript runtime built on the V8 engine (the same engine used by Chrome). It lets JavaScript run outside the browser.
- It provides access to the filesystem, network, processes, and many operating system features.
- In Electron, the Main process is a Node.js process. That is why the Main can read files, spawn processes, and manage windows.
- Why it matters: Your Renderer (UI) should avoid direct system access. Instead, ask the Main process (Node.js) to do privileged work through IPC. This separation keeps your app safer and easier to reason about.

### What is Chromium?
- Chromium is an open-source browser engine (the core of Google Chrome). Electron embeds Chromium to render your app's UI.
- It understands HTML, CSS, and modern Web APIs, and it gives you familiar tools like DevTools for debugging.
- Every BrowserWindow in Electron is effectively a Chromium-powered page dedicated to your app.

### What is a Renderer?
- A Renderer process is a Chromium page that displays and updates your UI.
- It runs your front-end code (e.g., React, plain JS) and handles user interactions.
- By default (with context isolation enabled), it does NOT have direct access to Node.js or the filesystem. That's on purpose for security.
- If the UI needs data from disk or needs to perform an OS-level task, it asks the Main process via the Preload bridge and IPC.

### What is the Main process?
- The Main process is the 'brain' of an Electron app. It runs first, creates windows, registers IPC handlers, and can call OS APIs.
- It decides when to show a window, what preload script to load, and how to respond to requests from the UI.
- Treat it like a backend that lives inside your desktop app.

### What is the Preload script?
- The Preload script runs in a special, isolated context that can see both the Renderer and limited Electron APIs (e.g., `ipcRenderer`, `contextBridge`).
- Its job is to expose a safe, minimal API into the Renderer with `contextBridge.exposeInMainWorld()`.
- Example: expose `window.api.readTextFile(path)` that internally calls the Main process to actually read from disk.
- The Preload keeps your UI safe by not leaking Node.js or powerful APIs directly into the page.

### What is IPC (Inter-Process Communication)?
- IPC is how the Main and Renderer processes send messages to each other.
- Think of it as a request/response pipeline and event stream between UI and backend.
- Common patterns you will use:
  - Request/response (recommended): Renderer calls `ipcRenderer.invoke(channel, request)`; Main handles with `ipcMain.handle(channel, handler)` and returns a result.
  - One-way events: Renderer sends `ipcRenderer.send(channel, payload)`; Main listens with `ipcMain.on(channel, listener)` (and vice versa with `webContents.send`).
- Why IPC exists: Main and Renderer run in separate processes for stability and security. They must communicate by sending messages, not by sharing memory or direct references.
- Safety first:
  - Only expose the minimum set of channels and functions your UI needs.
  - Validate and sanitize all data in Main before using it (never trust the Renderer input blindly).
  - Keep Node integration disabled in the Renderer; use Preload and `contextIsolation: true`.

---

## How Everything Works Together (Lifecycle)
- App starts: Electron launches the Main process (Node.js).
- Main creates a `BrowserWindow` and points it at your UI's HTML/URL.
- Main attaches a Preload script to that window.
- Preload runs before the page loads and exposes `window.api`.
- Renderer loads and can now call `window.api.*` to request work from Main via IPC.
- Main performs privileged work (file I/O, OS calls), returns results, and Renderer updates the UI.

---

## Example: A Tiny IPC Call

Below is a minimal, end-to-end example you can compare with this repo's structure. The idea: the UI asks for the app version.

- Main (Node): register a handler
```
// main.ts
import { app, ipcMain } from 'electron'

ipcMain.handle('app:getVersion', async () => {
  return app.getVersion()
})
```

- Preload (bridge): expose a safe function
```
// preload.ts
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  getAppVersion: () => ipcRenderer.invoke('app:getVersion')
})
```

- Renderer (UI): call the exposed API
```
// renderer.tsx
const version = await window.api.getAppVersion()
console.log('App version:', version)
```

Key points:
- Renderer never touches Node APIs directly.
- Preload exposes a single, typed surface (`window.api`).
- Main owns the privileged logic and returns results.

---

## Project Layout in This Repo
- Main: `packages/main/src` (creates windows, registers IPC handlers, services)
- Preload: `packages/preload/src/index.ts` (exposes `window.api`)
- Renderer: `packages/renderer/src` (React UI and styling)

## TypeScript in This Project
- TypeScript adds types to JavaScript to catch mistakes early.
- It improves autocomplete, refactoring, and cross-file consistency.
- In Electron, it's especially helpful to keep IPC request/response types aligned between Main, Preload, and Renderer.

## Tailwind CSS in This Project
- Tailwind is a utility-first CSS framework (e.g., `px-2`, `rounded`, `text-sm`).
- It helps you style quickly without writing lots of custom CSS.
- This repo uses a small set of custom variables/utilities for theming and glass effects.

## Security Basics (Must-Know)
- Keep `contextIsolation: true` and do not enable `nodeIntegration` in the Renderer.
- Expose only what you need via Preload; avoid dumping Node APIs into `window`.
- Validate all IPC inputs in Main and prefer `ipcMain.handle`/`ipcRenderer.invoke` for clear request/response flows.

## Glossary
- Main process: Node.js runtime managing the app and windows.
- Renderer process: Chromium page that runs your UI.
- Preload: a small script that exposes a safe API from Main to Renderer.
- IPC: Inter-Process Communication (messages between Main and Renderer).
- ContextIsolation: Electron setting that isolates the Renderer from Node.

## Next Steps
- Read `docs/ARCHITECTURE.md` for a deeper tour of how code is organized.
- Read `docs/IPC.md` for more IPC patterns (requests, subscriptions, streaming).
- Read `docs/STYLING.md` to see how Tailwind and theming work here.
