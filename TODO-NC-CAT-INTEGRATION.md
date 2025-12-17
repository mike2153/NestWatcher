# NC‑Catalyst ↔ NestWatcher Integration TODO

> **Single source of truth** for the NC-Cat integration plan and progress.
> Last updated: 2025-12-17 (Phase 5 in progress - Supabase Auth & Licensing)

---

## Quick Status: What's Left to Complete Phase 5

### User Setup Required (External Services)
- [ ] **Supabase**: Create project, run schema from `docs/SUPABASE-SCHEMA.md`
- [ ] **Stripe**: Create products ($99 base, $29 per seat), enable Customer Portal

### Code Remaining (After Supabase/Stripe Setup)
| Priority | Task | File(s) |
|----------|------|---------|
| 1 | Add environment variables | `resources/NC_CAT_V3/nc-catalyst/.env` |
| 2 | Wire up NC-Cat auth React context | New file: `src/context/AuthContext.tsx` |
| 3 | Wire up NC-Cat IPC response handlers | `src/App.tsx` or entry point |
| 4 | Create NestWatcher login page | `packages/renderer/src/pages/LoginPage.tsx` |
| 5 | Create NC-Cat Account Settings page | NC-Cat settings panel |
| 6 | Implement subscription lockout modal | NestWatcher UI |

### Already Complete (Infrastructure)
- Hardware ID generation (NestWatcher + NC-Cat)
- NC-Cat background window mode
- Auth IPC channels (all 12 channels)
- Supabase auth service (NC-Cat)
- Preload API for subscription auth
- 30-minute polling from NestWatcher to NC-Cat

---

## Table of Contents

