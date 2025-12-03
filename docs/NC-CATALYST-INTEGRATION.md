# NC Catalyst Integration, Licensing, and Contracts Plan

## 1. Context and Goals

This document describes how **Woodtron Electron** (WE) and **NC Catalyst** (NC‑Cat) will work together as a cohesive product family, while still allowing NC‑Cat to be developed, licensed, and shipped as a standalone application.

High‑level goals:

- Keep **NC‑Cat** as a standalone product (own repo, own Electron wrapper, own updates).
- Plug **NC‑Cat** into **WE** as a **Simulator** window:
  - From the Jobs table, users can right‑click a job/folder → **Open Simulator** → NC‑Cat opens in a separate Electron window with the related NC files loaded.
- Implement **per‑machine licensing** using **Supabase** (auth/licensing data) + **Stripe** (payments).
- Make **NC‑Cat** the source of truth for online auth and licensing:
  - If users log into NC‑Cat, WE is automatically authenticated/authorized.
- Support an **offline grace period** (7 days) and then lock out if billing is not resolved.
- Allow NC‑Cat to run as a **web app** (e.g. deployed to Vercel) while also being wrapped in Electron:
  - Web version for convenience/fast updates.
  - Electron version(s) for desktop customers and for integration into WE.
- Protect core NC‑Cat IP as much as practical:
  - Ship compiled JS only (no TS, no source maps).
  - Minify/obfuscate.
  - Optionally move sensitive algorithms into native modules or WebAssembly (WASM).

To keep WE and NC‑Cat loosely coupled but safe to evolve, we introduce a small shared contracts package: **`@woodtron/contracts`**. This defines the runtime protocol and data contracts between:

- WE ↔ NC‑Cat Simulator window (Electron IPC).
- Hosts (WE, NC‑Cat Electron wrapper) ↔ NC‑Cat core validation engine.

This document is a **plan**, not an implementation. It is meant to be kept up‑to‑date as we implement phases.

---

## 2. Actors and Components

**Applications**

- **WE (Woodtron Electron)**  
  - Existing Electron app (this repo) with React/Vite renderer and worker/watchers.
  - Own local users stored in Postgres (per‑site operators).
  - Always ships with an embedded NC‑Cat Simulator.

- **NC‑Cat (Core)**  
  - Core validation/visualisation engine and UI.
  - Initially a browser app (HTML + JS + CSS), to be migrated to React + Tailwind + TypeScript.
  - Lives in its own repo; a copy or build output is embedded into WE under `resources/nc-catalyst-2`.

- **NC‑Cat Electron (Standalone)**  
  - A small Electron wrapper around NC‑Cat core.
  - Standalone desktop product offered to customers who do not have WE.
  - Handles Supabase auth + license checks + Stripe billing links.

**Services**

- **Supabase**
  - Authentication (email + password).
  - Database for customer accounts, subscriptions, machines, telemetry.
  - Supabase Functions for licensing checks and Stripe webhook handling.

- **Stripe**
  - Billing and subscriptions.
  - Stripe Checkout + Customer Portal for customers to buy/modify/cancel plans.
  - We link from WE/NC‑Cat into Stripe‑hosted flows instead of building our own billing UI.

**Shared Code**

- **`@woodtron/contracts`**
  - Shared TypeScript types and protocol definitions.
  - Used by:
    - WE (main, preload, renderer).
    - NC‑Cat core / UI.
    - NC‑Cat Electron wrapper.
    - Any Supabase Functions that need to understand validation or licensing payloads.

---

## 3. Repos and Package Layout

### 3.1. Woodtron Electron (this repo)

- Main Electron app with:
  - Postgres database, watchers, MES integration.
  - React UI for dashboard, jobs, settings, etc.
- NC‑Cat is included as resources under `resources/nc-catalyst-2` (today static browser app).
- Planned addition: `packages/contracts` (or equivalent) for `@woodtron/contracts`.

### 3.2. NC‑Cat Repo (external)

- Separate repository, dedicated to NC‑Cat.
- Contains:
  - Core validation engine (pure JS/TS, later potentially WASM/native).
  - UI layer (React/Tailwind, TypeScript) for:
    - Browser SPA (deployed to Vercel).
    - Electron shells (standalone NC‑Cat, and the embedded Simulator inside WE).
- Build outputs:
  - A static bundle (HTML/JS/CSS) that can be:
    - Deployed as a web app.
    - Embedded in WE (under `resources/nc-catalyst-2`).
    - Loaded by standalone NC‑Cat Electron.

### 3.3. Shared Contracts Package (`@woodtron/contracts`)

We introduce a small shared package for cross‑app contracts:

