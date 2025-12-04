# NC‑Catalyst ↔ Woodtron Electron Integration TODO

This file tracks the high‑level work required to fully integrate NC‑Catalyst (NC‑Cat) with Woodtron Electron (WE), using the contracts and flows described in:

- `docs/NC-CATALYST-INTEGRATION.md` (sections 4.2–4.7 in particular).
- `docs/MES-JSON-SPECIFICATION.md` for MES/validation JSON.
- `resources/nc-catalyst-2/settings.json` and `resources/nc-catalyst-2/js/*` for the current NC‑Cat settings shape and UI.

> Design choice: NC‑Cat is the **authoring UI** for machine/tool configuration.  
> WE is the **only writer** to the local Postgres DB (see section 4.7 of `docs/NC-CATALYST-INTEGRATION.md`).

---

## Phase 1 – Contracts + Settings Snapshot Wiring (no DB writes yet)

- [ ] Finalise TypeScript contracts for:
  - `NcCatSettingsSnapshot`, `MachineConfig`, `ToolLibraryTool`, `ToolStrategy` (as sketched in `docs/NC-CATALYST-INTEGRATION.md` §4.2, §4.5, §4.6).
  - `SharedSettingsSnapshot` (host view that WE exposes back to NC‑Cat).
- [ ] Ensure NC‑Cat builds a complete `NcCatSettingsSnapshot`:
  - [x] Multi‑machine shape in `resources/nc-catalyst-2/js/storage-controller.js` (`buildSettingsSnapshot`).
  - [x] Per‑machine state (`State.machines`, `SettingsController.updateCurrentMachineFromStateAndDOM`).
  - [x] Explicit helper to export `NcCatSettingsSnapshot` from the NC‑Cat app (via `StorageController.buildSettingsSnapshot`, used by SettingsOperationsManager.syncSettingsToHost).
- [x] Add IPC endpoint in WE (main process) for settings updates:
  - [x] Define a channel `nc-catalyst:settings-updated` in `packages/main/src/ipc/hypernest.ts`.
  - [x] Handler accepts a `NcCatSettingsSnapshot`-shaped payload and **currently just logs / validates it** (no DB writes in Phase 1).
- [x] Expose a preload API for NC‑Cat to call from the BrowserWindow:
  - [x] Extend `window.electronApi.ncCatalyst` in `packages/preload/src/index.ts` with `syncSettings(snapshot)`.
  - [x] This method is only available in the NC‑Cat window (preload partition `persist:nc-catalyst`), not in the main WE renderer.
- [x] NC‑Cat UI hook:
  - [x] Add a “Sync Settings to NestWatcher” action inside NC‑Cat (`sync-settings-host-button` in the Settings modal).
  - [x] On click, build `NcCatSettingsSnapshot` and call `window.electronApi.ncCatalyst.syncSettings(snapshot)` via `SettingsOperationsManager.syncSettingsToHost()`.
- [x] Basic logging + error surfacing:
  - [x] On WE side, log accepted snapshots and basic validation errors.
  - [x] On NC‑Cat side, show a toast/alert + log message if the IPC call fails.

> Outcome of Phase 1:  
> - NC‑Cat can emit a full settings snapshot.  
> - WE can receive and validate it over IPC.  
> - **No database writes yet** – just plumbing and contracts.

---

## Phase 2 – Database Mapping (apply snapshot to Postgres)

> `docs/schema.sql` now reflects the NC‑Cat machine columns and global tool library. Phase 2 wires the settings snapshot ingestion into this schema.

- [x] **Schema + migrations**
  - [x] Extend `public.machines` with `nc_cat_machine_id text UNIQUE`, `nc_cat_config jsonb`, `settings_version text`, and `last_settings_sync_at timestamptz` (see §4.6.1 and `docs/schema.sql`).
  - [x] Introduce `public.tool_library` plus indexes + trigger (see §4.6.2 and `docs/schema.sql`).
  - [x] Confirm no further relational tables are required for now (machine-specific tool changers/strategies live inside `machines.nc_cat_config` per §4.6).
