import { app, BrowserWindow, session, ipcMain } from 'electron';
import { existsSync, mkdirSync, writeFileSync, readFileSync, promises as fsp } from 'fs';
import path, { join, resolve, basename, extname } from 'path';
import { ok, err } from 'neverthrow';
import type {
  AppError,
  SharedSettingsSnapshot,
  NcCatProfile,
  NcCatProfilesListRes,
  NcCatProfileSaveReq,
  NcCatProfileSetActiveReq,
  NcCatProfileDeleteReq,
  NcCatAssignProfileReq,
  NcCatAssignProfileRes,
  NcCatProfileMachinesRes,
  NcCatSubmitValidationReq,
  NcCatSubmitValidationRes,
  ValidationResult,
  OpenJobInSimulatorReq,
  OpenJobInSimulatorRes,
  OpenJobDescriptor,
  SubscriptionAuthState
} from '../../../shared/src';
import { PROTOCOL_VERSION } from '../../../shared/src';
import { applyWindowNavigationGuards, applyCustomContentSecurityPolicy } from '../security';
import { registerResultHandler } from './result';
import { loadConfig } from '../services/config';
import { machines, ncCatProfiles, jobs } from '../db/schema';
import { withDb } from '../services/db';
import { eq, inArray } from 'drizzle-orm';
import { logger } from '../logger';
import { pushAppMessage } from '../services/messages';
import { upsertNcStats } from '../repo/ncStatsRepo';
import { getHardwareId } from '../services/hardwareId';

// NC-Cat window instances
let ncCatWin: BrowserWindow | null = null;
let ncCatBackgroundWin: BrowserWindow | null = null;

let ncCatLogListenerRegistered = false;

// Cached subscription auth state from NC-Cat
let cachedSubscriptionAuthState: SubscriptionAuthState | null = null;
let authStateRequestInFlight: Promise<SubscriptionAuthState | null> | null = null;
let consecutiveAuthStateRequestFailures = 0;

// Keep logs readable: only log auth state when it changes.
let lastLoggedAuthStateKey: string | null = null;

function toAuthStateKey(state: SubscriptionAuthState | null): string {
  if (!state) return 'null';
  return `${state.authenticated ? '1' : '0'}|${state.subscriptionStatus ?? 'unknown'}|${state.isAdmin ? '1' : '0'}`;
}

function logNcCatAuthStateIfChanged(source: string, state: SubscriptionAuthState | null): void {
  const key = toAuthStateKey(state);
  if (key === lastLoggedAuthStateKey) return;
  lastLoggedAuthStateKey = key;

  if (!state) {
    logger.info({ source }, 'NC-Cat auth state unavailable');
    return;
  }

  logger.info(
    {
      source,
      authenticated: state.authenticated,
      subscriptionStatus: state.subscriptionStatus,
      isAdmin: state.isAdmin
    },
    'NC-Cat auth state'
  );
}


// Auth state check interval (30 minutes)
const AUTH_STATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
let authStateCheckInterval: ReturnType<typeof setInterval> | null = null;

function waitForNcCatLoad(win: BrowserWindow, timeoutMs = 20_000): Promise<void> {
  if (!win.webContents.isLoading()) return Promise.resolve();
  return new Promise((resolveWait) => {
    const done = () => {
      clearTimeout(timeout);
      win.webContents.removeListener('did-finish-load', done);
      win.webContents.removeListener('did-fail-load', done);
      resolveWait();
    };
    const timeout = setTimeout(done, timeoutMs);
    win.webContents.once('did-finish-load', done);
    win.webContents.once('did-fail-load', done);
  });
}

function waitForCachedAuthState(timeoutMs = 8_000): Promise<SubscriptionAuthState | null> {
  if (cachedSubscriptionAuthState) return Promise.resolve(cachedSubscriptionAuthState);
  return new Promise((resolveWait) => {
    const interval = setInterval(() => {
      if (cachedSubscriptionAuthState) {
        clearTimeout(timeout);
        clearInterval(interval);
        resolveWait(cachedSubscriptionAuthState);
      }
    }, 250);
    const timeout = setTimeout(() => {
      clearInterval(interval);
      resolveWait(cachedSubscriptionAuthState);
    }, timeoutMs);
  });
}

/**
 * Returns either a dev server URL (if NC_CATALYST_DEV_URL is set) or a file path.
 * When NC_CATALYST_DEV_URL is set (e.g., "http://localhost:5173"), we load from
 * the Vite dev server for hot reload during development.
 */
function resolveNcCatalystSource(): { type: 'url'; url: string } | { type: 'file'; path: string } {
  // Hot reload: if dev URL is set, use it
  const devUrl = process.env.NC_CATALYST_DEV_URL;
  if (devUrl) {
    logger.debug({ devUrl }, 'NC-Cat source: using dev URL');

    return { type: 'url', url: devUrl };
  }

  // Otherwise, load from file (built Vite app)
  const entry = process.env.NC_CATALYST_ENTRY || 'nc-catalyst/dist/index.html';

  // Prefer a dev working copy when provided
  const devDir = process.env.NC_CATALYST_DEV_DIR;
  if (devDir && existsSync(devDir)) {
    const candidate = join(resolve(devDir), entry);
    if (existsSync(candidate)) {
      logger.debug({ devDir, entry, candidate }, 'NC-Cat source: using dev directory');

      return { type: 'file', path: candidate };
    }
  }

  // Try multiple fallbacks so dev and packaged builds both resolve correctly.
  const appPath = app.getAppPath();
  const candidates = [
    // Packaged: <Resources>/NC_CAT_V3
    join(process.resourcesPath, 'NC_CAT_V3', entry),
    // Dev: project resources alongside app path
    join(appPath, 'resources', 'NC_CAT_V3', entry),
    // Dev: repo root resources (one level above app path)
    join(resolve(appPath, '..'), 'resources', 'NC_CAT_V3', entry),
    // Dev: relative to source tree (compiled dist/ipc -> repo/resources)
    join(resolve(__dirname, '../../../../resources/NC_CAT_V3'), entry),
    // Legacy fallback
    join(resolve(__dirname, '../../../resources/NC_CAT_V3'), entry)
  ].filter((p, idx, arr) => arr.indexOf(p) === idx);

  logger.info(
    {
      entry,
      appPath,
      resourcesPath: process.resourcesPath,
      __dirname,
      candidates: candidates.map((pathTried) => ({ pathTried, exists: existsSync(pathTried) }))
    },
    'NC-Cat source: evaluated file candidates'
  );

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      logger.debug({ candidate }, 'NC-Cat source: selected file');

      return { type: 'file', path: candidate };
    }
  }

  // Last resort: use appPath resources even if missing; caller will log the failure.
  const fallback = join(appPath, 'resources', 'NC_CAT_V3', entry);
  logger.warn({ fallback }, 'NC-Cat source: no candidate found, using fallback');
  return { type: 'file', path: fallback };
}

