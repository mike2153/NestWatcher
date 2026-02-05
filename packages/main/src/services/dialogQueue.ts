import { BrowserWindow, ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import type { AppDialogRequest, AppDialogSeverity } from '../../../shared/src';
import { UI_DIALOG_ENQUEUE_CHANNEL } from '../../../shared/src';

type DialogType = 'none' | 'info' | 'warning' | 'error' | 'question';

export type QueuedDialog = {
  type: DialogType;
  title: string;
  message: string;
  detail?: string;
  buttons?: string[];
  defaultId?: number;
};

const queue: QueuedDialog[] = [];

let flushTimer: NodeJS.Timeout | null = null;
let rendererReady = false;

function toSeverity(type: DialogType): AppDialogSeverity {
  switch (type) {
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    case 'question':
      return 'question';
    case 'info':
    case 'none':
    default:
      return 'info';
  }
}

function getTargetWindow(): BrowserWindow | null {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  return win && !win.isDestroyed() ? win : null;
}

function scheduleFlush(delayMs = 0): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;

    if (!rendererReady) {
      // Renderer has not subscribed yet; keep the backlog until it does.
      scheduleFlush(250);
      return;
    }

    const win = getTargetWindow();
    if (!win) {
      // No window yet (startup). Try again shortly (but don't spin).
      scheduleFlush(250);
      return;
    }

    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) continue;
      const payload: AppDialogRequest = {
        id: randomUUID(),
        severity: toSeverity(next.type),
        title: next.title,
        message: next.message,
        detail: next.detail,
        buttons: next.buttons ?? ['OK'],
        defaultId: next.defaultId ?? 0,
        createdAt: new Date().toISOString()
      };
      try {
        win.webContents.send(UI_DIALOG_ENQUEUE_CHANNEL, payload);
      } catch {
        // If the renderer is unavailable, drop this dialog request.
      }
    }
  }, delayMs);

  if (typeof flushTimer.unref === 'function') {
    flushTimer.unref();
  }
}

let ipcHooked = false;
function ensureIpcHooked(): void {
  if (ipcHooked) return;
  ipcHooked = true;
  ipcMain.on('ui:dialog:ready', () => {
    // Renderer is subscribed and ready to receive the backlog.
    rendererReady = true;
    scheduleFlush(0);
  });
}

// Important: hook IPC immediately so we don't miss the renderer's
// early "ui:dialog:ready" signal during startup.
ensureIpcHooked();

export function enqueueDialog(dialogRequest: QueuedDialog): void {
  queue.push(dialogRequest);
  scheduleFlush();
}
