import { app, BrowserWindow, session } from 'electron';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { ok } from 'neverthrow';
import type { AppError } from '../../../shared/src';
import { applyWindowNavigationGuards, applyCustomContentSecurityPolicy } from '../security';
import { registerResultHandler } from './result';

let hypernestWin: BrowserWindow | null = null;

function resolveHypernestIndex(): string {
  const entry = process.env.HYPERNEST_ENTRY || 'index.html';

  // Prefer a dev working copy when provided
  const devDir = process.env.HYPERNEST_DEV_DIR;
  if (devDir && existsSync(devDir)) {
    return join(resolve(devDir), entry);
  }

  // Packaged: <App>/resources/hypernest
  // Dev:      ../../../resources/hypernest relative to compiled dist
  const base = app.isPackaged
    ? join(process.resourcesPath, 'hypernest')
    : resolve(__dirname, '../../../resources/hypernest');

  return join(base, entry);
}

export function openHypernestWindow() {
  if (hypernestWin && !hypernestWin.isDestroyed()) {
    hypernestWin.focus();
    return;
  }

  const indexFile = resolveHypernestIndex();

  hypernestWin = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      // Use a separate session so we can apply a relaxed CSP without affecting the main app
      partition: 'persist:hypernest',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });

  applyWindowNavigationGuards(hypernestWin.webContents, { allowExternal: false });

  hypernestWin.on('ready-to-show', () => hypernestWin?.show());
  hypernestWin.on('closed', () => {
    hypernestWin = null;
  });
  hypernestWin.webContents.on('did-finish-load', () => {
    // Hypernest UI is designed for a browser viewport; scale it slightly for the desktop window
    hypernestWin?.webContents.setZoomFactor(0.9);
  });

  // Relaxed CSP for Hypernest: allow required CDNs and inline handlers in this session only
  const hnSession = session.fromPartition('persist:hypernest');
  const hnPolicy = [
    "default-src 'self' https: data:",
    // Inline handlers + Tailwind CDN runtime rely on relaxed script execution
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://cdn.babylonjs.com",
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
  applyCustomContentSecurityPolicy(hnSession, hnPolicy);

  hypernestWin.loadFile(indexFile).catch((err) => {
    console.error('Failed to load Hypernest', { err, indexFile });
  });
}

export function registerHypernestIpc() {
  registerResultHandler('hypernest:open', async () => {
    openHypernestWindow();
    return ok<null, AppError>(null);
  });
}
