import { Pool } from 'pg';
import type { PoolClient, PoolConfig } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { loadConfig } from './config';
import { logger } from '../logger';
import { schema } from '../db/schema';


function resolvePassword(password: string | undefined): string | undefined {
  return process.env.WOODTRON_TEST_DISABLE_PASSWORD === '1' ? undefined : password;
}

let pool: Pool | null = null;
let poolMutex = Promise.resolve();

export type AppDb = NodePgDatabase<typeof schema>;

export function getPool() {
  if (pool) return pool;
  
  // Wait for any ongoing pool reset to complete before creating a new pool
  poolMutex = poolMutex.then(async () => {
    if (pool) return; // Double-check after waiting
    
    const cfg = loadConfig();
    // Password is validated as non-empty by schema before reaching this function
    const baseConfig: PoolConfig = {
      host: cfg.db.host,
      port: cfg.db.port,
      user: cfg.db.user,
      database: cfg.db.database,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: cfg.db.sslMode === 'disable' ? false : { rejectUnauthorized: cfg.db.sslMode === 'verify-full' }
    };
    const password = resolvePassword(cfg.db.password);
    if (password !== undefined) {
      baseConfig.password = password; // Non-empty password required by schema validation (can be suppressed in tests)
    }
    pool = new Pool(baseConfig);
    pool.on('error', (err: unknown) => logger.error({ err }, 'PG pool error'));
  });
  
  // For synchronous callers, return the pool if it exists, otherwise return null
  // The pool will be created asynchronously and subsequent calls will get it
  return pool;
}

export async function resetPool() {
  if (!pool) return;
  
  // Wait for any ongoing pool operations to complete before resetting
  await poolMutex;
  
  const current = pool;
  pool = null;
  try {
    await current.end();
  } catch (err) {
    logger.warn({ err }, 'Failed to close PG pool');
  }
}

export async function testConnection(settings = loadConfig().db): Promise<{ ok: true } | { ok: false; error: string }>{
  // Password is validated as non-empty by schema before reaching this function
  const baseConfig: PoolConfig = {
    host: settings.host,
    port: settings.port,
    user: settings.user,
    database: settings.database,
    max: 1,
    connectionTimeoutMillis: 8000,
    ssl: settings.sslMode === 'disable' ? false : { rejectUnauthorized: settings.sslMode === 'verify-full' }
  };
  const password = resolvePassword(settings.password);
  if (password !== undefined) {
    baseConfig.password = password; // Non-empty password required by schema validation (can be suppressed in tests)
  }
  const tmp = new Pool(baseConfig);
  try {
    const c = await tmp.connect();
    try {
      await c.query('SELECT 1');
    } finally {
      c.release();
    }
    await tmp.end();
    return { ok: true };
  } catch (e: unknown) {
    await tmp.end().catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

function shouldResetPoolForError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lowered = msg.toLowerCase();
  // Common transient connection issues worth a quick reset+retry
  return (
    lowered.includes('connection terminated unexpectedly') ||
    lowered.includes('connection terminated due to connection timeout') ||
    lowered.includes('terminating connection due to administrator command') ||
    lowered.includes('timeout') ||
    lowered.includes('ecconnreset') ||
    lowered.includes('econnrefused')
  );
}

export async function withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  // Up to two attempts to handle transient connection failures
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    // Wait for pool to be available (handles async pool creation)
    let currentPool = getPool();
    if (!currentPool) {
      // Pool is being created asynchronously, wait for it
      await poolMutex;
      currentPool = getPool();
      if (!currentPool) {
        throw new Error('Failed to create database pool');
      }
    }

    try {
      const c = await currentPool.connect();
      try {
        await c.query(`SET statement_timeout TO ${loadConfig().db.statementTimeoutMs}`);
        // Ensure queries target the expected schema regardless of cluster defaults
        await c.query('SET search_path TO public');
        return await fn(c);
      } finally {
        c.release();
      }
    } catch (err) {
      if (attempt >= 2 || !shouldResetPoolForError(err)) {
        throw err;
      }
      // Reset pool and try once more after a short delay
      logger.warn({ err, attempt }, 'PG connect failed; resetting pool and retrying');
      await resetPool();
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

export async function withDb<T>(fn: (db: AppDb, client: PoolClient) => Promise<T>): Promise<T> {
  return withClient(async (client) => {
    const db = drizzle(client, { schema });
    return fn(db, client);
  });
}
