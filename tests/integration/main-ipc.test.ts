/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { EventEmitter } from 'events';

import { newDb } from 'pg-mem';

import type { ResultEnvelope, JobsListReq, JobsListRes, JobStatus, LifecycleRes } from '../../packages/shared/src';






class MockWebContents extends EventEmitter {

  public sent: Array<{ channel: string; payload: unknown }> = [];



  constructor(public readonly id: number) {

    super();

  }



  isDestroyed() {

    return false;

  }



  send(channel: string, payload: unknown) {

    this.sent.push({ channel, payload });

    this.emit(channel, payload);

  }

}

type InvokeEvent = { sender: MockWebContents };
type Handler = (event: InvokeEvent, ...args: unknown[]) => ResultEnvelope<unknown> | Promise<ResultEnvelope<unknown>>;
interface GlobalWithHandlers {
  __IPC_HANDLERS__?: Map<string, Handler>;
}

type PoolClient = { connect: () => Promise<void>; end: () => Promise<void>; query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>; };

type ClientWithRelease = PoolClient & { release?: () => Promise<void> };
type QueryResult<T> = { rows: T[]; rowCount?: number };

type MaterialRow = { material: string | null };
type _JobRowRecord = {
  key: string;
  folder: string | null;
  ncfile: string | null;
  material: string | null;
  parts: string | null;
  size: string | null;
  thickness: string | null;
  dateadded: string | Date | null;
  is_reserved: boolean;
  status: JobStatus;
  machine_id: number | null;
};


const handlers: Map<string, Handler> =
  ((globalThis as GlobalWithHandlers).__IPC_HANDLERS__ as Map<string, Handler> | undefined) ??
  new Map<string, Handler>();
if (!(globalThis as GlobalWithHandlers).__IPC_HANDLERS__) {
  (globalThis as GlobalWithHandlers).__IPC_HANDLERS__ = handlers;
}




let senderCounter = 0;

function createSender() {

  return new MockWebContents(++senderCounter);

}



const db = newDb({ autoCreateForeignKeyIndices: true });

const pgAdapter = db.adapters.createPg();

const clientPrototype = pgAdapter.Client.prototype as {
  getTypeParser: (oid: number, format?: string) => (value: unknown) => unknown;
};
clientPrototype.getTypeParser = () => (val: unknown) => val;

const DB_USER = 'user';

const DB_PASS = 'pass';

const DB_NAME = 'test';





const sanitizeConfig = (config?: Record<string, unknown>) => {

  if (!config) return {};

  const clone = { ...config } as Record<string, unknown>;

  delete clone.password;

  return clone;

};



class FakePool {

  private readonly config: Record<string, unknown>;

  private readonly clients = new Set<ClientWithRelease>();



  constructor(config?: Record<string, unknown>) {

    this.config = sanitizeConfig(config);

  }



  async connect() {

    const client = new pgAdapter.Client(this.config) as unknown as ClientWithRelease;

    await client.connect();

    this.clients.add(client);

    const release = async () => {

      this.clients.delete(client);

      await client.end().catch(() => {});

    };

    client.release = release;

    return client;

  }



  async end() {

    const pending = Array.from(this.clients).map((client) => client.end().catch(() => {}));

    this.clients.clear();

    await Promise.all(pending);

  }



  on() {

    return this;

  }



  getTypeParser(_oid: number, _format?: string) {

    return (value: unknown) => value;

  }

}



vi.mock('pg', () => ({

  ...pgAdapter,

  Pool: FakePool,

  Client: pgAdapter.Client

}));



const testSettings = {

  version: 1,

  db: {

    host: 'localhost',

    port: 5432,

    database: DB_NAME,

    user: DB_USER,

    password: DB_PASS,

    sslMode: 'disable',

    statementTimeoutMs: 30000

  },

  paths: { processedJobsRoot: '', autoPacCsvDir: '', grundnerFolderPath: '' },

  test: { testDataFolderPath: '', useTestDataMode: false, sheetIdMode: 'type_data' },

  grundner: { reservedAdjustmentMode: 'delta' }

};



vi.mock('../../packages/main/src/services/config', () => ({

  loadConfig: () => testSettings,

  saveConfig: vi.fn(),

  redactSettings: vi.fn(),

  validateDbSettings: vi.fn()

}));



