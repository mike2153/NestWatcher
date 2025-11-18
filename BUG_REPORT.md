# BUG REPORT - Production Critical Issues
## NestWatcher/Woodtron Electron Application
**Generated:** 2025-11-18
**Total Issues:** 17
**Critical Issues:** 5

---

## CRITICAL ISSUES (Immediate Crash/Data Corruption Risk)

### 1. Database Pool Race Condition
**File:** `packages/main/src/services/db.ts:18-47`
**Severity:** CRITICAL
**Impact:** Multiple database pools created, connection exhaustion, database crashes

**Problem:**
```typescript
export function getPool() {
  if (pool) return pool;

  poolMutex = poolMutex.then(async () => {
    if (pool) return; // Double-check after waiting
    // ... create pool
  });

  return pool; // Returns null before poolMutex resolves!
}
```

**Fix:**
```typescript
export async function getPool() {
  if (pool) return pool;

  await poolMutex;
  if (pool) return pool;

  poolMutex = (async () => {
    const cfg = loadConfig();
    // ... create pool
    pool = new Pool(baseConfig);
  })();

  await poolMutex;
  return pool!;
}
```

---

### 2. Worker Restart Failure - shuttingDown Flag Never Resets
**File:** `packages/main/src/services/watchers.ts:257-314`
**Severity:** CRITICAL
**Impact:** Manual restarts fail silently, application loses file watching functionality

**Problem:**
```typescript
export async function restartWatchers(): Promise<{ ok: boolean; error?: string }> {
  // ... shutdown code ...

  // BUG: shuttingDown flag is never reset!
  // spawnWorker() checks if (worker || shuttingDown) and returns early
  spawnWorker(); // This will fail silently!
}
```

**Fix:**
```typescript
export async function restartWatchers(): Promise<{ ok: boolean; error?: string }> {
  try {
    logger.info('watchers: manual restart requested');

    const current = worker;
    if (current) {
      worker = null;
      shuttingDown = true;

      try {
        await shutdownWatchers();
      } catch (err) {
        logger.error({ err }, 'watchers: error during shutdown');
      }
    }

    clearTimeout(restartTimer);
    restartTimer = null;

    // FIX: Reset flag before spawning
    shuttingDown = false;
    spawnWorker();

    return ok();
  } catch (err) {
    return error(err);
  }
}
```

---

### 3. File System TOCTOU Race Condition - Grundner CSV
**File:** `packages/main/src/services/orderSaw.ts:52-63`
**Severity:** CRITICAL
**Impact:** Corrupted Grundner CSV files, incorrect material allocation, production failures

**Problem:**
```typescript
// Check if file exists
if (existsSync(csvPath) || existsSync(tmpPath)) {
  await new Promise((r) => setTimeout(r, 5000));
  if (existsSync(csvPath) || existsSync(tmpPath)) {
    throw new Error('order_saw.csv is busy; please retry shortly');
  }
}
// Race condition! Another process could create file here
await fsp.writeFile(tmpPath, lines, 'utf8');
```

**Fix:**
```typescript
import { lock } from 'proper-lockfile';

export async function placeOrderSawCsv(rows: GrundnerJobData[]): Promise<...> {
  const lockPath = csvPath + '.lock';
  let release: (() => Promise<void>) | null = null;

  try {
    // Acquire exclusive lock with retry
    release = await lock(csvPath, {
      stale: 10000,
      retries: {
        retries: 5,
        minTimeout: 100,
        maxTimeout: 1000
      }
    });

    // Now safe to write
    await fsp.writeFile(tmpPath, lines, 'utf8');
    await fsp.rename(tmpPath, csvPath);

    return { confirmed: true, csv: lines };
  } catch (err) {
    if (err.code === 'ELOCKED') {
      throw new Error('order_saw.csv is busy; please retry shortly');
    }
    throw err;
  } finally {
    if (release) await release();
  }
}
```

---

### 4. Database Notification Client Resource Leak
**File:** `packages/main/src/workers/watchersWorker.ts:308-373`
**Severity:** CRITICAL
**Impact:** Connection pool exhaustion, application crash