- Suggested location in this monorepo: `packages/contracts`.
- Published internally as `@woodtron/contracts`.
- **No runtime dependencies** (pure TypeScript type-only + constants).
- Semantic versioning:
  - Patch/minor: additive, backward compatible.
  - Major: breaking changes to protocol or schemas.

All components (WE, NC‑Cat core, NC‑Cat Electron, Supabase Functions) depend on `@woodtron/contracts` for their compile‑time contracts.

---

## 4. `@woodtron/contracts` – Draft Design

This section outlines what `@woodtron/contracts` will look like. Exact file names and modules may change, but the concepts should remain stable.

### 4.1. Versioning Exports

`version.ts`:

```ts
export const CONTRACTS_VERSION = '1.0.0';

// Protocol version between WE and NC‑Cat (IPC).
// Used at runtime in a handshake.
export const PROTOCOL_VERSION = '1.0.0';

// MES data schema version for persisted MES/validation data.
// Bump major when breaking changes to MesData/MesFileData schema are made.
export const MES_SCHEMA_VERSION = 1;
```

### 4.2. Core Types (Jobs and Machines)

`jobs.ts`:

```ts
export type JobKey = string; // Stable key used by WE DB and NC‑Cat; one NC file == one job.

export interface JobDescriptor {
  key: JobKey;
  ncFileName: string;        // Name of the NC file (e.g. "JOB1234.NC").
  folderPath: string;        // Absolute or root-relative folder path, including subfolders.
  machineId?: string;        // Machine configuration identifier (optional but recommended).
  material?: string | null;  // Material associated with this job/file, if known.
}
```

In this model:

- A **job** is a single NC file.
- A **folder** is not itself a job; folders simply group jobs.
- `key` can be defined as a normalised combination of `folderPath` + `ncFileName` (matching WE’s existing DB keys).

`machines.ts` + `settings.json` (high‑level sketch; actual shape mirrors NC‑Cat’s new multi‑machine `settings.json`):

```ts
export interface MachineParams {
  g0_feed_x: number;
  g0_feed_y: number;
  g0_feed_z: number;
  g0_accel_x: number;
  g0_accel_y: number;
  g0_accel_z: number;
  g1_accel_x: number;
  g1_accel_y: number;
  g1_accel_z: number;
  tool_change_time: number;
  corner_penalty_ms: number;
  origin: 'front-left' | 'front-right' | 'back-left' | 'back-right' | string;
  max_router_plunge: number;
  max_drill_plunge: number;
  min_feed_rate: number;
  max_feed_rate: number;
  min_spindle_rpm: number;
  g0_safe_height: number;
  mcode_times: Record<string, number>;

  // Validation toggles
  check_invalid_characters: boolean;
  check_missing_values: boolean;
  check_missing_decimals: boolean;
  check_g43_missing: boolean;
  check_tool_offset_mismatch: boolean;
  check_g0_rapid_moves: boolean;
  check_plunge_depths: boolean;
  check_spindle_rpm: boolean;
  check_feed_rates: boolean;
  check_spindle_state: boolean;
  check_out_of_bounds: boolean;
  check_duplicate_holes: boolean;
  check_small_part_thickness: boolean;
  check_single_pass_cutting: boolean;
  check_cutting_order: boolean;
  check_cut_through_depth: boolean;
  check_cutting_direction: boolean;
  check_drill_efficiency: boolean;

  rapid_down_min_distance: number;
  small_part_area_threshold: number;
  small_part_min_dimension: number;
  max_first_pass_thickness: number;
  min_first_pass_thickness: number;
  min_cut_through_depth: number;
  max_cut_through_depth: number;
  single_pass_cutting_method: string;
  multi_pass_cutting_method: string;
}

export interface DrillHeadHole {
  b: number;
  hand: 'LEFT' | 'RIGHT';
  dia: number;
  x_pos: number;
  y_pos: number;
}

export type DrillHeadLayout = Record<string, DrillHeadHole>;

// Placeholder; will be refined as NC‑Cat's tool strategies stabilise.
export interface ToolStrategy {
  [key: string]: unknown;
}

export interface MachineConfig {
  id: string;               // Stable ID, used in WE DB and NC‑Cat.
  name: string;             // Operator-friendly name ("Nesting Line 1").
  type?: string;            // e.g. "nesting", "saw", etc.

  // Per‑machine settings owned by NC‑Cat
  machineParams: MachineParams;
  drillHeadLayout: DrillHeadLayout;
  toolChangerCount: number;
  toolChangers: ToolChangerConfig[]; // See below.
  toolLibrary: ToolLibraryTool[];    // Tools known to this machine.
  toolStrategies: ToolStrategy[];    // Strategy rows derived from tool library.
}

export interface ToolChangerConfig {
  id: string;                      // e.g. "changer-1"
  type: 'rotary' | 'linear' | string;
  positionsCount: number;          // e.g. 15
  positions: Record<string, string | null>;
  // key: position index as string ("1", "2", ...)
  // value: toolLibrary.id or null
}

export interface ToolLibraryTool {
  id: string;                      // Unique per tool, used as foreign key.
  name: string;                    // Human name ("10MM 2W").
  type: string;                    // e.g. "end-mill".
  diameter: number;                // mm
  length: number;                  // mm

  // Optional strategy-related fields (mirroring NC‑Cat UI)
  spindleRpm?: number;
  cuttingSpeed?: number;
  leadInOut?: number;
  plungeRate?: number;
  materialType?: string;
  maxDepth?: number;
  toolDiameter?: number;

  createdAt?: string;
  updatedAt?: string;
}

export interface ToolStrategy {
  id: string;                      // strategy_<toolId>
  toolId: string;                  // ToolLibraryTool.id
  toolNumber: number | null;       // Resolved from tool changers; null if unassigned.

  spindleRpm: number;
  cuttingSpeed: number;
  leadInOutLength: number;
  plungeRate: number;
  materialType: string;
  toolDiameter: number;
  maxDepth: number;

  createdAt: string;
  updatedAt: string;
}

// Top‑level NC‑Cat settings.json snapshot (new shape)
export interface NcCatSettingsSnapshot {
  // Global settings (shared across machines)
  worklist: { name: string; content: string }[];
  availableDrills: number[];
  routerSafetyHeight: number;
  toolDiameterSource: 'nc-detected' | 'tool-changer';

  // Per‑machine configuration
  machines: MachineConfig[];

  // Legacy top-level fields for backward compatibility (mirrors of the first machine)
  machineParams: MachineParams;
  drillHeadLayout: DrillHeadLayout;
  toolStrategies: ToolStrategy[];
  toolLibrary: ToolLibraryTool[];
  toolChangerCount: number;
  toolChangers: ToolChangerConfig[];

  // Metadata added by NC‑Cat when exporting
  version: string;                 // e.g. "1.0"
  lastModified: string;            // ISO timestamp
  application: string;             // "NC File Simulator & Worklist"
  description?: string;
}
```

