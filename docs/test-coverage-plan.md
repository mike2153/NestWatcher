# Test Coverage Uplift Plan (Target >= 90%)

## Baseline (Vitest v2.1.9 + pnpm test)
- Overall: **22.9% stmts / 22.9% lines / 41.3% funcs / 50.2% branches**
- Main-process gaps:
  - `packages/main/src/main.ts`, `security.ts`, and most IPC handlers report **0%** coverage.
  - Repository layer (`jobsRepo.ts`, `machinesRepo.ts`, etc.) and services (`db.ts`, `watchers.ts`, `worklist.ts`) are largely unexecuted.
  - Worker bundle (`watchersWorker.ts`) shows 0% despite housing critical AutoPAC/Nestpick logic.
- Renderer coverage is currently excluded because Vitest runs against the main package only; Playwright smoke tests are not yet wired.

## Coverage Objectives
1. Lift core main-process logic (IPC handlers, services, repositories) to >= 85% each.
2. Exercise long-running worker flows (watchers, telemetry) via integration harnesses or isolated unit shims, targeting >= 80% on worker bundles.
3. Bring preload and renderer IPC clients under test so the end-to-end request/response envelope is executed in both directions.
4. Enforce a project-wide threshold of **90% statements/lines**, **80% branches**, **85% functions** once suites are stable.

## Workstreams & Deliverables

### 1. Unit Tests (Vitest, package scoped)
| Area | Files | Actions |
| --- | --- | --- |
| IPC utilities | `packages/main/src/ipc/result.ts`, `packages/main/src/ipc/errors.ts` | Verify success/error envelopes and error mapping helpers for representative `AppError` shapes. |
| Services | `packages/main/src/services/db.ts`, `dbWatchdog.ts`, `diagnostics.ts`, `worklist.ts` | Stub repositories with `vi.mock`, assert retries, timeout handling, payload composition, and watcher registration side effects. |
| Repositories | `packages/main/src/repo/jobsRepo.ts`, `machinesRepo.ts`, `historyRepo.ts` | Use `pg-mem` fixtures to hit CRUD SQL paths, including constraint failures and empty results. |
| Utility helpers | `packages/main/src/workers/watchersWorker.ts` helpers (`parseCsvContent`, `extractBases`, `waitForStableFile`) | Extract helpers to isolated modules or export them for direct unit coverage; assert edge cases (empty CSV, duplicate hashes, invalid filenames). |
| Preload bridge | `packages/preload/src/index.ts` | Mock `ipcRenderer` to confirm every API method wraps responses in `ResultEnvelope` and propagates subscription teardown. |

_Key tooling_: leverage Vitest `vi.mock`, `pg-mem`, and temporary directories for filesystem-dependent helpers. Add per-package `vitest.config.ts` overrides if worker helpers need the `node` environment.

### 2. Integration Tests (Vitest, `tests/integration` suite)
1. **Expand `main-ipc.test.ts`**
   - Cover remaining IPC channels: settings, machines, diagnostics, files, router, Grundner, alarms.
   - Assert both happy paths and error envelopes (for example DB validation failures, missing machines).
   - Seed fixture data via the Drizzle schema for each repository touched.
2. **Add worker-focused integration**
   - Spin up `watchersWorker` in-process with temporary folders to simulate AutoPAC and Nestpick file drops.
   - Assert messages sent over `parentPort`, dedupe behaviour (hash plus debounce), and machine health signals. Use `worker_threads` `MessageChannel` for deterministic tests.
3. **DB watchdog scenarios**
   - Simulate pool disconnects (mock `pg` client errors) and ensure recovery timers/logs fire, covering branches in `dbWatchdog.ts`.

Goal: integration suite drives coverage across `packages/main/src/ipc`, `services`, and `workers` modules.

### 3. End-to-End (Playwright)
- Restore `pnpm e2e` to build renderer, preload, and main bundles, launch the app (or a mocked host), and exercise UI flows.
- Target scenarios:
  1. Settings: save and test DB connection (hits settings IPC plus DB test handler).
  2. Jobs: list jobs, reserve/unreserve, add to worklist (covers jobs IPC and renderer state transitions).
  3. Diagnostics drawer: execute `diagnostics:get`, `copy`, `listLogs`, `logTail` flows.
  4. Grundner inventory: update stock and verify server response.
- Configure Playwright to emit coverage (`--coverage-dir`) for renderer bundles; merge with main-process coverage via `c8` or `nyc`.

### 4. Tooling & Reporting
- Coverage threshold enforcement: update `vitest.config.ts` with `coverage: { thresholds: { lines: 90, statements: 90, functions: 85, branches: 80 } }` once suites are stable.
- CI gating: add a coverage job to the pipeline with HTML artifact upload for review.
- Selective watch mode: document focused commands such as `pnpm test -- tests/unit/diagnostics.test.ts` to speed iteration.
- Shared fixtures: place `pg-mem` seeding helpers, temp directory utilities, and sample CSV payloads in `tests/helpers/` to avoid duplication.

## Phased Execution
1. **Phase 1 (Week 1)** - Stabilise unit coverage on IPC helpers, services, and repositories (target >= 70% overall). Introduce helper utilities and fixtures.
2. **Phase 2 (Week 2)** - Expand integration coverage across remaining IPC endpoints; add worker harness for watchers; target >= 80% coverage.
3. **Phase 3 (Week 3)** - Implement Playwright flows, merge coverage outputs, raise thresholds to 90/80/85.
4. **Phase 4 (Ongoing)** - Maintain regression guardrails for new features; update documentation and TODO checklist as suites evolve.

## Risks & Mitigations
- Flaky watcher tests due to filesystem timing -> use deterministic temp directories and make debounce intervals configurable via environment variables.
- Slow `pg-mem` setup -> share seeded database instances across tests with `beforeAll`, reset state via transactions.
- Playwright stability on CI -> run headless, stub slow backends where possible, capture videos/logs for debugging.

## Success Criteria
- Coverage report consistently >= 90% statements/lines on `pnpm test`.
- CI blocks merges when coverage drops below thresholds.
- Playwright suite validates top user journeys with coverage merged into reports.
- Documentation (this plan plus README coverage section) remains current as suites evolve.