**Problem:**
```typescript
client.on('error', (err) => {
  recordWorkerError('watchers:db-listener', err);
  try {
    client.removeAllListeners();
    client.release();
  } catch {
    /* noop */ // Silently swallowing connection release errors!
  }
  notificationClient = null;
  // If timer fails, we never reconnect
});
```

**Fix:**
```typescript
client.on('error', (err) => {
  recordWorkerError('watchers:db-listener', err);
  const clientToRelease = notificationClient;
  notificationClient = null;

  // Ensure cleanup happens asynchronously
  Promise.resolve().then(async () => {
    if (clientToRelease) {
      try {
        // Unsubscribe from all channels
        await clientToRelease.query('UNLISTEN *');
      } catch (unlisten_err) {
        logger.warn({ err: unlisten_err }, 'Failed to UNLISTEN');
      }

      try {
        // Release connection back to pool
        clientToRelease.release();
      } catch (releaseErr) {
        logger.error({ err: releaseErr }, 'Failed to release notification client');
        // Force end if release fails
        try {
          clientToRelease.end();
        } catch { /* ignore */ }
      }
    }
  });

  // Schedule reconnection with backoff
  scheduleReconnectWithBackoff();
});

function scheduleReconnectWithBackoff() {
  if (notificationRestartTimer) return;

  reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);

  notificationRestartTimer = setTimeout(() => {
    notificationRestartTimer = null;
    startDbNotificationListener().catch(err => {
      logger.error({ err }, 'Failed to restart notification listener');
      scheduleReconnectWithBackoff();
    });
  }, delay);
}
```

---

### 5. Memory Leak in IPC Subscription Reference Counting
**File:** `packages/main/src/ipc/db.ts:11-49`
**Severity:** CRITICAL
**Impact:** Memory exhaustion, application crash

**Problem:**
```typescript
function ensureSubscription(contents: WebContents): DbStatus {
  const id = contents.id;
  const existing = statusSubscribers.get(id);
  if (existing) {
    existing.count += 1; // Can overflow or become desynchronized
    return getDbStatus();
  }

  onContentsDestroyed(contents, () => {
    const entry = statusSubscribers.get(id);
    if (!entry) return;

    entry.count -= 1; // Can go negative if called multiple times
    if (entry.count <= 0) {
      entry.unsubscribe();
      statusSubscribers.delete(id);
    }
  });
}
```

**Fix:**
```typescript
// Use WeakMap to automatically clean up when WebContents is garbage collected
const contentsSubscriptions = new WeakMap<WebContents, Set<() => void>>();

function ensureSubscription(contents: WebContents): DbStatus {
  let subs = contentsSubscriptions.get(contents);

  if (!subs) {
    subs = new Set();
    contentsSubscriptions.set(contents, subs);

    // Single cleanup handler
    const cleanup = () => {
      const allSubs = contentsSubscriptions.get(contents);
      if (allSubs) {
        for (const unsub of allSubs) {
          try {
            unsub();
          } catch (err) {
            logger.warn({ err }, 'Error during subscription cleanup');
          }
        }
        contentsSubscriptions.delete(contents);
      }
    };

    onContentsDestroyed(contents, cleanup);
  }

  // Create new subscription
  const unsubscribe = subscribeDbStatus((status) => {
    if (!contents.isDestroyed()) {
      contents.send('db:status:update', status);
    }
  });

  subs.add(unsubscribe);
  return getDbStatus();
}

// Also add cleanup method for manual unsubscription
function removeSubscription(contents: WebContents): void {
  const subs = contentsSubscriptions.get(contents);
  if (subs) {
    for (const unsub of subs) {
      unsub();
    }
    contentsSubscriptions.delete(contents);
  }
}
```

---

## HIGH SEVERITY ISSUES

### 6. SQL Pattern Injection Risk
**File:** `packages/main/src/repo/jobsRepo.ts:193-197`
**Severity:** HIGH
**Impact:** ReDoS attacks, database performance degradation

