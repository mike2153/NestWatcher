import { expect, test } from '@playwright/test';
import type { DiagnosticsSnapshot, ReadyListRes, TelemetrySummaryRes } from '../../packages/shared/src';

const diagnosticsSnapshot = {
  dbStatus: { online: true, checkedAt: new Date().toISOString(), latencyMs: 25, error: null },
  watchers: [],
  recentErrors: [],
  lastUpdatedAt: new Date().toISOString()
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ snapshot }) => {
    const now = () => new Date().toISOString();

    const state = {
      settings: {
        version: 1,
        db: {
          host: 'localhost',
          port: 5432,
          database: 'woodtron',
          user: 'woodtron_user',
          password: '',
          sslMode: 'disable',
          statementTimeoutMs: 30000
        },
        paths: { processedJobsRoot: '', autoPacCsvDir: '', grundnerFolderPath: '' },
        test: { testDataFolderPath: '', useTestDataMode: false, sheetIdMode: 'type_data' },
        grundner: { reservedAdjustmentMode: 'delta' }
      },
      machines: [
        {
          machineId: 1,
          name: 'Router A',
          apJobfolder: 'C:/ap/router-a',
          nestpickFolder: 'C:/nest/router-a',
          nestpickEnabled: true,
          pcPort: 5000,
          pcIp: null,
          cncIp: null,
          cncPort: null
        }
      ],
      jobs: [
        {
          key: 'JOB-1',
          folder: 'folder/job-1',
          ncfile: 'job-1',
          material: 'Plywood',
          parts: '10',
          size: '1200x600',
          thickness: '18',
          dateadded: now(),
          reserved: false,
          status: 'PENDING',
          machineId: 1
        }
      ],
      router: [
        {
          key: 'JOB-1',
          folder: null,
          ncfile: 'job-1',
          material: null,
          status: 'STAGED',
          machineId: 1,
          stagedAt: now(),
          cutAt: null,
          nestpickCompletedAt: null,
          updatedAt: now(),
          parts: null,
          size: null,
          thickness: null,
          pallet: null,
          lastError: null
        }
      ]
    };

    const calls = {
      settingsSave: [] as unknown[],
      testConnection: 0,
      reserve: 0,
      unreserve: 0
    };

    function notifyDiagnostics(listener: (snapshot: DiagnosticsSnapshot) => void) {
      listener(snapshot as unknown as DiagnosticsSnapshot);
      return () => {};
    }

    // @ts-expect-error: inject mock state
    window.__mockState = state;
    // @ts-expect-error: inject mock calls
    window.__mockCalls = calls;

    // Inject API stub
    window.api = {
      settings: {
        get: async () => state.settings,
        getPath: async () => '/mock/config/path',
        validatePath: async () => ({ path: '', exists: true, isDirectory: true, isFile: false, error: null }),
        save: async (next: typeof state.settings) => {
          state.settings = next;
          calls.settingsSave.push(JSON.parse(JSON.stringify(next)));
          return next;
        }
      },
      db: {
        testConnection: async () => {
          calls.testConnection += 1;
          return { ok: true } as const;
        },
        getStatus: async () => snapshot.dbStatus,
        subscribeStatus: (listener: (status: typeof snapshot.dbStatus) => void) => {
          listener(snapshot.dbStatus);
          return () => {};
        }
      },
      jobs: {
        list: async () => ({ items: state.jobs, nextCursor: null }),
        filters: async () => ({ options: { materials: ['Plywood'], statuses: ['PENDING', 'STAGED'] } }),
        events: async () => ({ events: [] }),
        reserve: async (key: string) => {
          const job = state.jobs.find((j) => j.key === key);
          if (job) {
            job.reserved = true;
            job.status = 'STAGED';
            calls.reserve += 1;
            return { ok: true } as const;
          }
          return { ok: false } as const;
        },
        unreserve: async (key: string) => {
          const job = state.jobs.find((j) => j.key === key);
          if (job) {
            job.reserved = false;
            job.status = 'PENDING';
            calls.unreserve += 1;
            return { ok: true } as const;
          }
          return { ok: false } as const;
        },
        addToWorklist: async () => ({ ok: true, path: 'C:/ap/router-a' }),
        resync: async () => ({ inserted: 0, updated: 0 })
      },
      machines: {
        list: async () => ({ items: state.machines }),
        save: async (machine: Record<string, unknown>) => ({ ...machine, machineId: Date.now() }),
        delete: async () => null
      },
      router: {
        list: async () => ({ items: state.router })
      },
      grundner: {
        list: async () => ({ items: [] }),
        update: async () => ({ ok: true, updated: 0 }),
        resync: async () => ({ updated: 0 })
      },
      files: {
        listReady: async () => ({ machineId: 1, files: [] }),
        importReady: async () => ({ imported: 0, errors: [] }),
        deleteReadyAssets: async () => ({ deleted: 0, files: [], errors: [] }),
        subscribeReady: (_machineId: number, _listener: (payload: ReadyListRes) => void) => {
          return () => {};
        }
      },
      telemetry: {
        summary: async () => ({ items: [] } as TelemetrySummaryRes),
        subscribe: (
          _req: { from?: string; to?: string; machineIds?: number[] },
          listener: (payload: TelemetrySummaryRes) => void
        ) => {
          listener({ items: [] });
          return () => {};
        }
      },
      dialog: {
        pickFolder: async () => null
      },
      history: {
        list: async () => ({ items: [] }),
        timeline: async () => null
      },
      hypernest: {
        open: async () => ({ ok: true })
      },
      alarms: {
        list: async () => [],
        history: async () => ({ items: [] }),
        subscribe: (listener: (alarms: []) => void) => {
          listener([]);
          return () => {};
        }
      },
      diagnostics: {
        get: async () => snapshot,
        copy: async () => ({ logCount: 5 }),
        listLogs: async () => ({ items: [] }),
        logTail: async () => ({ content: '', limit: 100, size: 0 }),
        subscribe: (listener: (snapshot: DiagnosticsSnapshot) => void) => notifyDiagnostics(listener)
      },
      ui: {
        theme: {
          get: async () => ({ preference: 'system' as const }),
          set: async () => ({ preference: 'system' as const })
        }
      }
    } as const;
  }, { snapshot: diagnosticsSnapshot });
});

