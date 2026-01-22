import { app, BrowserWindow } from 'electron';
import { join } from 'path';
import { registerSettingsIpc } from './ipc/settings';
import { registerJobsIpc } from './ipc/jobs';
import { registerDbIpc } from './ipc/db';
import { registerMachinesIpc } from './ipc/machines';
import { registerFilesIpc } from './ipc/files';
import { registerRouterIpc } from './ipc/router';
import { registerLifecycleIpc } from './ipc/lifecycle';
import { registerNcCatalystIpc, startNcCatBackgroundWindow, stopNcCatBackgroundWindow } from './ipc/hypernest';
import { registerHistoryIpc } from './ipc/history';
import { registerAlarmsIpc } from './ipc/alarms';
import { registerDiagnosticsIpc } from './ipc/diagnostics';
import { registerLogIpc } from './ipc/log';
import { registerTelemetryIpc } from './ipc/telemetry';
import { registerUiIpc } from './ipc/ui';
import { registerGrundnerIpc } from './ipc/grundner';
import { registerAllocatedMaterialIpc } from './ipc/allocatedMaterial';
import { registerMessagesIpc } from './ipc/messages';
import { registerOrderingIpc } from './ipc/ordering';
import { registerAuthIpc } from './ipc/auth';
import { registerMesDataIpc } from './ipc/mesData';
import { registerNcCatValidationReportsIpc } from './ipc/ncCatValidationReports';
import { initWatchers, shutdownWatchers } from './services/watchers';
import { initMesValidationScanner, stopMesValidationScanner } from './services/mesValidation';
import { startDbWatchdog, stopDbWatchdog } from './services/dbWatchdog';
import { syncInventoryExportScheduler, stopInventoryExportScheduler } from './services/inventoryExportScheduler';
import { logger } from './logger';
import { initializeDiagnostics } from './services/diagnostics';
import { applyStoredThemePreference, getStoredWindowState, monitorWindowState } from './services/uiState';
import {
  applyWindowNavigationGuards,
  ensureContentSecurityPolicy,
} from './security';

let win: BrowserWindow | null = null;
let isQuitting = false;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
}


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

async function shutdownAppServices(reason: string) {
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

  try {
    stopInventoryExportScheduler();
  } catch (err) {
    logger.error({ err }, 'Failed to stop inventory export scheduler');
  }

  try {
    stopNcCatBackgroundWindow();
  } catch (err) {
    logger.error({ err }, 'Failed to stop NC-Cat background window');
  }

  try {
    stopMesValidationScanner();
  } catch (err) {
    logger.error({ err }, 'Failed to stop MES validation scanner');
  }

  logger.info({ reason }, 'Shutdown services complete');
}

app.whenReady().then(async () => {

  const userDataPath = app.getPath('userData');
  process.env.WOODTRON_USER_DATA_PATH = userDataPath;
  process.env.WOODTRON_CONFIG_PATH = join(userDataPath, 'settings.json');

  applyStoredThemePreference();

  ensureContentSecurityPolicy();

  registerSettingsIpc();
  registerAuthIpc();
  registerDbIpc();
  registerJobsIpc();
  registerMachinesIpc();
  registerFilesIpc();
  registerRouterIpc();
  registerLifecycleIpc();
  registerNcCatalystIpc();
  registerHistoryIpc();
  registerAlarmsIpc();
  registerDiagnosticsIpc();
  registerUiIpc();
  registerTelemetryIpc();
  registerLogIpc();
  registerGrundnerIpc();
  registerAllocatedMaterialIpc();
  registerMessagesIpc();
  registerOrderingIpc();
  registerMesDataIpc();
  registerNcCatValidationReportsIpc();

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
  initMesValidationScanner();

  try {
    syncInventoryExportScheduler();
  } catch (error) {
    logger.warn({ error }, 'Failed to start inventory export scheduler');
  }

  // Start NC-Cat in background mode for subscription auth
  try {
    startNcCatBackgroundWindow();
  } catch (error) {
    logger.warn({ error }, 'Failed to start NC-Cat background window');
  }

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

const handleProcessSignal = (signal: string) => {
  if (isQuitting) return;
  isQuitting = true;
  void shutdownAppServices(signal).finally(() => {
    app.exit(0);
  });
};

process.on('SIGINT', () => handleProcessSignal('SIGINT'));
process.on('SIGTERM', () => handleProcessSignal('SIGTERM'));

app.on('before-quit', (event) => {
  if (isQuitting) return;
  isQuitting = true;
  event.preventDefault();

  for (const w of BrowserWindow.getAllWindows()) {
    w.destroy();
  }

  void shutdownAppServices('before-quit').finally(() => {
    app.exit(0);
  });
});

app.on('will-quit', async () => {
  if (!isQuitting) {
    isQuitting = true;
  }
  await shutdownAppServices('will-quit');
});