**Problem:**
```typescript
if (search && search.trim()) {
  const term = `%${search.trim()}%`;
  conditions.push(
    sql`(${jobs.folder} ILIKE ${term} OR ${jobs.ncfile} ILIKE ${term})`
  );
}
```

**Fix:**
```typescript
if (search && search.trim()) {
  // Sanitize and limit search input
  const sanitized = search.trim()
    .replace(/[%_\\]/g, '\\$&')  // Escape SQL wildcards
    .slice(0, 100);  // Limit length

  // Prevent too many wildcards
  const wildcardCount = (sanitized.match(/%/g) || []).length;
  if (wildcardCount > 2) {
    throw new Error('Search pattern too complex');
  }

  const term = `%${sanitized}%`;
  conditions.push(
    sql`(${jobs.folder} ILIKE ${term} OR ${jobs.ncfile} ILIKE ${term})`
  );
}
```

---

### 7. Unhandled Promise Rejection in Production Delete
**File:** `packages/main/src/ipc/files.ts:560-606`
**Severity:** HIGH
**Impact:** Silent failures, incorrect stock tracking in Grundner

**Problem:**
```typescript
try {
  if (eligibleNcFiles.length) {
    await appendProductionListDel(machineId, eligibleNcFiles);
  }
} catch (err) {
  logger.warn({ err, machineId }, 'files:ready:delete: failed to write productionLIST_del.csv');
  // Error not propagated!
}
```

**Fix:**
```typescript
try {
  if (eligibleNcFiles.length) {
    await appendProductionListDel(machineId, eligibleNcFiles);
  }
} catch (err) {
  logger.error({ err, machineId }, 'Failed to delete production entries');

  // Propagate error to caller
  errors.push({
    file: 'production_delete',
    message: `Production delete failed: ${err instanceof Error ? err.message : String(err)}`,
    critical: true
  });

  // Mark operation as failed
  operationSuccess = false;

  // Optionally, revert any partial deletions
  if (deletedFiles.length > 0) {
    logger.info({ deletedFiles }, 'Attempting to restore deleted files after production delete failure');
    // Restoration logic here
  }
}

// At end of function
if (!operationSuccess) {
  return error(`Operation failed: ${errors.map(e => e.message).join(', ')}`);
}
```

---

### 8. Infinite Loop in Test Data Queue Processing
**File:** `packages/main/src/workers/watchersWorker.ts:1494-1499`
**Severity:** HIGH
**Impact:** Worker thread hangs, 100% CPU usage

**Problem:**
```typescript
function takeNextTestDataFile(): string | null {
  let next = testDataQueue.shift() ?? null;
  if (!next && testDataIndexBuilt) {
    while (testDataIndexPos < testDataIndex.length && !next) {
      const candidate = testDataIndex[testDataIndexPos++];
      if (!candidate) continue; // Can loop forever if all null
```

**Fix:**
```typescript
function takeNextTestDataFile(): string | null {
  let next = testDataQueue.shift() ?? null;

  if (!next && testDataIndexBuilt) {
    const startPos = testDataIndexPos;
    let loopCount = 0;
    const maxIterations = testDataIndex.length;

    while (testDataIndexPos < testDataIndex.length && !next) {
      const candidate = testDataIndex[testDataIndexPos++];
      loopCount++;

      // Prevent infinite loop
      if (loopCount > maxIterations) {
        logger.error('Infinite loop detected in test data queue processing');
        testDataIndexPos = testDataIndex.length; // Force exit
        break;
      }

      if (!candidate || !candidate.trim()) continue;

      const { files } = testDataCurrent.get(candidate) ?? { files: [] };
      if (files.length === 0) continue;

      next = candidate;
    }

    // Reset if we've processed everything
    if (testDataIndexPos >= testDataIndex.length && !next) {
      testDataIndexPos = 0;
      testDataIndexBuilt = false;
    }
  }

  return next;
}
```

---

## MEDIUM SEVERITY ISSUES

### 9. Config File Write Race Condition
**File:** `packages/main/src/services/config.ts:132-140`
**Severity:** MEDIUM
**Impact:** Configuration corruption on concurrent saves

