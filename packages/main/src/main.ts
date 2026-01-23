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
import { registerAppIpc, requestShowMainWindow, setShowMainWindow } from './ipc/app';
import { initWatchers, shutdownWatchers } from './services/watchers';
import { initMesValidationScanner, stopMesValidationScanner } from './services/mesValidation';
import { startDbWatchdog, stopDbWatchdog } from './services/dbWatchdog';
import { syncInventoryExportScheduler, stopInventoryExportScheduler } from './services/inventoryExportScheduler';
import { logger } from './logger';
import { initializeDiagnostics } from './services/diagnostics';
import { applyStoredThemePreference, getStoredWindowState, monitorWindowState } from './services/uiState';
import { installZoomShortcuts } from './services/zoomShortcuts';
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
    requestShowMainWindow();
    win.focus();
  });
}

// Ensure Ctrl++ works consistently for *all* windows, including NC Catalyst.
// (Ctrl++ is often delivered as Ctrl + "=" depending on keyboard layout.)
app.on('web-contents-created', (_event, contents) => {
  installZoomShortcuts(contents);
});


function createWindow() {
  const state = getStoredWindowState();
  let pendingShow = false;
  let windowReadyToShow = false;
  let hasShown = false;
  let fallbackTimer: NodeJS.Timeout | null = null;

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

  const showNow = () => {
    if (!win) return;
    if (hasShown) return;
    if (win.isDestroyed()) return;

    hasShown = true;
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    if (state.maximized) {
      win.maximize();
    }
    win.show();
    win.focus();
  };

  const requestShow = () => {
    pendingShow = true;
    if (!windowReadyToShow) return;
    showNow();
  };

  win.on('ready-to-show', () => {
    windowReadyToShow = true;
    if (pendingShow) {
      showNow();
    }
  });

  // Keep the window hidden until the renderer tells us React has painted the splash.
  // This prevents users seeing a blank HTML document during boot.
  setShowMainWindow(requestShow);

  // Safety fallback: never keep the window hidden forever.
  fallbackTimer = setTimeout(() => {
    logger.warn('Renderer never signalled ready-to-show; showing main window due to fallback timeout');
    requestShow();
  }, 15_000);
  if (typeof fallbackTimer.unref === 'function') fallbackTimer.unref();

  win.on('closed', () => {
    win = null;
    setShowMainWindow(null);

    // Darwin is macOS, not Linux.
    // On Windows, closing the main window should quit the whole app.
    // We do this explicitly because we also run hidden background windows (e.g. NC-Cat),
    // which would otherwise keep the Electron process alive.
    if (process.platform !== 'darwin' && !isQuitting) {
      logger.info({ windowCount: BrowserWindow.getAllWindows().length }, 'Main window closed; quitting application');
      app.quit();
    }
  });


  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(join(__dirname, '../../renderer/dist/index.html'));
  }

  // If the page load fails for any reason, show the window so the user can see the error.
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    logger.error({ errorCode, errorDescription }, 'Main window failed to load');
    showNow();
  });
}

async function shutdownAppServices(reason: string) {
  logger.info(
    {
      reason,
      windowCount: BrowserWindow.getAllWindows().length,
      windows: BrowserWindow.getAllWindows().map((w) => ({ id: w.id, destroyed: w.isDestroyed() }))
    },
    'Shutdown services starting'
  );

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
  registerAppIpc();

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

  const forceExitTimer = setTimeout(() => {
    logger.error({ signal }, 'Forced exit after shutdown timeout');
    process.exit(0);
  }, 15_000);
  if (typeof forceExitTimer.unref === 'function') forceExitTimer.unref();

  void shutdownAppServices(signal).finally(() => {
    clearTimeout(forceExitTimer);
    app.exit(0);
  });
};

process.on('SIGINT', () => handleProcessSignal('SIGINT'));
process.on('SIGTERM', () => handleProcessSignal('SIGTERM'));

app.on('before-quit', (event) => {
  if (isQuitting) return;
  isQuitting = true;
  event.preventDefault();

  const forceExitTimer = setTimeout(() => {
    logger.error('Forced exit after before-quit shutdown timeout');
    process.exit(0);
  }, 15_000);
  if (typeof forceExitTimer.unref === 'function') forceExitTimer.unref();

  for (const w of BrowserWindow.getAllWindows()) {
    logger.info({ id: w.id, destroyed: w.isDestroyed() }, 'Destroying BrowserWindow during shutdown');
    w.destroy();
  }

  void shutdownAppServices('before-quit').finally(() => {
    clearTimeout(forceExitTimer);
    app.exit(0);
  });
});

app.on('will-quit', async () => {
  if (!isQuitting) {
    isQuitting = true;
  }
  await shutdownAppServices('will-quit');
});