- [x] **Snapshot ingestion service (`packages/main/src/services/ncCatSettings.ts`)**
  - [x] Expose `applyNcCatSettingsSnapshot(rawSnapshot)` that validates the payload, normalises it, and applies it using `withDb`.
  - [x] Upsert `machines` rows by `MachineConfig.id` → `machines.nc_cat_machine_id`, persisting the raw `machineConfig` JSON to `machines.nc_cat_config` and updating `settings_version` / `last_settings_sync_at`.
  - [x] Upsert `tool_library` entries from the union of `snapshot.toolLibrary` and per‑machine `toolLibrary` arrays.
  - [ ] (Optional, later) Prune `tool_library` rows that no longer exist in the snapshot if we decide we never want “orphaned” tools.
- [x] **IPC wiring**
  - [x] Update `packages/main/src/ipc/hypernest.ts`’s `nc-catalyst:settings-updated` handler to call `applyNcCatSettingsSnapshot`, and log failures via the main process logger.
  - [ ] Surface structured success/error metadata back to NC‑Cat (e.g. a `SyncSettingsResult` payload) so the UI can show more informative results than just a toast.
  - [ ] Add basic version checks (e.g. compare incoming `snapshot.version` with `machines.settings_version`) and optionally reject obviously older snapshots.
- [ ] **Tests + fixtures**
  - [ ] Add unit tests for the ingestion service covering: inserting a new machine, updating existing machine configs (including tool changers/strategies inside the JSON), and removing stale records.
  - [ ] Create snapshot fixtures under `packages/main/test/fixtures/` to simulate multi‑machine exports (different machine IDs, tool libraries, and varied machine config payloads).
  - [ ] Add an integration test (or smoke test) that exercises the IPC handler end‑to‑end by mocking a snapshot from the NC‑Cat preload and asserting the DB writes + log output.

---

## Phase 3 – Bidirectional Shared Settings (WE → NC‑Cat)

- [x] Implement a WE endpoint to expose `SharedSettingsSnapshot`:
  - [x] Include `processedJobsRoot`, `jobsRoot`, `quarantineRoot`, and a minimal `machines` view (`SharedMachineConfig[]`) via `packages/main/src/ipc/hypernest.ts` (`nc-catalyst:get-shared-settings`).
  - [x] Add a preload bridge (`window.electronApi.ncCatalyst.getSharedSettings`) that NC‑Cat can call when running inside NestWatcher.
- [x] In NC‑Cat:
  - [x] Add a “NestWatcher installed on this PC” toggle in the Settings modal (`nestwatcher-installed-checkbox`).
  - [x] When enabled, call `SettingsOperationsManager.fetchSharedSettingsFromHost()` to fetch and log the host`s `SharedSettingsSnapshot`, and show a log message indicating the number of machines available.

---

## Phase 4 – NC‑Cat ↔ WE Job / MES Integration

- [ ] Implement `OpenJobInSimulatorRequest` IPC (`nc-catalyst:open-job`) so WE can open jobs directly in NC‑Cat (see §7).
- [ ] Implement `ValidationOverrideRequest` → WE (for operator overrides on warnings; see §8.3).
- [ ] Align MES / validation JSON with `MesData` / `MesFileData` contracts:
  - [ ] Ensure NC‑Cat exporter emits full MES data per `docs/MES-JSON-SPECIFICATION.md`.
  - [ ] Wire WE’s ingestion pipeline to use NC‑Cat’s headless validation instead of reading `validation.json` from disk (long‑term goal).

---

## Phase 5 – Standalone NC‑Cat + Supabase Integration

*(Separate product; no direct impact on local Postgres, but shares contracts and engine.)*

- [ ] Implement Supabase auth (email/password) and license checks in NC‑Cat.
- [ ] Use Supabase Functions for billing/subscription management (Stripe integration).
- [ ] Reuse `NcCatSettingsSnapshot` and MES contracts for tenant‑level configuration and telemetry, where appropriate.