**Problem:**
```typescript
function writeConfig(settings: Settings) {
  const file = getConfigPath();
  const dir = dirname(file);
  const normalized = normalizeSettings(settings);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(normalized, null, 2), 'utf8'); // Not atomic!
  cache = normalized;
}
```

**Fix:**
```typescript
import { writeFileAtomic } from 'write-file-atomic';

let writeMutex = Promise.resolve();

async function writeConfig(settings: Settings): Promise<void> {
  // Serialize writes
  writeMutex = writeMutex.then(async () => {
    const file = getConfigPath();
    const dir = dirname(file);
    const normalized = normalizeSettings(settings);

    if (!existsSync(dir)) {
      await fsp.mkdir(dir, { recursive: true });
    }

    // Atomic write with temp file + rename
    await writeFileAtomic(file, JSON.stringify(normalized, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
      fsync: true // Ensure data is flushed to disk
    });

    cache = normalized;
    logger.info({ file }, 'Config saved atomically');
  });

  return writeMutex;
}
```

---

### 10. Missing Transaction Isolation for Stock Check
**File:** `packages/main/src/ipc/jobs.ts:208-355`
**Severity:** MEDIUM
**Impact:** Race condition between stock check and allocation

**Problem:**
```typescript
// Check stock (no transaction)
for (const [material, requiredCount] of materialCounts.entries()) {
  const stockResult = await withDb(async (db) => {
    // Query without lock
  });
}

// Gap here - stock can change!

// Place order (separate operation)
const result = await placeOrderSawCsv(rows);

// Lock jobs (too late!)
for (const k of keys) {
  await lockJobAfterGrundnerConfirmation(k);
}
```

**Fix:**
```typescript
// Use database transaction with row-level locks
const result = await withDb(async (db) => {
  return await db.transaction(async (tx) => {
    // Lock jobs first with FOR UPDATE
    const lockedJobs = await tx
      .select()
      .from(jobs)
      .where(sql`${jobs.key} = ANY(${keys})`)
      .for('update'); // Row-level lock

    // Check if any are already locked
    const alreadyLocked = lockedJobs.filter(j => j.stage === 'LOAD_LOCKED');
    if (alreadyLocked.length > 0) {
      throw new Error(`Jobs already locked: ${alreadyLocked.map(j => j.key).join(', ')}`);
    }

    // Check stock with lock
    const stockChecks = [];
    for (const [material, requiredCount] of materialCounts.entries()) {
      const stockRow = await tx
        .select()
        .from(grundnerStock)
        .where(eq(grundnerStock.material, material))
        .for('update') // Lock stock row
        .then(rows => rows[0]);

      if (!stockRow || stockRow.available < requiredCount) {
        stockChecks.push({
          material,
          required: requiredCount,
          available: stockRow?.available ?? 0
        });
      }
    }

    if (stockChecks.length > 0) {
      // Rollback transaction
      throw new Error(`Insufficient stock: ${JSON.stringify(stockChecks)}`);
    }

    // Place order (within transaction)
    const orderResult = await placeOrderSawCsvTransactional(tx, rows);

    // Update jobs to locked state
    await tx
      .update(jobs)
      .set({ stage: 'LOAD_LOCKED', lockedAt: new Date() })
      .where(sql`${jobs.key} = ANY(${keys})`);

    // Decrement stock
    for (const [material, requiredCount] of materialCounts.entries()) {
      await tx
        .update(grundnerStock)
        .set({
          available: sql`${grundnerStock.available} - ${requiredCount}`,
          allocated: sql`${grundnerStock.allocated} + ${requiredCount}`
        })
        .where(eq(grundnerStock.material, material));
    }

    return orderResult;
  });
});
```

---

### 11. Worker Thread Shutdown Timeout
**File:** `packages/main/src/services/watchers.ts:214-254`
**Severity:** MEDIUM
**Impact:** Application hangs for 5 seconds on shutdown