Machine configuration is owned by NC‑Cat (NC‑Cat UI can define **multiple machines**, name them, and edit full settings including feeds/speeds, drill head layout, tool changers, and tool strategies). WE stores these machine configs in its DB, using the same `MachineConfig` schema and preserving `id`, so that:

- Each job knows which machine it is intended for (`machineId`).
- Both WE and NC‑Cat can simulate/validate jobs correctly for that machine.
- WE can round‑trip NC‑Cat’s `settings.json` (or machine subset) into its DB and back, without schema translation.

### 4.3. MES Data and Validator Types

We split the concepts into:

- **MES data**: the full per‑file output NC‑Cat produces today (runtime, yield, dust, tool usage, drill usage, validator status, nest pick, etc.). This is currently represented in code by `ValidationJson` / `ValidationFileEntry` / `ValidationDataRes` in `packages/shared/src/mesValidation.ts`, and will be renamed and shared via contracts as `MesData`/`MesFileData`.
- **Validator result**: just the error/warning/syntax/status information for a file (the nested `validation` object in the JSON).

`mes.ts` (high‑level sketch mirroring the current JSON):

```ts
export interface MesExportMetadata {
  exportDate?: string | null;
  exportedBy?: string | null;
  mesOutputVersion?: string | null;
  folderName?: string | null;
  status?: 'pass' | 'fail' | string | null; // Normalised from "Status" in JSON.
  originalFolderPath?: string | null;
  newFolderPath?: string | null;
}

export interface MesValidator {
  status: 'pass' | 'warnings' | 'errors';
  warnings: string[];
  errors: string[];
  syntax: string[];
}

export interface MesOffcut {
  x: number;
  y: number;
  z: number;
}

export interface MesToolUsage {
  toolNumber: string;
  toolName: string;
  cuttingDistanceMeters: number;
  toolDustM3: number;
  // Additional properties from NC‑Cat are allowed but not required in the contract.
}

export interface MesDrillUsage {
  drillNumber: string;
  drillName: string;
  holeCount: number;
  drillDistanceMeters: number;
  drillDustM3: number;
  // Additional properties from NC‑Cat are allowed but not required in the contract.
}

export interface MesNestPickResult {
  canAllBePicked: boolean | null;
  partsTooLargeForPallet: { partNumber: string; reason: string }[];
  failedParts: { partNumber: string; reason: string }[];
  palletAdjustedVolumeM3: number | null;
}

// Full MES data for a single NC file (one job).
export interface MesFileData {
  filename: string;
  folderName: string;
  folderPath: string;

  ncEstRuntime: number;        // seconds
  yieldPercentage: number;     // %

  usableOffcuts: MesOffcut[];
  wasteOffcutM2: number;
  wasteOffcutDustM3: number;
  TotalToolDustM3: number;
  TotalDrillDustM3: number;
  SheetTotalDustM3: number;

  toolUsage: MesToolUsage[];
  drillUsage: MesDrillUsage[];

  validation: MesValidator;
  nestPick: MesNestPickResult | null;
}

// Root MES JSON structure (per docs/MES-JSON-SPECIFICATION.md and docs/json_integration.md).
export interface MesData {
  schemaVersion: number;        // e.g. MES_SCHEMA_VERSION.
  exportMetadata?: MesExportMetadata;
  files: MesFileData[];
}
```

