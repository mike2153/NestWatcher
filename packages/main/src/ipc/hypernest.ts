import { app, BrowserWindow, session } from 'electron';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { ok } from 'neverthrow';
import type { AppError } from '../../../shared/src';
import { applyWindowNavigationGuards, applyCustomContentSecurityPolicy } from '../security';
import { registerResultHandler } from './result';

let ncCatWin: BrowserWindow | null = null;

function resolveNcCatalystIndex(): string {
  const entry = process.env.NC_CATALYST_ENTRY || 'new-ui/dist/index.html';

  // Prefer a dev working copy when provided
  const devDir = process.env.NC_CATALYST_DEV_DIR;
  if (devDir && existsSync(devDir)) {
    return join(resolve(devDir), entry);
  }

  // Packaged: <App>/resources/nc-catalyst-2
  // Dev:      ../../../resources/nc-catalyst-2 relative to compiled dist
  const base = app.isPackaged
    ? join(process.resourcesPath, 'nc-catalyst-2')
    : resolve(__dirname, '../../../resources/nc-catalyst-2');

  return join(base, entry);
}

export function openNcCatalystWindow() {
  if (ncCatWin && !ncCatWin.isDestroyed()) {
    ncCatWin.focus();
    return;
  }

  const indexFile = resolveNcCatalystIndex();

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
    "default-src 'self' https: data:",
    // Inline handlers + Tailwind CDN runtime + Babylon + JSZip rely on relaxed script execution
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com https://cdn.babylonjs.com",
    // Tailwind + Google Fonts stylesheet
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    // Google Fonts assets
    "font-src 'self' https://fonts.gstatic.com",
    // Images from local and possible https
    "img-src 'self' data: blob: https:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; ');
  applyCustomContentSecurityPolicy(ncSession, ncPolicy);

  ncCatWin.loadFile(indexFile).catch((err) => {
    console.error('Failed to load NC Catalyst', { err, indexFile });
  });
}

export function registerNcCatalystIpc() {
  registerResultHandler('nc-catalyst:open', async () => {
    openNcCatalystWindow();
    return ok<null, AppError>(null);
  });
}
