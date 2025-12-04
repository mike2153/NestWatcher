import { app, BrowserWindow, session } from 'electron';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { ok } from 'neverthrow';
import type { AppError, SharedSettingsSnapshot } from '../../../shared/src';
import { applyWindowNavigationGuards, applyCustomContentSecurityPolicy } from '../security';
import { registerResultHandler } from './result';
import { applyNcCatSettingsSnapshot } from '../services/ncCatSettings';
import { loadConfig } from '../services/config';
import { machines } from '../db/schema';
import { withDb } from '../services/db';

let ncCatWin: BrowserWindow | null = null;

/**
 * Returns either a dev server URL (if NC_CATALYST_DEV_URL is set) or a file path.
 * When NC_CATALYST_DEV_URL is set (e.g., "http://localhost:5173"), we load from
 * the Vite dev server for hot reload during development.
 */
function resolveNcCatalystSource(): { type: 'url'; url: string } | { type: 'file'; path: string } {
  // Hot reload: if dev URL is set, use it
  const devUrl = process.env.NC_CATALYST_DEV_URL;
  if (devUrl) {
    return { type: 'url', url: devUrl };
  }

  // Otherwise, load from file
  const entry = process.env.NC_CATALYST_ENTRY || 'app/index.html';

  // Prefer a dev working copy when provided
  const devDir = process.env.NC_CATALYST_DEV_DIR;
  if (devDir && existsSync(devDir)) {
    return { type: 'file', path: join(resolve(devDir), entry) };
  }

  // Packaged: <App>/resources/nc-catalyst-2
  // Dev:      ../../../resources/nc-catalyst-2 relative to compiled dist
  const base = app.isPackaged
    ? join(process.resourcesPath, 'nc-catalyst-2')
    : resolve(__dirname, '../../../resources/nc-catalyst-2');

  return { type: 'file', path: join(base, entry) };
}

export function openNcCatalystWindow() {
  if (ncCatWin && !ncCatWin.isDestroyed()) {
    ncCatWin.focus();
    return;
  }

  const source = resolveNcCatalystSource();

  ncCatWin = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: {
      // Use a separate session so we can apply a relaxed CSP without affecting the main app
      partition: 'persist:nc-catalyst',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });

  applyWindowNavigationGuards(ncCatWin.webContents, { allowExternal: false });

  ncCatWin.on('ready-to-show', () => ncCatWin?.show());
  ncCatWin.on('closed', () => {
    ncCatWin = null;
  });
  ncCatWin.webContents.on('did-finish-load', () => {
    // NC Catalyst UI is designed for a browser viewport; scale slightly for the desktop window
    ncCatWin?.webContents.setZoomFactor(0.9);
  });

  // Relaxed CSP for NC Catalyst: allow required CDNs and inline handlers in this session only
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
    // Allow WebSocket connections for Vite HMR
    "connect-src 'self' ws: wss: http://localhost:* https://localhost:*",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; ');
  applyCustomContentSecurityPolicy(ncSession, ncPolicy);

  if (source.type === 'url') {
    // Hot reload mode: load from Vite dev server
    ncCatWin.loadURL(source.url).catch((err) => {
      console.error('Failed to load NC Catalyst from dev server', { err, url: source.url });
    });
  } else {
    // Production mode: load from file
    ncCatWin.loadFile(source.path).catch((err) => {
      console.error('Failed to load NC Catalyst', { err, path: source.path });
    });
  }
}

export function registerNcCatalystIpc() {
  registerResultHandler('nc-catalyst:open', async () => {
    openNcCatalystWindow();
    return ok<null, AppError>(null);
  });

  // Provide shared WE settings (paths + machines) back to NC-Cat when requested.
  registerResultHandler('nc-catalyst:get-shared-settings', async () => {
    const cfg = loadConfig();

    const rows = await withDb((db) =>
      db
        .select({
          machineId: machines.machineId,
          name: machines.name,
          ncCatMachineId: machines.ncCatMachineId
        })
        .from(machines)
    );

    const snapshot: SharedSettingsSnapshot = {
      processedJobsRoot: cfg.paths.processedJobsRoot ?? '',
      // For now, treat jobsRoot as the same as processedJobsRoot; can be split later if needed.
      jobsRoot: cfg.paths.processedJobsRoot ?? '',
      quarantineRoot: null,
      machines: rows.map((m) => ({
        machineId: m.machineId,
        name: m.name,
        ncCatMachineId: m.ncCatMachineId ?? null
      })),
      nestWatcherInstalled: true
    };

    return ok<SharedSettingsSnapshot, AppError>(snapshot);
  });

  // Accept settings snapshots from NC-Cat and apply them to the local database.
  registerResultHandler('nc-catalyst:settings-updated', async (snapshot: unknown) => {
    try {
      await applyNcCatSettingsSnapshot(snapshot);
      return ok<null, AppError>(null);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[NC-Cat] Failed to handle settings snapshot', error);
      throw error;
    }
  });
}