Implementation notes:

- These interfaces are effectively the shared contracts version of the existing types:
  - `ValidationJson` → `MesData`.
  - `ValidationFileEntry` → `MesFileData`.
  - `ValidationResult` → `MesValidator`.
- When we move this schema into `@woodtron/contracts`, we should:
  - Include **all** fields NC‑Cat currently outputs in its MES JSON (as shown above and in `packages/shared/src/mesValidation.ts`).
  - Keep `schemaVersion`/`MES_SCHEMA_VERSION` aligned with that JSON schema and bump only for breaking changes.

`license.ts`:

```ts
export type LicenseStateCode =
  | 'ok'
  | 'grace'
  | 'locked'
  | 'no-subscription'
  | 'unlicensed'
  | 'unknown';

export interface LicenseStatus {
  state: LicenseStateCode;
  graceDaysRemaining?: number; // 0–7 for offline grace/overdue.
  subscriptionId?: string;
  planId?: string;
  reason?: string;
}

export interface LocalLicenseState {
  machineId: string;
  lastOnlineCheck: string | null;  // ISO date string.
  offlineDaysUsed: number;         // Integer, days counted since last online check.
  lastStatus: LicenseStatus | null;
  locked: boolean;
}
```

### 4.4. Host ↔ NC‑Cat Protocol Types

`protocol.ts`:

```ts
// Handshake
export interface HostHandshake {
  hostName: 'WE' | 'NC-CAT-STANDALONE';
  hostVersion: string;       // e.g. "1.3.0"
  protocolVersion: string;   // from PROTOCOL_VERSION.
}

export interface NcHandshake {
  ncVersion: string;             // e.g. "2.4.0"
  supportedProtocolRange: string; // e.g. "1.0-1.3"
}

// Open jobs in Simulator (one or many NC files)
export interface OpenJobInSimulatorRequest {
  jobs: JobDescriptor[];
}

// NC‑Cat → WE: operator overrides warnings for a job/batch.
export interface ValidationOverrideRequest {
  jobKeys: JobKey[];
  overrideReason?: string;
}

export interface ValidationOverrideResult {
  success: boolean;
  failedJobKeys?: JobKey[];
  errorMessage?: string;
}

// NC‑Cat → WE: push back computed MES data (for future deeper integration).
export interface MesResultsUpdate {
  files: MesFileData[];
}
```

These types provide a stable surface for:

- WE asking NC‑Cat to open one or more jobs (NC files) in the Simulator.
- NC‑Cat telling WE that a user approved an override.
- NC‑Cat optionally pushing structured validation data back into WE.

### 4.5. Shared Settings Types

We also need to share a subset of WE settings with NC‑Cat so that:

- NC‑Cat can move successfully validated jobs into WE’s **processed jobs root**.
- Both apps agree on shared folders and machine behaviour.

`settings.ts` (shared host‑side view of NC‑Cat settings + WE paths):

```ts
export interface SharedSettingsSnapshot {
  processedJobsRoot: string; // Root folder where WE expects processed jobs.
  jobsRoot: string;          // Root folder where NC‑Cat watches for new jobs.
  quarantineRoot?: string;   // Optional root folder for quarantined jobs.

  machines: MachineConfig[]; // Machine configurations shared between WE and NC‑Cat (from NcCatSettingsSnapshot.machines).

  nestWatcherInstalled: boolean; // If true, NC‑Cat treats WE as present and uses these settings.

  // Optional future: echo NC‑Cat’s global metadata for audit/debug
  ncCatVersion?: string;
  ncCatSettingsVersion?: string;
}
```

Rules:

- WE is the **source of truth** for shared settings persisted in its DB.
- NC‑Cat has its own local configuration (machine definitions, etc.) but:
  - If `nestWatcherInstalled` is `true`, NC‑Cat reads `SharedSettingsSnapshot` from WE and uses those settings for shared paths and machine IDs.
  - If `nestWatcherInstalled` is `false`, NC‑Cat behaves purely as a standalone app and does not assume WE is present.