1. [Current State Summary](#1-current-state-summary)
2. [Guiding Principles](#2-guiding-principles)
3. [Contracts (IPC Boundary)](#3-contracts-ipc-boundary)
4. [Phased Implementation](#4-phased-implementation)
5. [Immediate Next Steps](#5-immediate-next-steps)
6. [Reference Architecture](#6-reference-architecture)
7. [Database Schema Migration](#7-database-schema-migration)

---

## 1. Current State Summary

### 1.1 NestWatcher (Electron Host) — ✅ Complete

| Component | Status | Location |
|-----------|--------|----------|
| NC-Cat V3 window management | ✅ Done | [hypernest.ts](packages/main/src/ipc/hypernest.ts) |
| IPC channels (`open`, `get-shared-settings`, `settings-updated`) | ✅ Done | [hypernest.ts](packages/main/src/ipc/hypernest.ts) |
| IPC channels for profiles (`profiles:list`, `save`, `setActive`, `delete`) | ✅ Done | [hypernest.ts](packages/main/src/ipc/hypernest.ts) |
| Preload API (`window.api.ncCatalyst.*`) | ✅ Done | [preload/index.ts](packages/preload/src/index.ts) |
| Postgres schema (`machines.nc_cat_*`, `tool_library`) | ✅ Done | [schema.ts](packages/main/src/db/schema.ts) |
| Postgres schema (`nc_cat_profiles` table) | ✅ Done | [schema.ts](packages/main/src/db/schema.ts) |
| Settings snapshot ingestion service | ✅ Done | [hypernest.ts](packages/main/src/ipc/hypernest.ts) |
| Transaction + version guards | ✅ Done | [hypernest.ts](packages/main/src/ipc/hypernest.ts) |
| Structured `SyncSettingsResult` response | ✅ Done | [ncCatContracts.ts](packages/shared/src/ncCatContracts.ts) |
| Profile CRUD contracts | ✅ Done | [ncCatContracts.ts](packages/shared/src/ncCatContracts.ts) |
| Protocol version constants | ✅ Done | [ncCatSnapshot.ts](packages/shared/src/ncCatSnapshot.ts) |
| Ingestion unit tests | ✅ Done | [tests/](tests/) |
| IPC integration tests | ⏳ Pending | — |

### 1.2 NC-Cat V3 (Embedded React App) — ✅ Complete

| Component | Status | Location |
|-----------|--------|----------|
| V3 React simulator embedded | ✅ Done | `resources/NC_CAT_V3/nc-catalyst/dist` |
| Electron bridge (`isInNestWatcher`, `callHost`) | ✅ Done | `resources/NC_CAT_V3/nc-catalyst/src/lib/electronBridge.ts` |
| Profile storage bridge (`fetchProfiles`, `saveProfile`, etc.) | ✅ Done | `resources/NC_CAT_V3/nc-catalyst/src/lib/electronBridge.ts` |
| Snapshot adapter (`convertToSnapshot`) | ✅ Done | `resources/NC_CAT_V3/nc-catalyst/src/lib/snapshotAdapter.ts` |
| Settings page NestWatcher integration UI | ✅ Done | `resources/NC_CAT_V3/nc-catalyst/src/components/SettingsPage.tsx` |
| Unified Machine Profiles panel (combined profiles + assignments) | ✅ Done | `resources/NC_CAT_V3/nc-catalyst/src/components/SettingsPage.tsx` |
| Fetch shared settings on load | ✅ Done | `resources/NC_CAT_V3/nc-catalyst/src/context/SettingsContext.tsx` |
| Display host paths & machines (read-only) | ✅ Done | NestWatcherSettings component |
| Multi-machine model (localStorage fallback) | ✅ Done | `MachinesStore` in localStorage |
| Multi-machine model (PostgreSQL storage) | ✅ Done | `nc_cat_profiles` table via IPC |
| Machine CRUD (create/rename/delete/duplicate) | ✅ Done | `SettingsContext.tsx` + `SettingsPage.tsx` |
| Auto-detect storage mode (DB vs localStorage) | ✅ Done | `SettingsContext.tsx` |

---

## 2. Guiding Principles

1. **NC-Cat is the authoring UI** — It owns machine/tool configuration UX.
2. **NestWatcher is the only DB writer** — NC-Cat never talks directly to factory Postgres.
3. **IPC is JSON contracts only** — Treat runtime as a versioned protocol.
4. **NC-Cat window stays sandboxed** — No Node integration; use preload APIs only.

---

## 3. Contracts (IPC Boundary)

### 3.1 Existing Contracts

Defined in `packages/shared/src/`:

| Contract | File | Direction |
|----------|------|-----------|
| `SharedSettingsSnapshot` | [ncCatContracts.ts](packages/shared/src/ncCatContracts.ts) | NestWatcher → NC-Cat |
| `NcCatSettingsSnapshot` | [ncCatSnapshot.ts](packages/shared/src/ncCatSnapshot.ts) | NC-Cat → NestWatcher |
| `SyncSettingsResult` | [ncCatSnapshot.ts](packages/shared/src/ncCatSnapshot.ts) | NestWatcher → NC-Cat |
| `PROTOCOL_VERSION` | [ncCatSnapshot.ts](packages/shared/src/ncCatSnapshot.ts) | Both |

### 3.2 Key Types

```typescript
// NC-Cat → NestWatcher
interface NcCatSettingsSnapshot {
  version: string;
  lastModified: string;      // ISO date, monotonic per machine
  machines: MachineConfig[];
  toolLibrary: ToolLibraryTool[];
  schemaVersion?: number;
}

// NestWatcher → NC-Cat (sync result)
interface SyncSettingsResult {
  ok: boolean;
  appliedMachines: number;
  appliedTools: number;
  rejectedMachines?: string[];
  error?: string;
}

// NestWatcher → NC-Cat (shared settings)
interface SharedSettingsSnapshot {
  processedJobsRoot: string;
  jobsRoot: string;
  quarantineRoot?: string;
  machines: SharedMachineConfig[];
  nestWatcherInstalled: boolean;
}
```

---

## 4. Phased Implementation

### Phase 0 — Contracts & Protocol ✅ COMPLETE

- [x] `SharedSettingsSnapshot` contract and IPC
- [x] `PROTOCOL_VERSION` + `schemaVersion` constants
- [x] `NcCatSettingsSnapshot` + `SyncSettingsResult` contracts
- [x] Version/concurrency rules (reject older snapshots)

### Phase 1 — NC-Cat V3 Basic Electron Integration ✅ COMPLETE

- [x] Electron bridge (`electronBridge.ts`)
- [x] WE detection in app (`isInNestWatcher()`)
- [x] Fetch shared settings on load
- [x] UI for host connection + sync button
- [x] Snapshot adapter (`snapshotAdapter.ts`)
- [x] Wire sync button to `callHost('syncSettings', snapshot)`

### Phase 2 — Settings Snapshot → Postgres ✅ COMPLETE

- [x] `applyNcCatSettingsSnapshot()` service
- [x] Transaction wrapper with rollback on failure
- [x] Version/concurrency guards (compare `lastModified`)
- [x] Structured `SyncSettingsResult` response
- [x] Unit tests for ingestion (new machine, update, tool_library upsert, reject stale)

### Phase 3 — Shared Settings Enforcement ✅ COMPLETE

NC-Cat V3 tasks:
- [x] Added dedicated NestWatcher Settings panel in Settings page navigation
- [x] Display connection status with visual indicator (green dot in nav)
- [x] Show host-controlled paths (processedJobsRoot, quarantineRoot) as read-only
- [x] Surface machines list from NestWatcher with sync status indicators
- [x] Protocol mismatch warnings displayed prominently
- [x] Sync button with real-time status feedback
- [x] **Machine selector dropdown** — Select which NestWatcher machine to sync settings to
- [x] Selected machine persisted to localStorage
- [x] Snapshot adapter updated to use selected machine's ID/name

NestWatcher tasks:
- [x] IPC already serves `SharedSettingsSnapshot`
- [x] Preload script added to NC-Cat BrowserWindow for IPC bridge

### Phase 4 — Job Open + MES Integration ❌ NOT STARTED

Goal: "Open in Simulator" from Jobs table + validation alignment

NestWatcher tasks:
- [ ] Add IPC `nc-catalyst:open-job` with `OpenJobInSimulatorRequest`
- [ ] Add Jobs UI action (right-click → "Open in Simulator")
- [ ] Add file reading IPC (NC-Cat has no fs access):
  - Option A: `nc-catalyst:read-job-file(path)` returns file contents
  - Option B: Include file contents in open-job request

NC-Cat V3 tasks:
- [ ] Add listener in `electronBridge.ts` for open-job events
- [ ] Extend `NCCatalystContext.tsx` to accept external job and load it
- [ ] Add `FileLoader` helper that calls host IPC to read file contents

MES tasks:
- [ ] Ensure NC-Cat exporter emits MES JSON per `docs/MES-JSON-SPECIFICATION.md`
- [ ] Long-term: Replace disk `validation.json` with headless NC-Cat `validateJobs()` in watchers

### Phase 5 — Supabase Auth & Licensing 🚧 IN PROGRESS

Goal: Per-machine licensing; NC-Cat handles all Supabase auth (works on Vercel + Electron)

> **Schema**: See `docs/SUPABASE-SCHEMA.md` for full database design

**Architecture:**
```
┌─────────────────────────────────────────────────────────────────────┐
│                         STARTUP FLOW                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  NestWatcher boots                                                   │
│       │                                                              │
│       ├──► Start NC-Cat as hidden BrowserWindow (background mode)   │
│       │                                                              │
│       ├──► Show Login Page                                          │
│       │      1. Subscription Login (NC-Cat ↔ Supabase)              │
│       │      2. Local Account Login (NestWatcher users)             │
│       │                                                              │
│       └──► On successful auth: show main app                        │
│                                                                      │
│  RUNTIME:                                                            │
│  • NC-Cat pings Supabase every 1 hour (heartbeat)                   │
│  • NestWatcher checks NC-Cat every 30 mins for auth state           │
│  • If no ping in 7 days → lock out                                  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

**Pricing Model:**
- Base subscription: $99/month (includes 1 machine)
- Additional machine seats: $29/month each
- No trial period
- 7-day grace period on payment failure

**Admin Accounts (bypass all checks):**
- kyle@woodtron.com.au
- michael@woodtron.com.au

**Machine Identification:**
- Hardware ID = SHA-256 hash of (CPU ID + Motherboard serial)
- Prevents multi-PC login under same license
- Hardware changes require support to deactivate old machine

**Seat Management:**
- Users can deactivate machines in NC-Cat Account Settings
- 1-hour cooldown before seat can be reused (prevents abuse)
- No limit on number of machines per account

---

#### ⚠️ USER ACTION REQUIRED: Supabase & Stripe Setup

Before continuing with Phase 5, the user (Michael) needs to complete these external setup steps:

**Supabase Setup:**
- [ ] Create Supabase project at https://supabase.com
- [ ] Run schema from `docs/SUPABASE-SCHEMA.md` (copy SQL into Supabase SQL Editor)
- [ ] Note down: `SUPABASE_URL` and `SUPABASE_ANON_KEY` from project settings
- [ ] Deploy Edge Functions (optional - can be done later):
  - `create-checkout-session` - Creates Stripe checkout URL
  - `create-portal-session` - Creates Stripe billing portal URL
  - `stripe-webhook` - Handles Stripe webhook events
- [ ] RLS policies are included in the schema - auto-configured

**Stripe Setup:**
- [ ] Create Stripe account at https://stripe.com
- [ ] Create products in Stripe Dashboard:
  - Product 1: "NC-Catalyst Base" - $99/mo, metadata: `{ "type": "base", "seats": "1" }`
  - Product 2: "Additional Machine Seat" - $29/mo, metadata: `{ "type": "seat" }`
- [ ] Configure webhook endpoint pointing to Supabase Edge Function
- [ ] Enable Customer Portal in Stripe settings for self-service billing
- [ ] Note down: `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`

**Environment Variables to Add:**
After setup, add to NC-Cat (`.env` or Vite config):
```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

---

#### Implementation Status

**Infrastructure (CODE COMPLETE ✅):**
- [x] Supabase database schema designed (`docs/SUPABASE-SCHEMA.md`)
- [x] Hardware ID generation - NestWatcher (`packages/main/src/services/hardwareId.ts`)
- [x] Hardware ID generation - NC-Cat (`resources/NC_CAT_V3/nc-catalyst/src/services/hardwareId.ts`)
- [x] NC-Cat background window mode (`packages/main/src/ipc/hypernest.ts`)
- [x] Auth state IPC channels (`nc-catalyst:auth:*`)
- [x] Preload API for subscription auth (`packages/preload/src/index.ts`)
- [x] Electron bridge auth functions (`resources/NC_CAT_V3/nc-catalyst/src/lib/electronBridge.ts`)
- [x] Shared TypeScript types (`packages/shared/src/subscriptionAuth.ts`)
- [x] NC-Cat Supabase auth service (`resources/NC_CAT_V3/nc-catalyst/src/services/subscriptionAuth.ts`)
- [x] 30-minute polling interval from NestWatcher to NC-Cat
- [x] NC-Cat auto-starts on NestWatcher boot (hidden BrowserWindow)

**Remaining Tasks (CODE NOT STARTED):**
- [ ] **Add NC-Cat environment variables** - Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
- [ ] **Wire up NC-Cat auth context** - Create React context that uses `subscriptionAuth.ts` service
- [ ] **NC-Cat IPC response handlers** - Wire up `onAuthStateRequest`, `onLoginRequest`, `onLogoutRequest` in NC-Cat app
- [ ] **NestWatcher login page** - Create combined subscription + local login UI
- [ ] **NC-Cat Account Settings page** - Show subscription status, machines list, billing portal link
- [ ] **Lockout modal** - Block NestWatcher when subscription invalid

---

#### Key Files Created

| File | Purpose |
|------|---------|
| `docs/SUPABASE-SCHEMA.md` | Full Supabase schema with tables, functions, RLS policies |
| `packages/shared/src/subscriptionAuth.ts` | Shared TypeScript types for auth |
| `packages/main/src/services/hardwareId.ts` | Windows hardware ID generation (CPU + Motherboard) |
| `packages/main/src/ipc/hypernest.ts` | NC-Cat background window + auth IPC handlers |
| `resources/NC_CAT_V3/nc-catalyst/src/services/subscriptionAuth.ts` | Supabase auth service for NC-Cat |
| `resources/NC_CAT_V3/nc-catalyst/src/services/hardwareId.ts` | Hardware ID with NestWatcher IPC fallback |
| `resources/NC_CAT_V3/nc-catalyst/src/lib/electronBridge.ts` | Auth IPC bridge functions |

---

#### IPC Channels (All Implemented)

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `nc-catalyst:auth:getHardwareId` | NC-Cat → NestWatcher | Get real hardware ID |
| `nc-catalyst:auth:getState` | NestWatcher → NC-Cat | Get current auth state |
| `nc-catalyst:auth:login` | NestWatcher → NC-Cat | Login request |
| `nc-catalyst:auth:logout` | NestWatcher → NC-Cat | Logout request |
| `nc-catalyst:auth:isValid` | NestWatcher → NC-Cat | Check subscription validity |
| `nc-catalyst:auth:stateChanged` | NC-Cat → NestWatcher | Broadcast auth state changes |
| `nc-catalyst:auth:requestState` | NestWatcher → NC-Cat | Request current state |
| `nc-catalyst:auth:stateResponse` | NC-Cat → NestWatcher | Response to state request |
| `nc-catalyst:auth:stateUpdate` | NC-Cat → NestWatcher | Proactive state push |
| `nc-catalyst:auth:loginRequest` | NestWatcher → NC-Cat | Forward login to NC-Cat |
| `nc-catalyst:auth:loginResponse` | NC-Cat → NestWatcher | Login result |
| `nc-catalyst:auth:logoutRequest` | NestWatcher → NC-Cat | Forward logout to NC-Cat |
| `nc-catalyst:auth:logoutResponse` | NC-Cat → NestWatcher | Logout complete |

**IPC Contracts (new):**
```typescript
// NC-Cat → NestWatcher (auth state)
interface SubscriptionAuthState {
  authenticated: boolean;
  userId?: string;
  email?: string;
  isAdmin: boolean;
  machineId?: string;
  hardwareId: string;
  subscriptionStatus: 'active' | 'grace_period' | 'locked' | 'none';
  graceEndsAt?: string;
  lastSuccessfulPing?: string;
  error?: string;
}

// NestWatcher → NC-Cat (auth requests)
interface AuthLoginRequest {
  email: string;
  password: string;
}

interface AuthLoginResponse {
  success: boolean;
  state?: SubscriptionAuthState;
  error?: string;
  needsActivation?: boolean;  // New machine needs seat
  needsSubscription?: boolean; // No active subscription
}
```

**Local Storage Schema:**
```typescript
// Stored by NC-Cat (electron-store in Electron, localStorage on Vercel)
interface LocalAuthState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
  email: string;
  isAdmin: boolean;
  machineId: string;
  hardwareId: string;
  lastSuccessfulPing: string;
  subscriptionStatus: 'active' | 'grace_period' | 'locked';
  graceEndsAt?: string;
}
```

### Phase 6 — Multi-Machine Support ✅ COMPLETE

Goal: NC-Cat supports multiple machine configurations (works standalone on web AND in NestWatcher)

NC-Cat tasks:
- [x] Added `MachineProfile` and `MachinesStore` types in `settings.ts`
- [x] Added helper functions: `generateMachineId`, `createMachineProfile`, `createDefaultMachinesStore`
- [x] Refactored `SettingsContext` for multi-machine state management
- [x] Added machine CRUD operations: `switchMachine`, `createMachine`, `renameMachine`, `deleteMachine`, `duplicateMachine`
- [x] Added automatic migration from legacy single-machine localStorage format
- [x] Added "Machine Profiles" settings panel with full CRUD UI
- [x] Active machine selector dropdown in Machine Profiles panel
- [x] Each machine profile stores its own complete settings (params, tools, drills, etc.)
- [x] Separated "local machine profiles" (NC-Cat's machines) from "NestWatcher machines" (sync targets)

**Database Storage (when running with NestWatcher):**
- [x] Added `nc_cat_profiles` table to PostgreSQL schema (`packages/main/src/db/schema.ts`)
- [x] Created SQL migration script (`migrations/20251215_nc_cat_profiles.sql`)
- [x] Added IPC handlers for profile CRUD (`nc-catalyst:profiles:list`, `save`, `setActive`, `delete`)
- [x] Updated preload to expose profile IPC methods
- [x] Updated NC-Cat bridge with profile storage functions (`fetchProfiles`, `saveProfile`, etc.)
- [x] SettingsContext auto-detects DB storage and uses IPC when in NestWatcher, localStorage when standalone

Storage model:
- **Standalone (Vercel/web)**: `ncCatalystMachines` in localStorage
- **NestWatcher (Electron)**: `nc_cat_profiles` table in PostgreSQL
- Migration: On first connect to NestWatcher DB, localStorage profiles are migrated to PostgreSQL

### Phase 7 — Unified Settings UI ✅ COMPLETE

Goal: Combine NestWatcher and Machine Profiles into a single unified settings panel

NC-Cat UI changes:
- [x] Combined "NestWatcher" and "Machine Profiles" nav items into single "Machine Profiles" panel
- [x] Two-column layout: NC-Cat Profiles (left) + Machine Assignments (right)
- [x] Connection status indicator shows NestWatcher/Standalone mode
- [x] Green dot indicator in nav when connected to NestWatcher
- [x] Hybrid autosave: profile-to-machine assignments autosave immediately; profile settings require Save button
- [x] Removed redundant NestWatcher settings panel

UI layout:
```
┌─────────────────────────────────────────────────────────────────────┐
│  Machine Profiles                                                    │
├────────────────────────────────┬────────────────────────────────────┤
│  NC-Cat Profiles               │  Machine Assignments                │
│  ┌──────────────────────────┐  │  ┌──────────────────────────────┐  │
│  │ ○ Woodtron Pro 1 [Active]│  │  │ Machine        │ Profile     │  │
│  │ ○ Woodtron Pro 2         │  │  │ ─────────────────────────────│  │
│  │ ○ Test Machine           │  │  │ Nesting Line 1 │ [dropdown ▼]│  │
│  │                          │  │  │ Nesting Line 2 │ [dropdown ▼]│  │
│  │  [+ New]                 │  │  │ Edge Bander    │ [dropdown ▼]│  │
│  └──────────────────────────┘  │  └──────────────────────────────┘  │
└────────────────────────────────┴────────────────────────────────────┘
```

---

## 5. Immediate Next Steps

Priority order:

1. **Phase 5: Supabase Auth & Licensing** 🚧 IN PROGRESS
   - Set up Supabase project and run schema
   - Set up Stripe products and webhook
   - Implement NC-Cat auth service (works on Vercel + Electron)
   - Implement hardware ID generation
   - Add NC-Cat background mode to NestWatcher
   - Create combined login page
   - Implement hourly heartbeat and offline grace logic
2. **Phase 4: Job open integration** — Enable "Open in Simulator" from Jobs table
   - Add IPC `nc-catalyst:open-job` handler in NestWatcher
   - Add file reading IPC (`nc-catalyst:read-file`) since NC-Cat has no fs access
   - Add right-click context menu action on Jobs table
   - Implement listener in NC-Cat's `electronBridge.ts` for open-job events
   - Extend NC-Cat context to accept and load external job files
3. **Add IPC integration tests** — Verify end-to-end sync flow

---

## 6. Reference Architecture

### Window & IPC Flow

```
┌─────────────────────────────────────────────────────────────┐
│                     NestWatcher (Electron)                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │ Main Process │    │   Preload    │    │   Renderer   │  │
│  │              │◄───│  (bridge)    │◄───│   (React)    │  │
│  │ hypernest.ts │    │  index.ts    │    │  JobsPage    │  │
│  └──────┬───────┘    └──────────────┘    └──────────────┘  │
│         │                                                   │
│         │ IPC channels:                                     │
│         │  • nc-catalyst:open                               │
│         │  • nc-catalyst:get-shared-settings                │
│         │  • nc-catalyst:settings-updated                   │
│         ▼                                                   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              NC-Cat V3 BrowserWindow                  │  │
│  │  ┌─────────────────────────────────────────────────┐ │  │
│  │  │              NC-Cat React App                    │ │  │
│  │  │  ┌───────────────┐  ┌───────────────────────┐   │ │  │
│  │  │  │electronBridge │  │  SettingsContext      │   │ │  │
│  │  │  │               │◄─│  (calls bridge)       │   │ │  │
│  │  │  └───────────────┘  └───────────────────────┘   │ │  │
│  │  └─────────────────────────────────────────────────┘ │  │
│  │  Session: persist:nc-catalyst (sandboxed)            │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow: Settings Sync

```
NC-Cat V3                    NestWatcher                   Postgres
─────────                    ───────────                   ────────
   │                              │                            │
   │ User clicks "Sync"          │                            │
   │──────────────────────────►  │                            │
   │ convertToSnapshot()         │                            │
   │                              │                            │
   │ callHost('syncSettings',    │                            │
   │          snapshot)          │                            │
   │─────────────────────────────►                            │
   │                              │ applyNcCatSettingsSnapshot()
   │                              │─────────────────────────────►
   │                              │                            │
   │                              │ BEGIN transaction          │
   │                              │ Upsert machines            │
   │                              │ Upsert tool_library        │
   │                              │ COMMIT                     │
   │                              │◄─────────────────────────────
   │                              │                            │
   │ SyncSettingsResult          │                            │
   │◄─────────────────────────────                            │
   │                              │                            │
   │ Show success/error toast    │                            │
   │                              │                            │
```

### Key Files

| Purpose | NestWatcher | NC-Cat V3 |
|---------|-------------|-----------|
| Window management | [hypernest.ts](packages/main/src/ipc/hypernest.ts) | — |
| Preload bridge | [preload/index.ts](packages/preload/src/index.ts) | — |
| Electron detection | — | `src/lib/electronBridge.ts` |
| Profile storage bridge | — | `src/lib/electronBridge.ts` |
| Snapshot adapter | — | `src/lib/snapshotAdapter.ts` |
| Settings ingestion | [hypernest.ts](packages/main/src/ipc/hypernest.ts) | — |
| Shared contracts | [ncCatContracts.ts](packages/shared/src/ncCatContracts.ts) | (copy types) |
| Settings UI | — | `src/components/SettingsPage.tsx` |
| Settings context | — | `src/context/SettingsContext.tsx` |

---

## 7. Database Schema Migration

### Required Migration

Run this SQL to add the `nc_cat_profiles` table for storing NC-Cat machine profiles:

**Migration file:** `migrations/20251215_nc_cat_profiles.sql`

```sql
-- NC-Cat machine profiles table
-- Stores NC-Cat machine configurations in PostgreSQL when running with NestWatcher.

BEGIN;

-- Create nc_cat_profiles table for storing NC-Cat machine profiles
CREATE TABLE IF NOT EXISTS public.nc_cat_profiles (
  id            text PRIMARY KEY,        -- UUID from NC-Cat (matches MachineProfile.id)
  name          text NOT NULL,           -- User-friendly machine name
  settings      jsonb NOT NULL,          -- Full NCCatalystSettings object
  is_active     boolean DEFAULT false NOT NULL, -- Currently active profile
  created_at    timestamptz DEFAULT now() NOT NULL,
  updated_at    timestamptz DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.nc_cat_profiles IS
  'NC-Cat machine profiles storing complete settings for each configured machine';

-- Index for quick lookup of active profile
CREATE INDEX IF NOT EXISTS nc_cat_profiles_is_active_idx
  ON public.nc_cat_profiles USING btree (is_active)
  WHERE is_active = true;

-- Trigger to keep updated_at in sync (assumes set_updated_at() exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_nc_cat_profiles_updated'
      AND tgrelid = 'public.nc_cat_profiles'::regclass
  ) THEN
    CREATE TRIGGER trg_nc_cat_profiles_updated
    BEFORE UPDATE ON public.nc_cat_profiles
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END;
$$;

COMMIT;
```

### How Storage Works

NC-Cat machine profiles are stored differently depending on how NC-Cat is running:

```
┌─────────────────────────────────────────────────────────────────────┐
│                      NC-Cat Storage Model                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────┐     ┌───────────────────────────────────┐ │
│  │ Standalone (Vercel) │     │   NestWatcher (Electron)          │ │
│  │                     │     │                                   │ │
│  │  localStorage       │     │   PostgreSQL                      │ │
│  │  key: ncCatalystMachines  │   table: nc_cat_profiles          │ │
│  │                     │     │                                   │ │
│  │  Browser storage    │     │   Factory database                │ │
│  │  Per-device only    │     │   Shared across devices           │ │
│  │  No backup          │     │   Included in DB backups          │ │
│  └─────────────────────┘     └───────────────────────────────────┘ │
│                                                                     │
│  Detection: hasProfileStorage() checks for window.api.ncCatalyst.profiles
│                                                                     │
│  Migration: On first load in NestWatcher, localStorage profiles    │
│             are automatically copied to PostgreSQL                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### IPC Channels for Profiles

| Channel | Description | Request | Response |
|---------|-------------|---------|----------|
| `nc-catalyst:profiles:list` | List all profiles | — | `NcCatProfilesListRes` |
| `nc-catalyst:profiles:save` | Create/update profile | `NcCatProfileSaveReq` | `NcCatProfile` |
| `nc-catalyst:profiles:setActive` | Set active profile | `{ id: string }` | `null` |
| `nc-catalyst:profiles:delete` | Delete profile | `{ id: string }` | `null` |

### Profile Data Structure

```typescript
interface NcCatProfile {
  id: string;           // UUID
  name: string;         // "Woodtron Pro 1"
  settings: unknown;    // Full NCCatalystSettings JSON blob
  isActive: boolean;    // Currently selected profile
  createdAt: string;    // ISO timestamp
  updatedAt: string;    // ISO timestamp
}
```

The `settings` field contains the complete NC-Cat configuration including:
- Machine parameters (g0 feeds, accelerations)
- M-code times
- Drill head layout
- Tool library (tools assigned to this machine)
- Tool strategies
- Tool changers
- Validation parameters
- Label settings
- NestPick configuration
- And all other NC-Cat settings

---

## Appendix: Deleted/Superseded Docs

The following docs are now superseded by this file:

| File | Status |
|------|--------|
| `docs/NC-CATALYST-TODO.md` | **Delete** — merged here |
| `docs/NC-CATALYST-MIGRATION-GUIDE.md` | **Delete** — merged here |
| `docs/NC-CATALYST-INTEGRATION.md` | **Keep as reference** — design background |

---

*End of document*