**Problem:**
```typescript
const timeout = setTimeout(() => {
  current.terminate().then(finish, finish);
}, 5_000); // Always waits 5 seconds even if worker is dead

try {
  current.postMessage(message);
} catch (err) {
  // If postMessage fails, still wait full timeout
}
```

**Fix:**
```typescript
export async function shutdownWatchers(): Promise<void> {
  const current = worker;
  if (!current) return;

  // Check if worker is already dead
  if (!current.threadId || current.exitCode !== null) {
    logger.info('Worker already terminated');
    worker = null;
    return;
  }

  shuttingDown = true;

  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      worker = null;
      shuttingDown = false;
      resolve();
    };

    // Shorter initial timeout
    const quickCheck = setTimeout(() => {
      // Check if thread is responsive
      if (current.exitCode !== null) {
        finish();
      }
    }, 100);

    const forceTerminate = setTimeout(() => {
      clearTimeout(quickCheck);
      logger.warn('Worker unresponsive, force terminating');
      current.terminate().then(finish, finish);
    }, 5_000);

    current.once('exit', () => {
      clearTimeout(quickCheck);
      clearTimeout(forceTerminate);
      finish();
    });

    try {
      const message: MainToWatcherMessage = { type: 'shutdown', reason: 'app-quit' };
      current.postMessage(message);
    } catch (err) {
      logger.error({ err }, 'Failed to send shutdown message');
      clearTimeout(quickCheck);
      clearTimeout(forceTerminate);
      current.terminate().then(finish, finish);
    }
  });
}
```

---

### 12. Chokidar Watcher Resource Leak
**File:** `packages/main/src/ipc/files.ts:186-249`
**Severity:** MEDIUM
**Impact:** File descriptor exhaustion

**Problem:**
```typescript
const watcher = chokidar.watch(root, { ... });
watcher.on('add', (p) => { ... });
// If error before this line, watcher leaks
readyWatchers.set(webId, watcher);
```

**Fix:**
```typescript
registerResultHandler('files:ready:subscribe', async (event, rawMachineId) => {
  const contents = event.sender;
  const webId = contents.id;
  let watcher: FSWatcher | null = null;

  try {
    const machineId = Number(rawMachineId);
    if (!Number.isInteger(machineId) || machineId < 1) {
      return error(`Invalid machineId: ${rawMachineId}`);
    }

    // Cleanup existing watcher first
    const existing = readyWatchers.get(webId);
    if (existing) {
      try {
        await existing.close();
      } catch (e) {
        logger.warn({ err: e }, 'Error closing existing watcher');
      }
      readyWatchers.delete(webId);
    }

    const machine = await getMachineById(machineId);
    if (!machine) {
      return error(`Machine ${machineId} not found`);
    }

    const root = machine.apJobfolder;
    if (!root) {
      return error(`Machine ${machineId} has no configured job folder`);
    }

    // Create watcher with error handling
    watcher = chokidar.watch(root, {
      ignored: /(^|[\/\\])\../,
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100
      }
    });

    // Set up error handler first
    watcher.on('error', (err) => {
      logger.error({ err, machineId }, 'Watcher error');
      if (!contents.isDestroyed()) {
        contents.send('files:ready:error', {
          machineId,
          error: err.message
        });
      }
    });

    // Track files
    const files = new Set<string>();

    watcher.on('add', (p) => {
      if (isValidReadyFile(p)) {
        files.add(p);
        sendUpdate();
      }
    });

    watcher.on('unlink', (p) => {
      if (files.delete(p)) {
        sendUpdate();
      }
    });

    const sendUpdate = debounce(() => {
      if (!contents.isDestroyed()) {
        contents.send('files:ready:update', {
          machineId,
          files: Array.from(files)
        });
      }
    }, 200);

    // Store watcher AFTER setup succeeds
    readyWatchers.set(webId, watcher);

    // Set up cleanup
    onContentsDestroyed(contents, async () => {
      const w = readyWatchers.get(webId);
      if (w) {
        try {
          await w.close();
        } catch (e) {
          logger.warn({ err: e, webId }, 'Error closing watcher on destroy');
        }
        readyWatchers.delete(webId);
      }
    });

    // Send initial snapshot
    await watcher.ready;
    const { files: initialFiles } = await buildReadyList(machineId);
    if (!contents.isDestroyed()) {
      contents.send('files:ready:update', {
        machineId,
        files: initialFiles
      });
    }

    return ok({ subscribed: true });

  } catch (err) {
    // Clean up watcher if setup failed
    if (watcher) {
      try {
        await watcher.close();
      } catch (e) {
        logger.warn({ err: e }, 'Error closing watcher after setup failure');
      }
    }
    logger.error({ err }, 'Failed to set up ready file watcher');
    return error(err);
  }
});
```