### 4.6. WE Database Shape for Machine Settings (planned)

WE should mirror the new NC‑Cat `settings.json` structure in its database so that:

- NC‑Cat remains the **authoring UI** for machine configs.
- WE is the **system of record** for production settings.
- A change in NC‑Cat can be pushed to WE as a single `NcCatSettingsSnapshot`, and WE decomposes it into relational tables.

High‑level DB sketch (to be implemented later, not yet in `schema.sql`):

```sql
-- Machine catalog (one row per NC‑Cat machine)
CREATE TABLE machines (
  id TEXT PRIMARY KEY,           -- NcCat MachineConfig.id
  name TEXT NOT NULL,
  type TEXT,

  -- Optional references to latest settings export
  settings_version TEXT,
  last_modified TIMESTAMPTZ,

  -- Raw JSON column if we want to preserve the full blob
  settings_json JSONB NOT NULL
);

-- Per-machine tool library
CREATE TABLE machine_tool_library (
  id TEXT PRIMARY KEY,           -- ToolLibraryTool.id
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  type TEXT NOT NULL,
  diameter NUMERIC NOT NULL,
  length NUMERIC NOT NULL,

  spindle_rpm NUMERIC,
  cutting_speed NUMERIC,
  lead_in_out NUMERIC,
  plunge_rate NUMERIC,
  material_type TEXT,
  max_depth NUMERIC,
  tool_diameter NUMERIC,

  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

-- Per-machine tool changers
CREATE TABLE machine_tool_changers (
  id TEXT PRIMARY KEY,           -- ToolChangerConfig.id
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  positions_count INTEGER NOT NULL
);

CREATE TABLE machine_tool_changer_positions (
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  changer_id TEXT NOT NULL REFERENCES machine_tool_changers(id) ON DELETE CASCADE,
  position_index INTEGER NOT NULL,
  tool_id TEXT REFERENCES machine_tool_library(id),
  PRIMARY KEY (machine_id, changer_id, position_index)
);

-- Per-machine tool strategies (one per tool with strategy data)
CREATE TABLE machine_tool_strategies (
  id TEXT PRIMARY KEY,           -- ToolStrategy.id
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  tool_id TEXT NOT NULL REFERENCES machine_tool_library(id),

  tool_number INTEGER,
  spindle_rpm NUMERIC NOT NULL,
  cutting_speed NUMERIC NOT NULL,
  lead_in_out_length NUMERIC NOT NULL,
  plunge_rate NUMERIC NOT NULL,
  material_type TEXT NOT NULL,
  tool_diameter NUMERIC NOT NULL,
  max_depth NUMERIC NOT NULL,

  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
```

Sync rules (planned behaviour):

- When the operator changes machine settings in NC‑Cat and clicks **Save to File**:
  - NC‑Cat produces an updated `NcCatSettingsSnapshot` (new multi‑machine `settings.json`).
  - Inside WE, the NC‑Cat wrapper (Simulator window) sends that blob to the WE main process as JSON (e.g. IPC: `ncCat:settings-updated` with `NcCatSettingsSnapshot`).
- WE:
  - Validates that `N` machines in `snapshot.machines` match or can be merged with rows in `machines` by `id`.
  - Upserts:
    - `machines` rows (id, name, type, `settings_json`, `settings_version`, `last_modified`).
    - `machine_tool_library`, `machine_tool_changers`, `machine_tool_changer_positions`, `machine_tool_strategies` using the IDs from the snapshot.
  - Keeps `Job.machine_id` pointing to `machines.id` so existing jobs automatically pick up updated settings for simulation/validation.

In other words:

- **NC‑Cat → WE**: pushes `NcCatSettingsSnapshot` whenever machine settings change.
- **WE DB**: decomposes and stores the snapshot in relational tables (plus raw `settings_json` for audit).
- **WE → NC‑Cat**: can optionally expose `SharedSettingsSnapshot` (including machines) back to NC‑Cat when **NestWatcher installed** is enabled, so both sides stay in sync on paths and machine IDs.

In the NC‑Cat UI we will have a setting like **“NestWatcher installed”**. When ticked:

- NC‑Cat expects WE integration to be available.
- It can hide or lock certain settings that are now controlled by WE (e.g. processed jobs root).

---

## 5. Runtime Protocol and Compatibility

Even with shared TypeScript contracts, WE and NC‑Cat are compiled and shipped separately. At runtime they only exchange JSON via IPC. We must handle compatibility explicitly.

### 5.1. Handshake Flow

1. When the NC‑Cat Simulator window starts, it performs a handshake with WE using `HostHandshake` and `NcHandshake`.
2. WE sends:
   - `hostName = 'WE'`
   - `hostVersion` (WE app version).
   - `protocolVersion = PROTOCOL_VERSION` (from contracts).