vi.mock('../../packages/main/src/services/db', async () => {

  const actual = await vi.importActual('../../packages/main/src/services/db');

  const { drizzle } = await import('drizzle-orm/node-postgres');



  const withClient = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {

    const client = new pgAdapter.Client(sanitizeConfig(testSettings.db)) as unknown as ClientWithRelease;

    await client.connect();

    try {

      await client.query(`SET statement_timeout TO ${testSettings.db.statementTimeoutMs}`);

      return await fn(client);

    } finally {

      await client.end();

    }

  };



  const withDb = async <T>(fn: (db: unknown, client: PoolClient) => Promise<T>): Promise<T> => {

    return withClient(async (client) => {

      const db = drizzle(client as any);

      return fn(db, client);

    });

  };



  return {

    ...actual,

    getPool: () => null,

    resetPool: async () => {},

    withClient,

    withDb,

    testConnection: async () => ({ ok: true } as const)

  };

});



vi.mock('../../packages/main/src/services/ingest', () => ({

  ingestProcessedJobsRoot: vi.fn(async () => ({ inserted: 0, updated: 0 }))

}));



vi.mock('../../packages/main/src/services/worklist', () => ({

  addJobToWorklist: vi.fn(async () => ({ ok: true, path: 'X' }))

}));



vi.mock('../../packages/main/src/services/grundner', () => ({

  getGrundnerLookupColumn: () => 'material',

  getGrundnerMode: () => 'delta'

}));



vi.mock('../../packages/main/src/repo/jobEventsRepo', () => ({

  appendJobEvent: vi.fn(async () => {}),

  getJobEvents: vi.fn(async () => [])

}));