---

## LOW-MEDIUM SEVERITY ISSUES

### 13. CSV/NC File Parsing Without Validation
**File:** `packages/main/src/services/ingest.ts:36-68`
**Severity:** MEDIUM
**Impact:** Memory exhaustion, database errors

**Problem:**
```typescript
const m = l.match(/ID\s*=\s*([A-Za-z0-9_.-]+)/i);
if (m && !material) material = m[1]; // No length limit!
```

**Fix:**
```typescript
function parseNc(ncPath: string): { material?: string; size?: string; thickness?: string } {
  const MAX_FIELD_LENGTH = 100;
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

  try {
    // Check file size first
    const stats = statSync(ncPath);
    if (stats.size > MAX_FILE_SIZE) {
      logger.warn({ file: ncPath, size: stats.size }, 'NC file too large');
      return {};
    }

    const txt = readFileSync(ncPath, 'utf8');
    const lines = txt.split(/\r?\n/).slice(0, 1000); // Limit lines processed

    let material: string | undefined;
    let size: string | undefined;
    let thickness: string | undefined;

    for (const ln of lines) {
      const l = ln.trim().slice(0, 500); // Limit line length

      // Material with length validation
      if (!material) {
        const m = l.match(/ID\s*=\s*([A-Za-z0-9_.-]{1,100})/i);
        if (m && m[1].length <= MAX_FIELD_LENGTH) {
          material = m[1];
        }
      }

      // Size with validation
      if (!size) {
        const sizeMatch = l.match(/SIZE\s*=\s*([0-9.]+\s*x\s*[0-9.]+)/i);
        if (sizeMatch && sizeMatch[1].length <= MAX_FIELD_LENGTH) {
          size = sizeMatch[1].replace(/\s+/g, '');
        }
      }

      // Thickness with validation
      if (!thickness) {
        const thickMatch = l.match(/THICKNESS\s*=\s*([0-9.]+)/i);
        if (thickMatch && thickMatch[1].length <= 20) {
          thickness = thickMatch[1];
        }
      }

      // Early exit if all found
      if (material && size && thickness) break;
    }

    return { material, size, thickness };
  } catch (err) {
    logger.error({ err, file: ncPath }, 'Failed to parse NC file');
    return {};
  }
}
```

---

### 14. Unbounded Cache Growth
**File:** `packages/main/src/workers/watchersWorker.ts:169-173`
**Severity:** LOW-MEDIUM
**Impact:** Memory leak over time

**Problem:**
```typescript
const autoPacHashes = new Map<string, string>();
const pendingGrundnerReleases = new Map<string, number>();
const pendingGrundnerConflicts = new Map<string, number>();
// Never cleaned up!
```