test('settings save and test connection', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByText('Database')).toBeVisible();
  await page.getByLabel('Host').fill('db.internal');
  await page.getByRole('button', { name: 'Test' }).click();
  await page.getByRole('button', { name: 'Save' }).click();

  const host = await page.evaluate(() => (window as unknown as { __mockState: { settings: { db: { host: string } } } }).__mockState.settings.db.host);
  const calls = await page.evaluate(() => (window as unknown as { __mockCalls: { testConnection: number; settingsSave: unknown[] } }).__mockCalls);
  expect(host).toBe('db.internal');
  expect(calls.testConnection).toBeGreaterThanOrEqual(1);
  expect(calls.settingsSave.length).toBeGreaterThan(0);
});

test('jobs reserve and unreserve flow', async ({ page }) => {
  await page.goto('/jobs');
  await expect(page.getByText('Jobs')).toBeVisible();

  const rowCheckbox = page.locator('tbody tr').first().locator('input[type="checkbox"]');
  await rowCheckbox.check();
  await page.getByRole('button', { name: /^Reserve$/ }).click();

  await page.waitForTimeout(200);
  let state = await page.evaluate(() => (window as unknown as { __mockState: { jobs: Array<{ reserved: boolean }> } }).__mockState);
  expect(state.jobs[0].reserved).toBe(true);

  const rowCheckbox2 = page.locator('tbody tr').first().locator('input[type="checkbox"]');
  await rowCheckbox2.check();
  await page.getByRole('button', { name: /^Unreserve$/ }).click();
  await page.waitForTimeout(200);
  state = await page.evaluate(() => (window as unknown as { __mockState: { jobs: Array<{ reserved: boolean }> } }).__mockState);
  expect(state.jobs[0].reserved).toBe(false);

  const calls = await page.evaluate(() => (window as unknown as { __mockCalls: { reserve: number; unreserve: number } }).__mockCalls);
  expect(calls.reserve).toBe(1);
  expect(calls.unreserve).toBe(1);
});

test('router page renders data', async ({ page }) => {
  await page.goto('/router');
  await expect(page.getByText('Router Jobs')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'JOB-1' })).toBeVisible();
});