vi.mock('../../packages/main/src/repo/jobsRepo', () => {

  const ALLOWED_TRANSITIONS = {

    PENDING: ['PENDING'],

    STAGED: ['PENDING', 'STAGED'],

    LOAD_FINISH: ['PENDING', 'STAGED', 'LOAD_FINISH'],

    LABEL_FINISH: ['STAGED', 'LOAD_FINISH', 'LABEL_FINISH'],

    CNC_FINISH: ['STAGED', 'LOAD_FINISH', 'LABEL_FINISH', 'CNC_FINISH'],

    FORWARDED_TO_NESTPICK: ['CNC_FINISH', 'FORWARDED_TO_NESTPICK'],

    NESTPICK_COMPLETE: ['FORWARDED_TO_NESTPICK', 'NESTPICK_COMPLETE']

  } as const;



  const run = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> => {

    const client = new pgAdapter.Client(sanitizeConfig(testSettings.db)) as unknown as ClientWithRelease;

    await client.connect();

    try {

      return client.query<T>(sql, params);

    } finally {

      await client.end();

    }

  };



  const toIso = (value: Date | string | null | undefined) => {

    if (!value) return null;

    const date = value instanceof Date ? value : new Date(value);

    return Number.isNaN(date.getTime()) ? null : date.toISOString();

  };



  return {

    listJobFilters: async () => {

      const materials = await run<MaterialRow>('SELECT DISTINCT material FROM jobs ORDER BY material ASC');

      const materialNames = materials.rows

        .map((row: MaterialRow) => (row.material ? String(row.material).trim() : ''))

        .filter(Boolean);

      return { materials: materialNames, statuses: ['PENDING','STAGED','LOAD_FINISH','LABEL_FINISH','CNC_FINISH','FORWARDED_TO_NESTPICK','NESTPICK_COMPLETE'] };

    },



    listJobs: async (req: JobsListReq) => {

      const limit = req?.limit ?? 50;

      const result = await run(

        'SELECT key, folder, ncfile, material, parts, size, thickness, dateadded, is_reserved, status, machine_id FROM jobs ORDER BY dateadded DESC, key DESC LIMIT $1',

        [limit]

      );

      const items = result.rows.map((row: Record<string, unknown>) => ({

        key: row.key,

        folder: row.folder ?? null,

        ncfile: row.ncfile ?? null,

        material: row.material ?? null,

        parts: row.parts ?? null,

        size: row.size ?? null,

        thickness: row.thickness ?? null,

        dateadded: toIso(row.dateadded as string | Date | null | undefined),

        reserved: !!row.is_reserved,

        status: row.status,

        machineId: row.machine_id ?? null

      }));

      return { items, nextCursor: null };

    },



    reserveJob: async (key: string) => {

      const res = await run('UPDATE jobs SET is_reserved = TRUE, updated_at = NOW() WHERE key = $1 RETURNING key', [key]);

      return (res.rowCount ?? 0) > 0;

    },



    unreserveJob: async (key: string) => {

      const res = await run('UPDATE jobs SET is_reserved = FALSE, updated_at = NOW() WHERE key = $1 RETURNING key', [key]);

      return (res.rowCount ?? 0) > 0;

    },



    updateLifecycle: async (key: string, to: string, options: { machineId?: number | null; source?: string; payload?: unknown } = {}) => {

      const currentResult = await run(

        'SELECT status, machine_id, staged_at, cut_at, nestpick_completed_at, updated_at FROM jobs WHERE key = $1',

        [key]

      );

      if (!currentResult.rowCount) {

        return { ok: false, reason: 'NOT_FOUND' } as const;

      }

      const current = currentResult.rows[0];

      const previousStatus = current.status as keyof typeof ALLOWED_TRANSITIONS;

      const allowedTransitions = ALLOWED_TRANSITIONS[to as keyof typeof ALLOWED_TRANSITIONS] as readonly string[] | undefined;
      if (!allowedTransitions?.includes(previousStatus)) {

        return { ok: false, reason: 'INVALID_TRANSITION', previousStatus } as const;

      }



      const now = new Date();

      let touched = previousStatus !== to;

      const nextStaged = current.staged_at || (['STAGED','LOAD_FINISH','LABEL_FINISH'].includes(to) ? now : null);

      const nextCut = current.cut_at || (to === 'CNC_FINISH' ? now : null);

      const nextNestpick = current.nestpick_completed_at || (to === 'NESTPICK_COMPLETE' ? now : null);



      if (!current.staged_at && nextStaged) touched = true;

      if (!current.cut_at && nextCut) touched = true;

      if (!current.nestpick_completed_at && nextNestpick) touched = true;



      let nextMachineId = current.machine_id ?? null;

      if (Object.prototype.hasOwnProperty.call(options, 'machineId') && options.machineId !== current.machine_id) {

        nextMachineId = options.machineId ?? null;

        touched = true;

      }



      if (!touched) {

        return {

          ok: false,

          reason: 'NO_CHANGE',

          previousStatus,

          stagedAt: toIso(current.staged_at as string | Date | null | undefined),

          cutAt: toIso(current.cut_at as string | Date | null | undefined),

          nestpickCompletedAt: toIso(current.nestpick_completed_at as string | Date | null | undefined),

          updatedAt: toIso(current.updated_at as string | Date | null | undefined)

        } as const;

      }



      const updated = await run(

        'UPDATE jobs SET status = $1, staged_at = $2, cut_at = $3, nestpick_completed_at = $4, machine_id = $5, updated_at = $6 WHERE key = $7 RETURNING status, machine_id, staged_at, cut_at, nestpick_completed_at, updated_at',

        [to, nextStaged, nextCut, nextNestpick, nextMachineId, now, key]

      );



      if (!updated.rowCount) {

        return { ok: false, reason: 'NOT_FOUND' } as const;

      }



      const row = updated.rows[0];

      return {

        ok: true,

        status: row.status,

        previousStatus,

        machineId: row.machine_id ?? null,

        stagedAt: toIso(row.staged_at as string | Date | null | undefined),

        cutAt: toIso(row.cut_at as string | Date | null | undefined),

        nestpickCompletedAt: toIso(row.nestpick_completed_at as string | Date | null | undefined),

        updatedAt: toIso(row.updated_at as string | Date | null | undefined)

      } as const;

    }

  };

});