/**
 * Create a hidden NC-Cat BrowserWindow for background auth operations.
 * This window runs NC-Cat without displaying it, allowing it to handle
 * Supabase authentication and licensing checks.
 */
export function startNcCatBackgroundWindow(): void {
  if (ncCatBackgroundWin && !ncCatBackgroundWin.isDestroyed()) {
    logger.debug('NC-Cat background window already running');
    return;
  }

  const source = resolveNcCatalystSource();

  // Use NC-Cat specific preload script
  const ncCatPreloadPath = path.join(__dirname, '../../preload/dist/nc-catalyst-preload.js');
  const fallbackPreloadPath = path.join(__dirname, '../../preload/dist/index.js');
  const preloadPath = existsSync(ncCatPreloadPath) ? ncCatPreloadPath : fallbackPreloadPath;

  logger.debug({
    ncCatPreloadPath,
    fallbackPreloadPath,
    preloadPath,
    exists: existsSync(preloadPath),
    isNcCatPreload: preloadPath === ncCatPreloadPath
  }, 'NC-Cat background window: creating');


  ncCatBackgroundWin = new BrowserWindow({
    width: 800,
    height: 600,
    show: false, // Hidden window
    webPreferences: {
      partition: 'persist:nc-catalyst',
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });

  // Apply same CSP as visible window
  const ncSession = session.fromPartition('persist:nc-catalyst');
  const ncPolicy = [
    "default-src 'self' https: data: ws:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com https://cdn.babylonjs.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' ws: wss: http://localhost:* https://localhost:* https://*.supabase.co https://*.supabase.in",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; ');
  applyCustomContentSecurityPolicy(ncSession, ncPolicy);

  ncCatBackgroundWin.on('closed', () => {
    ncCatBackgroundWin = null;
    logger.debug('NC-Cat headless window closed');
  });


  // Load NC-Cat
  if (source.type === 'url') {
    ncCatBackgroundWin.loadURL(source.url).catch((loadErr) => {
      logger.error({ err: loadErr, url: source.url }, 'Failed to load NC-Cat background window from dev server');
    });
  } else {
    ncCatBackgroundWin.loadFile(source.path).catch((loadErr) => {
      logger.error({ err: loadErr, path: source.path }, 'Failed to load NC-Cat background window');
    });
  }

  logger.info(
    { source: source.type === 'url' ? source.url : source.path },
    'NC-Cat headless window started'
  );


  // Start the auth state check interval
  startAuthStateCheckInterval();
}

/**
 * Stop the NC-Cat background window
 */
export function stopNcCatBackgroundWindow(): void {
  stopAuthStateCheckInterval();

  if (ncCatBackgroundWin && !ncCatBackgroundWin.isDestroyed()) {
    ncCatBackgroundWin.close();
    ncCatBackgroundWin = null;
  }
}

/**
 * Get the active NC-Cat window (background or visible)
 */
export function getActiveNcCatWindow(): BrowserWindow | null {
  // Prefer the visible window if it exists
  if (ncCatWin && !ncCatWin.isDestroyed()) {
    return ncCatWin;
  }
  // Fall back to background window
  if (ncCatBackgroundWin && !ncCatBackgroundWin.isDestroyed()) {
    return ncCatBackgroundWin;
  }
  return null;
}

/**
 * Request subscription auth state from NC-Cat
 */
async function requestAuthStateFromNcCat(): Promise<SubscriptionAuthState | null> {
  if (authStateRequestInFlight) return authStateRequestInFlight;
  const win = getActiveNcCatWindow();
  if (!win) {
    logger.debug('No NC-Cat window available for auth state request');
    return null;
  }

  authStateRequestInFlight = (async () => {
    await waitForNcCatLoad(win);

    return new Promise<SubscriptionAuthState | null>((resolve) => {
      const responseChannel = 'nc-catalyst:auth:stateResponse';
      const handler = (_event: Electron.IpcMainEvent, state: SubscriptionAuthState) => {
        clearTimeout(timeout);
        ipcMain.removeListener(responseChannel, handler);
        cachedSubscriptionAuthState = state;
        consecutiveAuthStateRequestFailures = 0;
        resolve(state);
      };

      const timeout = setTimeout(() => {
        ipcMain.removeListener(responseChannel, handler);
        consecutiveAuthStateRequestFailures += 1;
        if (consecutiveAuthStateRequestFailures >= 3) {
          logger.warn({ failures: consecutiveAuthStateRequestFailures }, 'Auth state request to NC-Cat timed out');
        } else {
          logger.debug({ failures: consecutiveAuthStateRequestFailures }, 'Auth state request to NC-Cat timed out');
        }
        resolve(null);
      }, 15_000);

      ipcMain.once(responseChannel, handler);

      try {
        win.webContents.send('nc-catalyst:auth:requestState');
      } catch (sendErr) {
        clearTimeout(timeout);
        ipcMain.removeListener(responseChannel, handler);
        consecutiveAuthStateRequestFailures += 1;
        logger.debug({ err: sendErr }, 'Failed to send auth state request to NC-Cat');
        resolve(null);
      }
    });
  })().finally(() => {
    authStateRequestInFlight = null;
  });

  return authStateRequestInFlight;
}

/**
 * Start the interval that checks auth state from NC-Cat
 */
function startAuthStateCheckInterval(): void {
  stopAuthStateCheckInterval();

  // Initial check after NC-Cat has had a chance to load and install its IPC listeners.
  setTimeout(async () => {
    const cached = await waitForCachedAuthState();
    const state = cached ?? (await requestAuthStateFromNcCat());

    if (state) {
      logNcCatAuthStateIfChanged('initial', state);
      if (!state.authenticated) {
        // Show NC‑Cat sign-in UI when NestWatcher starts and the user is not authenticated.
        openNcCatalystWindow();
      }
      return;
    }


    // Could not retrieve state (likely NC‑Cat not fully loaded). We'll retry on-demand when the renderer asks for state.
    logger.debug('Initial auth state not available from NC-Cat');
  }, 1500);

  // Regular checks every 30 minutes
  authStateCheckInterval = setInterval(async () => {
    const state = await requestAuthStateFromNcCat();
    if (state) {
      logger.debug({ authenticated: state.authenticated, status: state.subscriptionStatus }, 'Auth state check from NC-Cat');
    }
  }, AUTH_STATE_CHECK_INTERVAL_MS);
}

/**
 * Stop the auth state check interval
 */
function stopAuthStateCheckInterval(): void {
  if (authStateCheckInterval) {
    clearInterval(authStateCheckInterval);
    authStateCheckInterval = null;
  }
}

/**
 * Get the cached subscription auth state
 */
export function getCachedSubscriptionAuthState(): SubscriptionAuthState | null {
  return cachedSubscriptionAuthState;
}

/**
 * Check if the subscription is valid (active or in grace period)
 */
export function isSubscriptionValid(): boolean {
  if (!cachedSubscriptionAuthState) {
    return false;
  }

  const { authenticated, isAdmin, subscriptionStatus } = cachedSubscriptionAuthState;

  // Admin users always have valid subscription
  if (isAdmin) {
    return true;
  }

  // Check if authenticated and subscription is active or in grace
  return authenticated && (subscriptionStatus === 'active' || subscriptionStatus === 'grace_period');
}

export function openNcCatalystWindow() {
  logger.info('openNcCatalystWindow called');

  if (ncCatWin && !ncCatWin.isDestroyed()) {
    logger.info('NC-Cat window already open; focusing');
    try {
      ncCatWin.show();
      ncCatWin.focus();
    } catch (err) {
      logger.debug({ err }, 'Failed to focus NC-Cat window');
    }
    ncCatWin.focus();
    return;
  }

  logger.info({
    hasBackgroundWin: !!ncCatBackgroundWin,
    isDestroyed: ncCatBackgroundWin ? ncCatBackgroundWin.isDestroyed() : null
  }, 'Checking if background NC-Cat window is running');

  const source = resolveNcCatalystSource();
  logger.info(
    {
      source,
      env: {
        NC_CATALYST_DEV_URL: process.env.NC_CATALYST_DEV_URL,
        NC_CATALYST_ENTRY: process.env.NC_CATALYST_ENTRY,
        NC_CATALYST_DEV_DIR: process.env.NC_CATALYST_DEV_DIR
      }
    },
    'Opening NC-Cat window'
  );

  // Use NC-Cat specific preload script that only exposes needed IPC methods
  // NC-Cat should NOT have access to NestWatcher's window.api
  const ncCatPreloadPath = path.join(__dirname, '../../preload/dist/nc-catalyst-preload.js');
  const fallbackPreloadPath = path.join(__dirname, '../../preload/dist/index.js');

  // Use NC-Cat preload if it exists, otherwise fall back to main preload (for dev)
  const preloadPath = existsSync(ncCatPreloadPath) ? ncCatPreloadPath : fallbackPreloadPath;

  logger.info(
    {
      ncCatPreloadPath,
      fallbackPreloadPath,
      selectedPreload: preloadPath,
      exists: existsSync(preloadPath),
      isNcCatPreload: preloadPath === ncCatPreloadPath
    },
    'NC-Cat preload resolved'
  );

  logger.info('Creating NC-Cat BrowserWindow');

  ncCatWin = new BrowserWindow({
    width: 1400,
    height: 900,
    // Show immediately so the user sees something even while loading (and so failures aren't "invisible").
    show: true,
    webPreferences: {
      // Use a separate session so we can apply a relaxed CSP without affecting the main app
      partition: 'persist:nc-catalyst',
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });

  logger.info({ id: ncCatWin.id }, 'NC-Cat BrowserWindow created');

  applyWindowNavigationGuards(ncCatWin.webContents, { allowExternal: false });
  logger.info('Navigation guards applied');

  ncCatWin.on('ready-to-show', () => {
    logger.info('NC-Cat window ready-to-show event');
    try {
      ncCatWin?.show();
      ncCatWin?.focus();
    } catch (err) {
      logger.debug({ err }, 'Failed to show NC-Cat window');
    }
  });
  ncCatWin.on('closed', () => {
    logger.info('NC-Cat window closed event');
    ncCatWin = null;
  });
  ncCatWin.on('close', () => {
    logger.info('NC-Cat window close event (before closing)');
  });
  ncCatWin.on('unresponsive', () => {
    logger.warn('NC-Cat window became unresponsive');
  });
  ncCatWin.webContents.on('render-process-gone', (_event, details) => {
    logger.error({ details }, 'NC-Cat render process gone');
  });
  ncCatWin.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logger.error({ errorCode, errorDescription, validatedURL }, 'NC-Cat did-fail-load event');
  });
  ncCatWin.webContents.on('did-start-loading', () => {
    logger.info('NC-Cat did-start-loading event');
  });
  ncCatWin.webContents.on('did-stop-loading', () => {
    logger.info('NC-Cat did-stop-loading event');
  });
  ncCatWin.webContents.on('dom-ready', () => {
    logger.info('NC-Cat dom-ready event');
  });
  ncCatWin.webContents.on('did-finish-load', () => {
    logger.info('NC-Cat did-finish-load event');
    // NC Catalyst UI is designed for a browser viewport; scale slightly for the desktop window
    ncCatWin?.webContents.setZoomFactor(0.9);
    try {
      ncCatWin?.show();
      ncCatWin?.focus();
    } catch (err) {
      logger.debug({ err }, 'Failed to focus NC-Cat window after load');
    }
  });

  // Relaxed CSP for NC Catalyst: allow required CDNs and inline handlers in this session only
  logger.info('Applying CSP to NC-Cat session');
  const ncSession = session.fromPartition('persist:nc-catalyst');
  const ncPolicy = [
    "default-src 'self' https: data: ws:",
    // Inline handlers + Tailwind CDN runtime + Babylon + JSZip + Clipper + DXF parser rely on relaxed script execution
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com https://cdn.babylonjs.com https://cdn.jsdelivr.net",
    // Tailwind + Google Fonts stylesheet
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    // Google Fonts assets
    "font-src 'self' https://fonts.gstatic.com",
    // Images from local and possible https
    "img-src 'self' data: blob: https:",
    // Allow WebSocket connections for Vite HMR + Supabase auth/API
    "connect-src 'self' ws: wss: http://localhost:* https://localhost:* https://*.supabase.co https://*.supabase.in",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; ');
  applyCustomContentSecurityPolicy(ncSession, ncPolicy);
  logger.info('CSP applied');

  if (source.type === 'url') {
    // Hot reload mode: load from Vite dev server
    logger.info({ url: source.url }, 'NC-Cat loadURL start');
    ncCatWin.loadURL(source.url).catch((err) => {
      logger.error({ err, url: source.url }, 'Failed to load NC Catalyst from dev server');
    });
  } else {
    // Production mode: load from file
    logger.info({ pathTried: source.path, exists: existsSync(source.path) }, 'NC-Cat loadFile start');
    ncCatWin.loadFile(source.path)
      .then(() => {
        logger.info('NC-Cat loadFile succeeded');
      })
      .catch((err) => {
        const exists = existsSync(source.path);
        logger.error(
          {
            err,
            errMessage: err?.message,
            errStack: err?.stack,
            pathTried: source.path,
            exists,
            windowDestroyed: ncCatWin?.isDestroyed()
          },
          'Failed to load NC Catalyst from file path'
        );
      });
  }

  logger.info('openNcCatalystWindow completed');
}

export function closeNcCatalystWindow(): void {
  logger.info({
    hasWindow: !!ncCatWin,
    isDestroyed: ncCatWin?.isDestroyed(),
    stack: new Error().stack
  }, 'closeNcCatalystWindow called');
  if (ncCatWin && !ncCatWin.isDestroyed()) {
    logger.info('Closing NC-Cat window');
    ncCatWin.close();
  }
}

export function registerNcCatalystIpc() {
  if (!ncCatLogListenerRegistered) {
    ncCatLogListenerRegistered = true;

    ipcMain.on('nc-catalyst:log', (event: Electron.IpcMainEvent, rawPayload: unknown) => {
      try {
        // Only accept logs from our NC-Cat windows (prevents other renderers spoofing this channel)
        const allowedSenderIds = new Set<number>();
        if (ncCatWin && !ncCatWin.isDestroyed()) {
          allowedSenderIds.add(ncCatWin.webContents.id);
        }
        if (ncCatBackgroundWin && !ncCatBackgroundWin.isDestroyed()) {
          allowedSenderIds.add(ncCatBackgroundWin.webContents.id);
        }

        if (!allowedSenderIds.has(event.sender.id)) {
          return;
        }

        const payload = rawPayload as { level?: unknown; message?: unknown; timestamp?: unknown };
        const level = typeof payload?.level === 'string' ? payload.level.toLowerCase() : 'info';
        const message = typeof payload?.message === 'string' ? payload.message : '';
        const timestamp = typeof payload?.timestamp === 'string' ? payload.timestamp : undefined;
        const prefixed = message ? `[NC Catalyst] ${message}` : '[NC Catalyst]';

        const meta = { source: 'nc-catalyst', senderId: event.sender.id, timestamp };

        switch (level) {
          case 'fatal':
            logger.fatal(meta, prefixed);
            break;
          case 'error':
            logger.error(meta, prefixed);
            break;
          case 'warn':
            logger.warn(meta, prefixed);
            break;
          case 'debug':
            logger.debug(meta, prefixed);
            break;
          case 'trace':
            logger.trace(meta, prefixed);
            break;
          case 'info':
          default:
            logger.info(meta, prefixed);
            break;
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to forward NC-Cat log');
      }
    });
  }

  registerResultHandler('nc-catalyst:open', async () => {
    logger.info('IPC nc-catalyst:open received');
    openNcCatalystWindow();
    return ok<null, AppError>(null);
  }, { requiresAuth: false });

  registerResultHandler('nc-catalyst:close', async () => {
    // Log with stack trace to see where this is being called from
    const stack = new Error().stack;
    logger.info({ stack }, 'IPC nc-catalyst:close received');
    closeNcCatalystWindow();
    return ok<null, AppError>(null);
  }, { requiresAuth: false });

  // Provide shared WE settings (paths + machines) back to NC-Cat when requested.
  registerResultHandler(
    'nc-catalyst:get-shared-settings',
    async () => {
      const cfg = loadConfig();

      const rows = await withDb((db) =>
        db
          .select({
            machineId: machines.machineId,
            name: machines.name,
            ncCatProfileId: machines.ncCatProfileId
          })
          .from(machines)
      );

      const snapshot: SharedSettingsSnapshot = {
        processedJobsRoot: cfg.paths.processedJobsRoot ?? '',
        jobsRoot: cfg.paths.jobsRoot ?? '',
        quarantineRoot: cfg.paths.quarantineRoot ?? null,
        machines: rows.map((m) => ({
          machineId: m.machineId,
          name: m.name,
          ncCatProfileId: m.ncCatProfileId ?? null
        })),
        nestWatcherInstalled: true,
        protocolVersion: PROTOCOL_VERSION
      };

      return ok<SharedSettingsSnapshot, AppError>(snapshot);
    },
    { requiresAuth: false }
  );

  // ---------------------------------------------------------------------------------
  // NC-Cat Machine Profiles CRUD (stored in PostgreSQL)
  // ---------------------------------------------------------------------------------

  // List all profiles
  registerResultHandler(
    'nc-catalyst:profiles:list',
    async () => {
      const rows = await withDb((db) =>
        db
          .select()
          .from(ncCatProfiles)
          .orderBy(ncCatProfiles.name)
      );

      const profiles: NcCatProfile[] = rows.map((row) => ({
        id: row.id,
        name: row.name,
        settings: row.settings,
        isActive: row.isActive,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString()
      }));

      const activeProfile = profiles.find((p) => p.isActive);

      const result: NcCatProfilesListRes = {
        profiles,
        activeProfileId: activeProfile?.id ?? null
      };

      return ok<NcCatProfilesListRes, AppError>(result);
    },
    { requiresAuth: false }
  );

  // Save (create or update) a profile
  registerResultHandler(
    'nc-catalyst:profiles:save',
    async (_event, rawReq: unknown) => {
      const req = rawReq as NcCatProfileSaveReq;
      const now = new Date();

      await withDb(async (db) => {
        // If this profile should be active, deactivate all others first
        if (req.isActive) {
          await db
            .update(ncCatProfiles)
            .set({ isActive: false, updatedAt: now })
            .where(eq(ncCatProfiles.isActive, true));
        }

        // Upsert the profile
        await db
          .insert(ncCatProfiles)
          .values({
            id: req.id,
            name: req.name,
            settings: req.settings,
            isActive: req.isActive ?? false,
            createdAt: now,
            updatedAt: now
          })
          .onConflictDoUpdate({
            target: ncCatProfiles.id,
            set: {
              name: req.name,
              settings: req.settings,
              isActive: req.isActive ?? false,
              updatedAt: now
            }
          });
      });

      // Return the saved profile
      const [saved] = await withDb((db) =>
        db.select().from(ncCatProfiles).where(eq(ncCatProfiles.id, req.id)).limit(1)
      );

      const profile: NcCatProfile = {
        id: saved.id,
        name: saved.name,
        settings: saved.settings,
        isActive: saved.isActive,
        createdAt: saved.createdAt.toISOString(),
        updatedAt: saved.updatedAt.toISOString()
      };

      return ok<NcCatProfile, AppError>(profile);
    },
    { requiresAuth: false }
  );

  // Set a profile as active
  registerResultHandler(
    'nc-catalyst:profiles:setActive',
    async (_event, rawReq: unknown) => {
      const req = rawReq as NcCatProfileSetActiveReq;
      const now = new Date();

      await withDb(async (db) => {
        // Deactivate all profiles
        await db
          .update(ncCatProfiles)
          .set({ isActive: false, updatedAt: now })
          .where(eq(ncCatProfiles.isActive, true));

        // Activate the requested profile
        await db
          .update(ncCatProfiles)
          .set({ isActive: true, updatedAt: now })
          .where(eq(ncCatProfiles.id, req.id));
      });

      return ok<null, AppError>(null);
    },
    { requiresAuth: false }
  );

  // Delete a profile
  registerResultHandler(
    'nc-catalyst:profiles:delete',
    async (_event, rawReq: unknown) => {
      const req = rawReq as NcCatProfileDeleteReq;
      // Check how many profiles exist
      const profiles = await withDb((db) => db.select().from(ncCatProfiles));

      if (profiles.length <= 1) {
        return err<null, AppError>({
          code: 'VALIDATION_ERROR',
          message: 'Cannot delete the last profile'
        });
      }

      const deletingProfile = profiles.find((p) => p.id === req.id);
      const wasActive = deletingProfile?.isActive ?? false;

      await withDb(async (db) => {
        await db.delete(ncCatProfiles).where(eq(ncCatProfiles.id, req.id));

        // If we deleted the active profile, activate another one
        if (wasActive) {
          const remaining = profiles.filter((p) => p.id !== req.id);
          if (remaining.length > 0) {
            await db
              .update(ncCatProfiles)
              .set({ isActive: true, updatedAt: new Date() })
              .where(eq(ncCatProfiles.id, remaining[0].id));
          }
        }
      });

      return ok<null, AppError>(null);
    },
    { requiresAuth: false }
  );

  // ---------------------------------------------------------------------------------
  // Profile ↔ Machine Assignment
  // ---------------------------------------------------------------------------------

  // Assign a profile to a machine (or unassign with profileId = null)
  registerResultHandler(
    'nc-catalyst:profiles:assign',
    async (_event, rawReq: unknown) => {
      const req = rawReq as NcCatAssignProfileReq;
      const now = new Date();

      // If assigning a profile, verify it exists
      if (req.profileId) {
        const [profile] = await withDb((db) =>
          db.select().from(ncCatProfiles).where(eq(ncCatProfiles.id, req.profileId!)).limit(1)
        );
        if (!profile) {
          return err<NcCatAssignProfileRes, AppError>({
            code: 'NOT_FOUND',
            message: `Profile ${req.profileId} not found`
          });
        }
      }

      // Update the machine's profile assignment
      await withDb((db) =>
        db
          .update(machines)
          .set({ ncCatProfileId: req.profileId, updatedAt: now })
          .where(eq(machines.machineId, req.machineId))
      );

      const result: NcCatAssignProfileRes = {
        machineId: req.machineId,
        profileId: req.profileId
      };

      return ok<NcCatAssignProfileRes, AppError>(result);
    },
    { requiresAuth: false }
  );

  // Get all machines assigned to a specific profile
  registerResultHandler(
    'nc-catalyst:profiles:machines',
    async (_event, rawReq: unknown) => {
      const req = rawReq as { profileId: string };

      const rows = await withDb((db) =>
        db
          .select({
            machineId: machines.machineId,
            name: machines.name,
            ncCatProfileId: machines.ncCatProfileId
          })
          .from(machines)
          .where(eq(machines.ncCatProfileId, req.profileId))
      );

      const result: NcCatProfileMachinesRes = {
        profileId: req.profileId,
        machines: rows.map((m) => ({
          machineId: m.machineId,
          name: m.name,
          ncCatProfileId: m.ncCatProfileId ?? null
        }))
      };

      return ok<NcCatProfileMachinesRes, AppError>(result);
    },
    { requiresAuth: false }
  );

  // ---------------------------------------------------------------------------------
  // NC-Cat Validation Submission (IPC-based MES data transfer)
  // ---------------------------------------------------------------------------------

  registerResultHandler(
    'nc-catalyst:submit-validation',
    async (_event, rawReq: unknown) => {
      const req = rawReq as NcCatSubmitValidationReq;

      logger.info(
        { folderName: req.folderName, fileCount: req.files?.length ?? 0 },
        'NC-Cat submit-validation: received'
      );

      // Check for blocking errors in any file
      const hasBlockingErrors = req.validationPayload.files.some(
        (f) => f.validation.status === 'errors'
      );

      if (hasBlockingErrors) {
        const errorFiles = req.validationPayload.files
          .filter((f) => f.validation.status === 'errors')
          .map((f) => f.filename);

        logger.warn(
          { folderName: req.folderName, errorFiles },
          'NC-Cat submit-validation: rejected due to validation errors'
        );

        pushAppMessage(
          'ncCat.validationBlocked',
          { folderName: req.folderName, errorCount: errorFiles.length },
          { source: 'nc-catalyst' }
        );

        const result: NcCatSubmitValidationRes = {
          accepted: false,
          reason: `Validation errors in ${errorFiles.length} file(s): ${errorFiles.join(', ')}`,
          validationStatus: 'errors'
        };

        return ok<NcCatSubmitValidationRes, AppError>(result);
      }

      // Get processedJobsRoot from config
      const cfg = loadConfig();
      const processedJobsRoot = cfg.paths.processedJobsRoot;

      if (!processedJobsRoot || !existsSync(processedJobsRoot)) {
        logger.error(
          { processedJobsRoot },
          'NC-Cat submit-validation: processedJobsRoot not configured or does not exist'
        );

        return err<NcCatSubmitValidationRes, AppError>({
          code: 'CONFIG_ERROR',
          message: 'processedJobsRoot is not configured or does not exist'
        });
      }

      // Determine destination folder
      const destFolder = join(processedJobsRoot, req.folderName);

      try {
        // Check if we can move the source folder (preferred) or need to write files
        const canMoveSource = req.sourceFolderPath && existsSync(req.sourceFolderPath);

        if (canMoveSource) {
          // MOVE the source folder to processedJobsRoot
          logger.info(
            { sourceFolderPath: req.sourceFolderPath, destFolder },
            'NC-Cat submit-validation: moving source folder'
          );

          // Check if destination already exists
          let finalDestFolder = destFolder;
          if (existsSync(destFolder)) {
            finalDestFolder = join(processedJobsRoot, `${req.folderName}_${Date.now()}`);
            logger.warn(
              { destFolder, finalDestFolder },
              'NC-Cat submit-validation: destination exists, using timestamped name'
            );
          }

          try {
            // Try atomic rename first
            await fsp.rename(req.sourceFolderPath!, finalDestFolder);
            logger.info(
              { source: req.sourceFolderPath, destination: finalDestFolder },
              'NC-Cat submit-validation: folder moved (atomic rename)'
            );
          } catch (renameErr) {
            const code = (renameErr as NodeJS.ErrnoException)?.code;
            if (code === 'EXDEV') {
              // Cross-device, need to copy then delete
              logger.info(
                { source: req.sourceFolderPath, destination: finalDestFolder },
                'NC-Cat submit-validation: cross-device move, using copy+delete'
              );

              // Ensure destination exists
              if (!existsSync(finalDestFolder)) {
                mkdirSync(finalDestFolder, { recursive: true });
              }

              // Copy all files recursively
              const copyDir = async (src: string, dest: string) => {
                const entries = await fsp.readdir(src, { withFileTypes: true });
                for (const entry of entries) {
                  const srcPath = join(src, entry.name);
                  const destPath = join(dest, entry.name);
                  if (entry.isDirectory()) {
                    if (!existsSync(destPath)) {
                      mkdirSync(destPath, { recursive: true });
                    }
                    await copyDir(srcPath, destPath);
                  } else if (entry.isFile()) {
                    await fsp.copyFile(srcPath, destPath);
                  }
                }
              };

              await copyDir(req.sourceFolderPath!, finalDestFolder);

              // Delete source folder
              const deleteDir = async (dir: string) => {
                const entries = await fsp.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                  const fullPath = join(dir, entry.name);
                  if (entry.isDirectory()) {
                    await deleteDir(fullPath);
                  } else {
                    await fsp.unlink(fullPath);
                  }
                }
                await fsp.rmdir(dir);
              };

              await deleteDir(req.sourceFolderPath!);

              logger.info(
                { source: req.sourceFolderPath, destination: finalDestFolder },
                'NC-Cat submit-validation: folder moved (copy+delete)'
              );
            } else {
              throw renameErr;
            }
          }

          // Write any additional generated files (NESTPICK, labels) that weren't in source
          for (const file of req.files) {
            // Write NESTPICK file if provided (generated by NC-Cat, not in source)
            if (file.nestpickContent) {
              const nestpickExt = '.nsp';
              const baseNoExt = basename(file.filename, extname(file.filename));
              const nestpickPath = join(finalDestFolder, `${baseNoExt}${nestpickExt}`);
              writeFileSync(nestpickPath, file.nestpickContent, 'utf8');
            }

            // Write label images if provided (generated by NC-Cat)
            if (file.labelImages) {
              for (const [partNumber, dataUrl] of Object.entries(file.labelImages)) {
                if (!dataUrl) continue;
                const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
                if (match) {
                  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
                  const base64Data = match[2];
                  const baseNoExt = basename(file.filename, extname(file.filename));
                  const labelPath = join(finalDestFolder, `${baseNoExt}_${partNumber}.${ext}`);
                  writeFileSync(labelPath, Buffer.from(base64Data, 'base64'));
                }
              }
            }
          }
        } else {
          // FALLBACK: Write files from content (legacy behavior)
          logger.info(
            { destFolder, fileCount: req.files.length, sourceFolderPath: req.sourceFolderPath },
            'NC-Cat submit-validation: writing files from content (source folder not available)'
          );

          if (!existsSync(destFolder)) {
            mkdirSync(destFolder, { recursive: true });
          }

          // Write all files to destination
          for (const file of req.files) {
            // Write NC file
            const ncPath = join(destFolder, file.filename);
            writeFileSync(ncPath, file.ncContent, 'utf8');

            // Write NESTPICK file if provided
            if (file.nestpickContent) {
              const nestpickExt = '.nsp';
              const baseNoExt = basename(file.filename, extname(file.filename));
              const nestpickPath = join(destFolder, `${baseNoExt}${nestpickExt}`);
              writeFileSync(nestpickPath, file.nestpickContent, 'utf8');
            }

            // Write label images if provided
            if (file.labelImages) {
              for (const [partNumber, dataUrl] of Object.entries(file.labelImages)) {
                if (!dataUrl) continue;
                const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
                if (match) {
                  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
                  const base64Data = match[2];
                  const baseNoExt = basename(file.filename, extname(file.filename));
                  const labelPath = join(destFolder, `${baseNoExt}_${partNumber}.${ext}`);
                  writeFileSync(labelPath, Buffer.from(base64Data, 'base64'));
                }
              }
            }
          }
        }

        const finalDest = canMoveSource ? (existsSync(destFolder) ? join(processedJobsRoot, `${req.folderName}_${Date.now()}`) : destFolder) : destFolder;

        logger.info(
          { destFolder: finalDest, fileCount: req.files.length, moveMode: canMoveSource },
          'NC-Cat submit-validation: files processed to destination'
        );

        // Process each file entry and create job + nc_stats
        const jobKeys: string[] = [];

        for (const fileEntry of req.validationPayload.files) {
          // Build job key from folder and filename
          const baseNoExt = basename(fileEntry.filename, extname(fileEntry.filename));
          const jobKey = `${req.folderName}/${baseNoExt}`.slice(0, 100);
          jobKeys.push(jobKey);

          // Calculate cutting distance from tool usage
          const cuttingDistance = fileEntry.toolUsage.reduce(
            (sum, t) => sum + (t.cuttingDistanceMeters || 0),
            0
          );

          const estimatedRuntimeSeconds = Number.isFinite(fileEntry.ncEstRuntime) ? fileEntry.ncEstRuntime : null;

          // Upsert nc_stats with MES data
          try {
            await upsertNcStats({
              jobKey,
              ncEstRuntime: estimatedRuntimeSeconds != null ? Math.round(estimatedRuntimeSeconds) : null,
              yieldPercentage: fileEntry.yieldPercentage,
              wasteOffcutM2: fileEntry.wasteOffcutM2,
              wasteOffcutDustM3: fileEntry.wasteOffcutDustM3,
              totalToolDustM3: fileEntry.TotalToolDustM3,
              totalDrillDustM3: fileEntry.TotalDrillDustM3,
              sheetTotalDustM3: fileEntry.SheetTotalDustM3,
              cuttingDistanceMeters: cuttingDistance,
              usableOffcuts: fileEntry.usableOffcuts,
              toolUsage: fileEntry.toolUsage,
              drillUsage: fileEntry.drillUsage,
              validation: fileEntry.validation as ValidationResult,
              nestPick: fileEntry.nestPick,
              mesOutputVersion: req.validationPayload.exportMetadata?.mesOutputVersion ?? null
            });

            logger.debug({ jobKey }, 'NC-Cat submit-validation: upserted nc_stats');
          } catch (statsErr) {
            logger.warn(
              { err: statsErr, jobKey },
              'NC-Cat submit-validation: failed to upsert nc_stats'
            );
            // Continue processing other files
          }
        }

        // Trigger ingest to pick up the new files and create job records
        // This reuses the existing ingest logic which handles job creation properly
        try {
          const { ingestProcessedJobsRoot } = await import('../services/ingest');
          const ingestResult = await ingestProcessedJobsRoot();
          logger.info(
            { inserted: ingestResult.inserted, updated: ingestResult.updated },
            'NC-Cat submit-validation: triggered ingest'
          );
        } catch (ingestErr) {
          logger.warn({ err: ingestErr }, 'NC-Cat submit-validation: ingest failed');
        }

        // Check for warnings to notify
        const hasWarnings = req.validationPayload.files.some(
          (f) => f.validation.status === 'warnings'
        );

        if (hasWarnings) {
          const warningFiles = req.validationPayload.files
            .filter((f) => f.validation.status === 'warnings')
            .map((f) => f.filename);

          pushAppMessage(
            'ncCat.validationWarnings',
            { folderName: req.folderName, warningCount: warningFiles.length },
            { source: 'nc-catalyst' }
          );
        }

        pushAppMessage(
          'ncCat.jobsImported',
          { folderName: req.folderName, fileCount: req.files.length },
          { source: 'nc-catalyst' }
        );

        const result: NcCatSubmitValidationRes = {
          accepted: true,
          jobKey: jobKeys.length === 1 ? jobKeys[0] : null,
          destinationPath: destFolder,
          validationStatus: hasWarnings ? 'warnings' : 'pass'
        };

        return ok<NcCatSubmitValidationRes, AppError>(result);
      } catch (fileErr) {
        logger.error(
          { err: fileErr, destFolder },
          'NC-Cat submit-validation: failed to write files'
        );

        return err<NcCatSubmitValidationRes, AppError>({
          code: 'FILE_ERROR',
          message: `Failed to write files: ${fileErr instanceof Error ? fileErr.message : String(fileErr)}`
        });
      }
    },
    { requiresAuth: false }
  );

  // ---------------------------------------------------------------------------------
  // Open Job in Simulator (Phase 4)
  // ---------------------------------------------------------------------------------

  /**
   * Opens one or more jobs in the NC-Cat simulator window.
   * Reads the NC file contents from disk and sends them to NC-Cat.
   * This is called from the Jobs page context menu.
   */
  registerResultHandler(
    'nc-catalyst:open-jobs',
    async (_event, rawReq: unknown) => {
      const req = rawReq as { jobKeys: string[] };
      const jobKeys = req.jobKeys;

      if (!jobKeys || jobKeys.length === 0) {
        return err<OpenJobInSimulatorRes, AppError>({
          code: 'VALIDATION_ERROR',
          message: 'No job keys provided'
        });
      }

      logger.info({ jobKeys, count: jobKeys.length }, 'NC-Cat open-jobs: opening jobs in simulator');

      // Get processedJobsRoot from config
      const cfg = loadConfig();
      const processedJobsRoot = cfg.paths.processedJobsRoot;

      if (!processedJobsRoot || !existsSync(processedJobsRoot)) {
        return err<OpenJobInSimulatorRes, AppError>({
          code: 'CONFIG_ERROR',
          message: 'processedJobsRoot is not configured or does not exist'
        });
      }

      // Fetch job details from database
      const jobRows = await withDb((db) =>
        db
          .select({
            key: jobs.key,
            folder: jobs.folder,
            ncfile: jobs.ncfile,
            material: jobs.material
          })
          .from(jobs)
          .where(
            // Filter to only requested job keys using SQL IN
            jobKeys.length === 1
              ? eq(jobs.key, jobKeys[0])
              : inArray(jobs.key, jobKeys)
          )
      );

      logger.debug(
        { requestedKeys: jobKeys, foundCount: jobRows.length, foundKeys: jobRows.map(j => j.key) },
        'NC-Cat open-jobs: database query result'
      );

      const filteredJobs = jobRows;

      if (filteredJobs.length === 0) {
        return err<OpenJobInSimulatorRes, AppError>({
          code: 'NOT_FOUND',
          message: 'No matching jobs found in database'
        });
      }

      // Read NC file contents for each job
      const jobDescriptors: OpenJobDescriptor[] = [];
      const errors: string[] = [];

      for (const job of filteredJobs) {
        logger.debug(
          { jobKey: job.key, folder: job.folder, ncfile: job.ncfile, processedJobsRoot },
          'NC-Cat open-jobs: processing job'
        );

        if (!job.folder || !job.ncfile) {
          errors.push(`Job ${job.key} missing folder or ncfile`);
          continue;
        }

        // Build the path to the NC file
        // Use path.resolve to handle Windows paths correctly
        // The ncfile column may or may not include the .nc extension
        const ncFilename = job.ncfile.toLowerCase().endsWith('.nc') ? job.ncfile : `${job.ncfile}.nc`;
        let ncFilePath = resolve(processedJobsRoot, job.folder, ncFilename);

        logger.debug({ ncFilePath, ncFilename, exists: existsSync(ncFilePath) }, 'NC-Cat open-jobs: checking file');

        if (!existsSync(ncFilePath)) {
          // Try without extension as fallback (in case file doesn't have .nc extension)
          const altPath = resolve(processedJobsRoot, job.folder, job.ncfile);
          if (existsSync(altPath)) {
            logger.debug({ altPath }, 'NC-Cat open-jobs: found file without .nc extension');
            ncFilePath = altPath;
          } else {
            errors.push(`NC file not found: ${ncFilePath} (also tried: ${altPath})`);
            continue;
          }
        }

        try {
          const ncContent = readFileSync(ncFilePath, 'utf8');
          // Use the actual filename from the resolved path (includes extension)
          const actualFilename = basename(ncFilePath);

          jobDescriptors.push({
            jobKey: job.key,
            folder: job.folder,
            ncFile: actualFilename,
            ncContent,
            material: job.material
          });
        } catch (readErr) {
          errors.push(`Failed to read ${ncFilePath}: ${readErr instanceof Error ? readErr.message : String(readErr)}`);
        }
      }

      if (jobDescriptors.length === 0) {
        return err<OpenJobInSimulatorRes, AppError>({
          code: 'FILE_ERROR',
          message: `Failed to read any NC files: ${errors.join('; ')}`
        });
      }

      // Open the NC-Cat window if not already open
      openNcCatalystWindow();

      // Wait a bit for window to be ready, then send the jobs
      // We use webContents.send to push the jobs to NC-Cat
      const sendJobsToNcCat = () => {
        if (ncCatWin && !ncCatWin.isDestroyed()) {
          const payload: OpenJobInSimulatorReq = {
            jobs: jobDescriptors,
            replaceExisting: true
          };
          ncCatWin.webContents.send('nc-catalyst:open-jobs', payload);
          logger.info(
            { jobCount: jobDescriptors.length },
            'NC-Cat open-jobs: sent jobs to simulator window'
          );
        }
      };

      // Use did-finish-load to ensure the page is loaded and React app is mounted.
      // This is more reliable than ready-to-show which only indicates the window
      // is ready to display, not that the content has finished loading.
      if (ncCatWin && !ncCatWin.isDestroyed()) {
        // Check if the page has already finished loading
        if (!ncCatWin.webContents.isLoading()) {
          // Page already loaded, send after a small delay for React to mount
          logger.debug('NC-Cat open-jobs: page already loaded, sending jobs after delay');
          setTimeout(sendJobsToNcCat, 300);
        } else {
          // Wait for the page to finish loading
          logger.debug('NC-Cat open-jobs: waiting for page to finish loading');
          ncCatWin.webContents.once('did-finish-load', () => {
            // Give React a moment to mount after page load
            logger.debug('NC-Cat open-jobs: page finished loading, sending jobs after delay');
            setTimeout(sendJobsToNcCat, 300);
          });
        }
      }

      const result: OpenJobInSimulatorRes = {
        ok: true,
        jobCount: jobDescriptors.length,
        error: errors.length > 0 ? `Some files failed: ${errors.join('; ')}` : undefined
      };

      return ok<OpenJobInSimulatorRes, AppError>(result);
    },
    { requiresAuth: false }
  );

  // ---------------------------------------------------------------------------------
  // Subscription Auth IPC Handlers
  // ---------------------------------------------------------------------------------

  // Get hardware ID (NC-Cat calls this to get real hardware-based ID)
  registerResultHandler(
    'nc-catalyst:auth:getHardwareId',
    async () => {
      try {
        const hardwareId = await getHardwareId();
        return ok<string, AppError>(hardwareId);
      } catch (error) {
        logger.error({ error }, 'Failed to get hardware ID');
        return err<string, AppError>({
          code: 'HARDWARE_ERROR',
          message: `Failed to get hardware ID: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    },
    { requiresAuth: false }
  );

  // Get current subscription auth state
  registerResultHandler(
    'nc-catalyst:auth:getState',
    async () => {
      // If we have a cached state, return it immediately
      if (cachedSubscriptionAuthState) {
        return ok<SubscriptionAuthState | null, AppError>(cachedSubscriptionAuthState);
      }

      // Otherwise, try to get it from NC-Cat
      const state = await requestAuthStateFromNcCat();
      return ok<SubscriptionAuthState | null, AppError>(state);
    },
    { requiresAuth: false }
  );

  // Handle auth state updates from NC-Cat (NC-Cat pushes updates)
  ipcMain.on('nc-catalyst:auth:stateUpdate', (_event, state: SubscriptionAuthState) => {
    cachedSubscriptionAuthState = state;
    logNcCatAuthStateIfChanged('update', state);

    // Broadcast to all NestWatcher renderer windows
    const mainWindows = BrowserWindow.getAllWindows().filter((w) => w !== ncCatWin && w !== ncCatBackgroundWin);
    for (const win of mainWindows) {
      if (!win.isDestroyed()) {
        win.webContents.send('nc-catalyst:auth:stateChanged', state);
      }
    }
  });


  // Handle auth state response from NC-Cat (response to our request)
  ipcMain.on('nc-catalyst:auth:stateResponse', (_event, state: SubscriptionAuthState) => {
    cachedSubscriptionAuthState = state;
    logNcCatAuthStateIfChanged('response', state);
  });


  // Forward login request to NC-Cat
  registerResultHandler<{ success: boolean; state?: SubscriptionAuthState; error?: string }>(
    'nc-catalyst:auth:login',
    async (_event, rawReq: unknown) => {
      const req = rawReq as { email: string; password: string };
      const win = getActiveNcCatWindow();

      if (!win) {
        return err({
          code: 'NC_CAT_NOT_RUNNING',
          message: 'NC-Cat is not running. Please wait for it to start.'
        });
      }

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          ipcMain.removeListener('nc-catalyst:auth:loginResponse', handler);
          resolve(err({
            code: 'TIMEOUT',
            message: 'Login request timed out'
          }));
        }, 30000); // 30 second timeout for login

        const handler = (_evt: Electron.IpcMainEvent, response: { success: boolean; state?: SubscriptionAuthState; error?: string }) => {
          clearTimeout(timeout);
          ipcMain.removeListener('nc-catalyst:auth:loginResponse', handler);

          if (response.success && response.state) {
            cachedSubscriptionAuthState = response.state;
          }

          resolve(ok(response));
        };

        ipcMain.once('nc-catalyst:auth:loginResponse', handler);
        win.webContents.send('nc-catalyst:auth:loginRequest', req);
      });
    },
    { requiresAuth: false }
  );

  // Forward logout request to NC-Cat
  registerResultHandler<null>(
    'nc-catalyst:auth:logout',
    async () => {
      const win = getActiveNcCatWindow();

      if (!win) {
        // Clear cached state even if NC-Cat isn't running
        cachedSubscriptionAuthState = null;
        return ok(null);
      }

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          ipcMain.removeListener('nc-catalyst:auth:logoutResponse', handler);
          cachedSubscriptionAuthState = null;
          resolve(ok(null));
        }, 10000);

        const handler = () => {
          clearTimeout(timeout);
          ipcMain.removeListener('nc-catalyst:auth:logoutResponse', handler);
          cachedSubscriptionAuthState = null;
          resolve(ok(null));
        };

        ipcMain.once('nc-catalyst:auth:logoutResponse', handler);
        win.webContents.send('nc-catalyst:auth:logoutRequest');
      });
    },
    { requiresAuth: false }
  );

  // Check if subscription is valid (for NestWatcher to gate features)
  registerResultHandler(
    'nc-catalyst:auth:isValid',
    async () => {
      return ok<boolean, AppError>(isSubscriptionValid());
    },
    { requiresAuth: false }
  );
}