**Fix:**
```typescript
// Add TTL-based cache with size limits
class BoundedCache<K, V> {
  private cache = new Map<K, { value: V; timestamp: number }>();
  private maxSize: number;
  private ttlMs: number;

  constructor(maxSize: number, ttlMs: number) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  set(key: K, value: V): void {
    // Clean expired entries
    this.cleanExpired();

    // Enforce size limit
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      // Remove oldest entry
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, {
      value,
      timestamp: Date.now()
    });
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.value;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  private cleanExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttlMs) {
        this.cache.delete(key);
      }
    }
  }
}

// Replace maps with bounded caches
const autoPacHashes = new BoundedCache<string, string>(1000, 24 * 60 * 60 * 1000); // 1 day TTL
const pendingGrundnerReleases = new BoundedCache<string, number>(500, 60 * 60 * 1000); // 1 hour TTL
const pendingGrundnerConflicts = new BoundedCache<string, number>(500, 60 * 60 * 1000);

// Add periodic cleanup
setInterval(() => {
  const before = process.memoryUsage().heapUsed;
  autoPacHashes['cleanExpired']();
  pendingGrundnerReleases['cleanExpired']();
  pendingGrundnerConflicts['cleanExpired']();
  const after = process.memoryUsage().heapUsed;

  if (before - after > 1024 * 1024) { // Freed more than 1MB
    logger.info({ freedBytes: before - after }, 'Cache cleanup freed memory');
  }
}, 5 * 60 * 1000); // Every 5 minutes
```

---

### 15. No Backpressure in File Processing Queue
**File:** `packages/main/src/workers/watchersWorker.ts:1482-1492`
**Severity:** LOW-MEDIUM
**Impact:** Memory exhaustion under high load

**Problem:**
```typescript
function enqueueTestDataFile(file: string, reason: string) {
  testDataQueued.add(normalized);
  testDataQueue.push(normalized); // No size limit!
}
```

**Fix:**
```typescript
const MAX_QUEUE_SIZE = 1000;
const QUEUE_WARNING_SIZE = 800;

function enqueueTestDataFile(file: string, reason: string) {
  const normalized = normalize(file);

  if (testDataQueued.has(normalized)) {
    logger.debug({ file: normalized }, 'File already queued');
    return;
  }

  // Check queue size
  if (testDataQueue.length >= MAX_QUEUE_SIZE) {
    logger.error({
      queueSize: testDataQueue.length,
      file: normalized,
      reason
    }, 'Test data queue full, dropping file');

    // Send warning to main process
    parentPort?.postMessage({
      type: 'queue-warning',
      queue: 'testData',
      size: testDataQueue.length,
      dropped: normalized
    });

    return;
  }

  if (testDataQueue.length >= QUEUE_WARNING_SIZE) {
    logger.warn({
      queueSize: testDataQueue.length
    }, 'Test data queue approaching limit');
  }

  testDataQueued.add(normalized);
  testDataQueue.push(normalized);

  logger.debug({
    file: normalized,
    reason,
    queueSize: testDataQueue.length
  }, 'Enqueued test data file');
}

// Add queue metrics
function getQueueMetrics() {
  return {
    testDataQueue: testDataQueue.length,
    autoPacQueue: autoPacQueue.length,
    maxQueueSize: MAX_QUEUE_SIZE,
    droppedCount: droppedFileCount
  };
}

// Expose metrics to monitoring
setInterval(() => {
  const metrics = getQueueMetrics();
  if (metrics.testDataQueue > QUEUE_WARNING_SIZE ||
      metrics.autoPacQueue > QUEUE_WARNING_SIZE) {
    parentPort?.postMessage({
      type: 'metrics',
      metrics
    });
  }
}, 30000); // Every 30 seconds
```

---

## ADDITIONAL RECOMMENDED FIXES

### 16. Add Global Error Handlers
**File:** `packages/main/src/index.ts`
**Severity:** MEDIUM
**Impact:** Unhandled errors crash the application

**Add:**
```typescript
// Global error handlers
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  // Save error to file for debugging
  const errorFile = path.join(app.getPath('userData'), 'crash.log');
  fs.appendFileSync(errorFile, `${new Date().toISOString()}: ${err.stack}\n`);

  // Graceful shutdown
  app.quit();
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled promise rejection');
});

// Worker thread error handling
worker.on('error', (err) => {
  logger.error({ err }, 'Worker thread error');
  // Restart worker
  restartWatchers();
});

worker.on('messageerror', (err) => {
  logger.error({ err }, 'Worker message error');
});
```

---

### 17. Add Health Check System
**File:** `packages/main/src/services/health.ts` (new file)
**Severity:** LOW
**Impact:** No visibility into system health