3. NC‑Cat responds with:
   - `ncVersion`.
   - `supportedProtocolRange` (e.g. `"1.0-1.3"`).
4. If WE’s `protocolVersion` is **not** within `supportedProtocolRange`, NC‑Cat:
   - Shows a friendly “Please update Woodtron Electron” message.
   - Refuses to operate as a plugin.
5. If compatible, both sides proceed and use that protocol version for message shapes and semantics.

### 5.2. Schema Versioning

`ValidationResult` includes `schemaVersion`:

- `schemaVersion` is used for **persisted data** (e.g. rows in WE’s DB).
- Rules:
  - Within a major schema version, prefer **additive** changes (add optional fields, not breaking existing ones).
  - When a breaking change is unavoidable, bump the **major** schema version.

WE can:

- Support multiple schema versions with migration code, or
- Refuse to ingest newer schema versions and prompt the operator to update WE.

### 5.3. NC‑Cat Updates vs Older WE

There are two phases for how NC‑Cat updates interact with WE.

#### Phase 1 (Startup Plan)

- WE embeds a specific NC‑Cat build under `resources/nc-catalyst-2`.
- When WE is updated, its NC‑Cat copy is updated as part of the release.
- There is **no independent auto‑update** for NC‑Cat inside WE.
- Standalone NC‑Cat Electron can still auto‑update independently.

This keeps versioning simple while we implement the protocol and licensing.

#### Phase 2 (Later: Independent NC‑Cat Updates inside WE)

When we want WE to update NC‑Cat independently of the WE release cycle:

- Publish NC‑Cat builds with a **compatibility manifest**, e.g.:

```json
{
  "ncReleases": [
    { "ncVersion": "2.4.0", "minWeVersion": "1.3.0", "downloadUrl": "..." },
    { "ncVersion": "2.3.0", "minWeVersion": "1.0.0", "downloadUrl": "..." }
  ]
}
```

- On startup, WE:
  - Knows its own version (e.g. `1.1.0`).
  - Chooses the newest NC‑Cat release where `minWeVersion <= hostVersion`.
  - Downloads that NC‑Cat bundle into `userData/nc-catalyst/<version>` and loads it from there.
- The handshake still protects against misconfigurations by checking protocol versions at runtime.

---

## 6. Licensing and Auth (Supabase + Stripe)

### 6.1. Overview

- Licensing is **per machine**.
- NC‑Cat handles **online auth and subscription checks** via Supabase.
- WE uses **local license state** written by NC‑Cat to decide if it should run.
- Operators inside WE remain local Postgres users; there is just one Supabase account per customer (per company).

### 6.2. Identity and License Model

- **Supabase Auth:**
  - Email + password only (no social providers).
  - One Supabase user account per customer/company.

- **Per‑Machine Licenses:**
  - Each installation generates a `machineId` on first run.
  - Stored locally and registered via Supabase Function (activation record).
  - Supabase tables track:
    - Subscriptions (linked to Stripe).
    - Machines (machineId, subscriptionId, status).

- **Seat Management:**
  - Initially, customers contact support to deactivate machines.
  - Admins update Supabase data manually.
  - Later, we can add an admin UI for self‑service.

### 6.3. Billing Flow (Stripe‑Hosted)

Rather than building a separate billing SPA, we leverage Stripe’s Checkout and Customer Portal:

- In NC‑Cat and WE (Settings → Billing), we add:
  - A button: **“Manage subscription”**.
- Clicking the button:
  - Calls a Supabase Function (or minimal backend endpoint) that:
    - Validates the Supabase user.
    - Creates a Stripe Checkout/Customer Portal session for that customer.
    - Returns the redirect URL.
  - The app opens that URL in the user’s external browser.

Stripe handles:

- Payment collection.
- Plan changes.
- Cancellation.

Supabase Functions handle:

- Responding to Stripe webhooks.
- Updating subscription status in Supabase.

WE and NC‑Cat simply read subscription/licensing status from Supabase and local cache.

### 6.4. License Check and Offline Grace

NC‑Cat is responsible for online checks; both NC‑Cat and WE share the same local license state (`LocalLicenseState`).

On startup:

1. NC‑Cat attempts an online license check via Supabase Function:
   - Inputs: `userId`, `machineId`.
   - Output: `LicenseStatus`.
2. If the check succeeds:
   - Update `LocalLicenseState`:
     - `lastOnlineCheck = today`.
     - `offlineDaysUsed = 0`.
     - `lastStatus = status`.
     - `locked = status.state === 'locked'`.
3. If the check fails or we are offline:
   - Compare current date to `lastOnlineCheck`.
   - If it’s a new calendar day, increment `offlineDaysUsed`.
   - If `offlineDaysUsed > 7`, set `locked = true`.