describe('IPC integration', () => {

  beforeAll(async () => {

    db.public.none(`

      CREATE TYPE job_status AS ENUM (

        'PENDING','STAGED','LOAD_FINISH','LABEL_FINISH','CNC_FINISH','FORWARDED_TO_NESTPICK','NESTPICK_COMPLETE'

      );



      CREATE TABLE public.jobs (

        key TEXT PRIMARY KEY,

        folder TEXT,

        ncfile TEXT,

        material TEXT,

        parts TEXT,

        size TEXT,

        thickness TEXT,

        dateadded TIMESTAMP,

        staged_at TIMESTAMP,

        cut_at TIMESTAMP,

        nestpick_completed_at TIMESTAMP,

        updated_at TIMESTAMP DEFAULT now(),

        is_reserved BOOLEAN DEFAULT FALSE,

        machine_id INTEGER,

        status job_status DEFAULT 'PENDING',

        pallet TEXT,

        last_error TEXT

      );



      CREATE TABLE public.job_events (

        event_id SERIAL PRIMARY KEY,

        key TEXT NOT NULL,

        machine_id INTEGER,

        event_type TEXT NOT NULL,

        payload JSONB,

        created_at TIMESTAMP DEFAULT now()

      );



      CREATE TABLE public.machines (

        machine_id SERIAL PRIMARY KEY,

        name TEXT NOT NULL,

        ap_jobfolder TEXT,

        nestpick_folder TEXT,

        nestpick_enabled BOOLEAN DEFAULT TRUE,

        pc_port INTEGER DEFAULT 5000

      );



      CREATE TABLE public.grundner (

        id SERIAL PRIMARY KEY,

        type_data INTEGER,

        customer_id TEXT,

        reserved_stock INTEGER DEFAULT 0

      );

    `);



    db.public.none(`

      INSERT INTO public.machines (machine_id, name, ap_jobfolder, nestpick_folder, nestpick_enabled, pc_port)

      VALUES (1, 'Router A', 'C:/ap/router-a', 'C:/nest/router-a', TRUE, 5000);



      INSERT INTO public.jobs (key, folder, ncfile, material, parts, size, thickness, dateadded, status, machine_id)

      VALUES ('JOB-1', 'folder/job-1', 'job-1', 'Plywood', '10', '1200x600', '18', now(), 'PENDING', 1);



      INSERT INTO public.grundner (id, type_data, customer_id, reserved_stock)

      VALUES (1, 1, 'Plywood', 0);

    `);



    const { registerDbIpc } = await import('../../packages/main/src/ipc/db');

    const { registerJobsIpc } = await import('../../packages/main/src/ipc/jobs');

    const { registerLifecycleIpc } = await import('../../packages/main/src/ipc/lifecycle');



    const electron = await import('electron');

    if (!electron.ipcMain) {

      throw new Error('ipcMain mock was not applied');

    }



    registerDbIpc();

    registerJobsIpc();

    registerLifecycleIpc();

  });



  async function invoke<T>(channel: string, ...args: unknown[]): Promise<ResultEnvelope<T>> {

    const handler = handlers.get(channel);

    if (!handler) throw new Error(`No handler registered for ${channel}`);

    const sender = createSender();

    const event: InvokeEvent = { sender };

    const outcome = handler(event, ...args);

    return (await Promise.resolve(outcome)) as ResultEnvelope<T>;

  }

  function expectOk<T>(payload: ResultEnvelope<T>): T {
    expect(payload.ok).toBe(true);
    if (!payload.ok) {
      const { code, message } = payload.error;
      throw new Error(`Expected ok result but received ${code}: ${message}`);
    }
    return payload.value;
  }


  it('responds to db:ping', async () => {

    const result = await invoke<null>('db:ping');

    expect(expectOk(result)).toBeNull();

  });



  it('lists jobs and updates lifecycle', async () => {

    const list = expectOk(await invoke<JobsListRes>('jobs:list', { limit: 50, filter: {}, sortBy: 'dateadded', sortDir: 'desc' }));

    expect(list.items).toHaveLength(1);

    expect(list.items[0].key).toBe('JOB-1');

    expectOk(await invoke<null>('jobs:reserve', { key: 'JOB-1' }));

    const lifecycle = expectOk(
      await invoke<LifecycleRes>('jobs:lifecycle', { key: 'JOB-1', to: 'STAGED', machineId: 1 })
    );

    expect(lifecycle.status).toBe('STAGED');

    expectOk(await invoke<null>('jobs:unreserve', { key: 'JOB-1' }));

  });

});










/* eslint-disable @typescript-eslint/no-explicit-any */