**Add:**
```typescript
interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: {
    database: boolean;
    worker: boolean;
    filesystem: boolean;
    memory: boolean;
  };
  metrics: {
    memoryUsage: NodeJS.MemoryUsage;
    uptime: number;
    queueSizes: Record<string, number>;
  };
  timestamp: Date;
}

export class HealthMonitor {
  private lastWorkerPing = Date.now();
  private dbConnected = false;

  async checkHealth(): Promise<HealthStatus> {
    const checks = {
      database: await this.checkDatabase(),
      worker: this.checkWorker(),
      filesystem: await this.checkFilesystem(),
      memory: this.checkMemory()
    };

    const allHealthy = Object.values(checks).every(v => v);
    const anyUnhealthy = Object.values(checks).some(v => !v);

    return {
      status: anyUnhealthy ? 'unhealthy' : allHealthy ? 'healthy' : 'degraded',
      checks,
      metrics: {
        memoryUsage: process.memoryUsage(),
        uptime: process.uptime(),
        queueSizes: await this.getQueueSizes()
      },
      timestamp: new Date()
    };
  }

  private async checkDatabase(): Promise<boolean> {
    try {
      const pool = await getPool();
      const result = await pool.query('SELECT 1');
      return result.rowCount === 1;
    } catch {
      return false;
    }
  }

  private checkWorker(): boolean {
    return Date.now() - this.lastWorkerPing < 10000;
  }

  private checkMemory(): boolean {
    const usage = process.memoryUsage();
    const maxHeap = 2 * 1024 * 1024 * 1024; // 2GB
    return usage.heapUsed < maxHeap * 0.9;
  }

  private async checkFilesystem(): Promise<boolean> {
    try {
      const testFile = path.join(app.getPath('temp'), '.health-check');
      await fsp.writeFile(testFile, 'test');
      await fsp.unlink(testFile);
      return true;
    } catch {
      return false;
    }
  }

  private async getQueueSizes(): Promise<Record<string, number>> {
    // Get from worker via IPC
    return {};
  }
}

// Expose via IPC
ipcMain.handle('health:check', async () => {
  const monitor = new HealthMonitor();
  return await monitor.checkHealth();
});

// Auto-restart on unhealthy
setInterval(async () => {
  const monitor = new HealthMonitor();
  const health = await monitor.checkHealth();

  if (health.status === 'unhealthy') {
    logger.error({ health }, 'System unhealthy, attempting recovery');

    if (!health.checks.worker) {
      await restartWatchers();
    }

    if (!health.checks.database) {
      await reconnectDatabase();
    }
  }
}, 30000);
```

---

## IMPLEMENTATION PRIORITY

### Immediate (Deploy within 24 hours):
1. Fix #1 - Database pool race condition
2. Fix #2 - Worker restart failure
3. Fix #4 - Database connection leak
4. Fix #5 - Memory leak in IPC

### High Priority (Deploy within 1 week):
5. Fix #3 - File system race condition
6. Fix #6 - SQL injection protection
7. Fix #7 - Promise rejection handling
8. Fix #16 - Global error handlers

### Medium Priority (Deploy within 2 weeks):
9. Fix #9 - Config file atomicity
10. Fix #10 - Transaction isolation
11. Fix #11 - Worker shutdown timeout
12. Fix #12 - Watcher resource leak

### Low Priority (Deploy within 1 month):
13. Fix #13 - Input validation
14. Fix #14 - Cache management
15. Fix #15 - Queue backpressure
16. Fix #17 - Health monitoring

---

## TESTING RECOMMENDATIONS

1. **Load Testing**: Simulate high concurrent operations to trigger race conditions
2. **Chaos Engineering**: Randomly kill workers/connections to test recovery
3. **Memory Profiling**: Monitor for leaks over 24-48 hour runs
4. **Error Injection**: Simulate database/filesystem failures
5. **Concurrency Testing**: Run multiple instances to test file locking

## MONITORING REQUIREMENTS

After deploying fixes, monitor:
- Database connection pool usage
- Worker thread restarts
- Memory usage trends
- Error rates by type
- Queue depths
- File descriptor usage
- Response times for IPC calls