WE on startup:

- Reads `LocalLicenseState` from local storage.
- If `locked === true` or `lastStatus.state` is not acceptable:
  - Show a modal and refuse to run critical features.
- If license is OK or in grace:
  - Allow usage.
  - Optionally ask NC‑Cat to refresh license status in the background.

### 6.5. Relationship Between NC‑Cat and WE Auth

- NC‑Cat login:
  - User enters email+password.
  - NC‑Cat obtains Supabase tokens and performs license check.
  - Writes shared local auth/licensing state (tokens, `LocalLicenseState`) to disk (encrypted/obfuscated).

- WE startup:
  - Reads shared state.
  - If Supabase tokens and valid license are present:
    - Consider user “authenticated” at the company level.
    - Still uses local WE users for per‑machine/operator permissions.
  - If not present or expired:
    - Prompt user to open NC‑Cat to sign in and resolve licensing.

---

## 7. NC‑Cat Integration into WE (Simulator Window)

### 7.1. UX

- In the WE Jobs table:
  - Right‑click on a job/folder.
  - Context menu option: **“Open Simulator”**.
  - Selecting it opens or focuses the NC‑Cat Simulator window.

- The Simulator window:
  - Is a separate `BrowserWindow` in Electron (not a modal dialog, but can behave modally).
  - Loads NC‑Cat’s UI.
  - Automatically loads the NC files for the selected job.
  - Allows interactive visualisation, code browsing, warnings/errors view.

### 7.2. Technical Flow

1. **Renderer (WE)**:
   - On right‑click, sends an IPC message to main:
     - Channel: e.g. `'simulator:open-job'`.
     - Payload: `OpenJobInSimulatorRequest` (from `@woodtron/contracts`).

2. **Main Process (WE)**:
   - Maintains a single NC‑Cat Simulator `BrowserWindow`.
   - If window does not exist:
     - Creates it, loading NC‑Cat from `resources/nc-catalyst-2/index.html`.
     - Provides a **dedicated preload script** for NC‑Cat that:
       - Exposes a `window.electronApi` with:
         - `getInitialJob()`.
         - `onOpenJob(handler)`.
         - Handshake APIs.
   - Sends `OpenJobInSimulatorRequest` to the simulator window via IPC or `webContents.send`.

3. **NC‑Cat (in Simulator window)**:
   - On startup, performs the protocol handshake.
   - Listens for `OpenJobInSimulatorRequest`s via the preload‑exposed API.
   - Uses that information to:
     - Load the NC files from disk (host‑side file reading or pre‑parsed data).
     - Display the job in the UI.

### 7.3. Phase‑In Strategy for Validation

Initial integration focuses on visualisation:

- NC‑Cat Simulator window shows jobs and validation results as today (driven by NC‑Cat engine and UI).
- WE continues using its existing MES/validation pipeline (e.g. `validation.json`) for DB data.

Later, we migrate to NC‑Cat as the **single validation engine** (see Section 8).

---

## 8. Validation Pipeline (No `validation.json` on Disk)

The long‑term goal is for NC‑Cat to power both:

- **Headless validation** (for automatic job ingestion).
- **Interactive visualisation** (Simulator window).

### 8.1. Core Validation Engine

In the NC‑Cat repo, we extract a **core validation module** (pure logic, no DOM):

- Exposed API (rough sketch):

```ts
export interface ValidateJobsOptions {
  jobs: JobDescriptor[];
  settings: Record<string, unknown>; // Machine settings, overrides, etc.
}

export interface ValidateJobsResult {
  results: ValidationResult[];
}

export function validateJobs(
  options: ValidateJobsOptions
): Promise<ValidateJobsResult>;
```

- This module is:
  - Imported by WE (Node/headless).
  - Imported by NC‑Cat UI (browser) for interactive validation.
  - Potentially compiled to WASM/native for IP protection.

### 8.2. WE Ingestion Flow

1. User drops jobs into **Jobs Root** folder.
2. A watcher (existing watchers worker or new worker) detects new jobs.
3. The watcher:
   - Constructs `JobDescriptor`s for the new jobs.
   - Calls `validateJobs()` from the core engine.
4. For each job:
   - If **errors** are present:
     - Move the job folder to a **quarantine** folder.
     - Insert a record in WE DB marking it as `"quarantined-error"`.
   - If **warnings** are present:
     - Optionally move to quarantine as `"quarantined-warning"`.
     - Requires operator review/override.
   - If **no errors/warnings** (or warnings acceptable by policy):
     - Insert job into DB as **ready**.
     - Store derived stats (runtime, yield, etc.) on the job record.

### 8.3. Warnings and Overrides

For jobs with warnings:

