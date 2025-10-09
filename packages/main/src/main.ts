import { app, BrowserWindow } from 'electron';
import { join } from 'path';
import { registerSettingsIpc } from './ipc/settings';
import { registerJobsIpc } from './ipc/jobs';
import { registerDbIpc } from './ipc/db';
import { registerMachinesIpc } from './ipc/machines';
import { registerFilesIpc } from './ipc/files';
import { registerRouterIpc } from './ipc/router';
import { registerLifecycleIpc } from './ipc/lifecycle';
import { registerHypernestIpc } from './ipc/hypernest';
import { registerHistoryIpc } from './ipc/history';
import { registerAlarmsIpc } from './ipc/alarms';
import { registerDiagnosticsIpc } from './ipc/diagnostics';
import { registerLogIpc } from './ipc/log';
import { registerTelemetryIpc } from './ipc/telemetry';
import { registerUiIpc } from './ipc/ui';
import { registerGrundnerIpc } from './ipc/grundner';
import { initWatchers, shutdownWatchers } from './services/watchers';
import { startDbWatchdog, stopDbWatchdog } from './services/dbWatchdog';
import { logger } from './logger';
import { initializeDiagnostics } from './services/diagnostics';
import { applyStoredThemePreference, getStoredWindowState, monitorWindowState } from './services/uiState';
import {
  applyWindowNavigationGuards,
  ensureContentSecurityPolicy,
  logSecurityConfigurationSummary
} from './security';

let win: BrowserWindow | null = null;

function createWindow() {
  const state = getStoredWindowState();
  const options: Electron.BrowserWindowConstructorOptions = {
    width: state.width,
    height: state.height,
    webPreferences: {
      preload: join(__dirname, '../../preload/dist/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    },
    show: false
  };
  if (state.x != null && state.y != null) {
    options.x = state.x;
    options.y = state.y;
  }

  win = new BrowserWindow(options);
  monitorWindowState(win);

  applyWindowNavigationGuards(win.webContents);

  win.on('ready-to-show', () => {
    if (!win) return;
    if (state.maximized) {
      win.maximize();
    }
    win.show();
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(join(__dirname, '../../renderer/dist/index.html'));
  }
}

app.whenReady().then(async () => {
  const userDataPath = app.getPath('userData');
  process.env.WOODTRON_USER_DATA_PATH = userDataPath;
  process.env.WOODTRON_CONFIG_PATH = join(userDataPath, 'settings.json');

  applyStoredThemePreference();

  ensureContentSecurityPolicy();
  logSecurityConfigurationSummary();

  registerSettingsIpc();
  registerDbIpc();
  registerJobsIpc();
  registerMachinesIpc();
  registerFilesIpc();
  registerRouterIpc();
  registerLifecycleIpc();
  registerHypernestIpc();
  registerHistoryIpc();
  registerAlarmsIpc();
  registerDiagnosticsIpc();
  registerUiIpc();
  registerTelemetryIpc();
  registerLogIpc();
  registerGrundnerIpc();

  try {
    await initializeDiagnostics();
  } catch (error) {
    logger.warn({ error }, 'Failed to initialize diagnostics subsystem');
  }

  try {
    startDbWatchdog();
  } catch (error) {
    logger.error({ error }, 'Failed to start database watchdog');
  }

  initWatchers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (err) => logger.error({ err }, 'Uncaught exception'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled rejection'));

app.on('will-quit', async () => {
  try {
    await shutdownWatchers();
  } catch (err) {
    logger.error({ err }, 'Failed to stop watchers worker');
  }

  try {
    stopDbWatchdog();
  } catch (err) {
    logger.error({ err }, 'Failed to stop DB watchdog');
  }
});