- WE UI shows them as quarantined/warning state, with an action:
  - **“Review in Simulator”**.
  - Opens NC‑Cat window via `OpenJobInSimulatorRequest`.
- After review, if operator chooses to override:
  - NC‑Cat sends `ValidationOverrideRequest` with selected `jobKeys` back to WE.
  - WE:
    - Moves files from quarantine to production Jobs folder.
    - Inserts or updates DB records with full `ValidationResult` (including warnings).
    - Marks jobs as **ready but flagged** (e.g. red in Jobs table).
    - Optionally logs override events with user and timestamp.

---

## 9. Standalone NC‑Cat Electron App

The standalone NC‑Cat Electron app shares the same core and contracts, but operates without WE.

### 9.1. Responsibilities

- Present NC‑Cat UI as a desktop app.
- Handle Supabase auth (email + password).
- Handle licensing checks and offline grace via Supabase Functions.
- Provide a **Billing** section that opens Stripe Checkout/Customer Portal in the browser.
- Auto‑update itself using `electron-updater`.

### 9.2. Relationship to WE

- Uses `@woodtron/contracts` for common types and protocol version.
- Shares the same validation engine and IP‑protection strategy.
- Uses the same Supabase project and licensing rules as WE:
  - If a machine runs standalone NC‑Cat and WE, they share the same `machineId` and license state.

---

## 10. Code Protection and Build Strategy

Given the sensitivity of NC‑Cat’s logic, we adopt the following:

- For **both** WE and NC‑Cat:
  - Ship compiled JavaScript only (no TypeScript, no `.map` files).
  - Minify and, where appropriate, obfuscate code.
  - Consider extracting the most sensitive parts of the validation logic into:
    - A WebAssembly module (compiled from Rust/C++/TypeScript → WASM).
    - Or a native Node module.

- For **browser deployment** (Vercel):
  - Use the same build pipeline (compiled, minified, no source maps in production).
  - Optionally limit the feature set if full engine exposure in the browser is a concern.

These measures cannot completely prevent reverse engineering but significantly raise the effort required.

---

## 11. Phased Implementation Roadmap

### Phase 0 – Contracts and Documentation (this document)

- Add `@woodtron/contracts` package (structure as above).
- Implement basic version constants and type definitions.
- Wire contracts into WE and NC‑Cat repos as dependencies.

### Phase 1 – NC‑Cat Simulator Window in WE

- Add NC‑Cat Simulator `BrowserWindow` in WE main process.
- Add dedicated preload to expose IPC APIs to NC‑Cat.
- Implement protocol handshake (`HostHandshake`, `NcHandshake`).
- Implement `OpenJobInSimulatorRequest` flow from WE Jobs table to NC‑Cat UI.
- Keep existing MES/validation pipeline for DB data (no headless NC‑Cat yet).

### Phase 2 – Supabase Auth and Licensing

- Implement Supabase auth (email + password) in NC‑Cat:
  - Login UI.
  - License check via Supabase Function.
  - Local license state (`LocalLicenseState`) with offline grace logic.
- Make WE read license state on startup and enforce lock/grace.
- Add **Billing** links in NC‑Cat and WE Settings that open Stripe Checkout/Customer Portal.

### Phase 3 – Headless Validation Pipeline

- Extract NC‑Cat validation engine into a core module (potentially WASM).
- Use `validateJobs()` in WE watchers to validate jobs without writing `validation.json`.
- Implement quarantine folders and DB states (`quarantined-error`, `quarantined-warning`, etc.).
- Implement override flow:
  - NC‑Cat → WE via `ValidationOverrideRequest`.
  - WE updates DB, moves files, logs audit events.

### Phase 4 – Hardening and IP Protection

- Remove source maps from production builds.
- Ensure minification/obfuscation is in place.
- Move sensitive algorithms into WASM/native where appropriate.
- Add telemetry for:
  - License lockouts and offline grace usage.
  - NC‑Cat/WE version combinations in the field.

### Phase 5 – Optional Enhancements

- NC‑Cat asset updater inside WE with compatibility manifest.
- Admin panel:
  - View subscriptions, machines, telemetry.
  - Self‑service machine deactivation.
- More sophisticated seat management and machine fingerprinting.

---

## 12. Summary

This plan defines how WE and NC‑Cat evolve into a modular system with:

- A shared contracts package (`@woodtron/contracts`) for stable APIs.
- NC‑Cat as both a standalone app and an embedded Simulator inside WE.
- Per‑machine licensing enforced via Supabase + Stripe, with offline grace.
- A migration path from current MES/validation to NC‑Cat as the single validation engine.
- Practical IP protection through build and packaging strategies.

The next concrete step is to scaffold `@woodtron/contracts` and wire the basic handshake and Simulator window into WE, then iterate through the phases outlined above.
