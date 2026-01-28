import { BrowserWindow, dialog } from 'electron';

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
let showing = false;

async function showNext(): Promise<void> {
  if (showing) return;
  const next = queue.shift();
  if (!next) return;

  showing = true;
  try {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    const options = {
      type: next.type,
      title: next.title,
      message: next.message,
      detail: next.detail,
      buttons: next.buttons ?? ['OK'],
      defaultId: next.defaultId ?? 0
    };
    if (win) {
      await dialog.showMessageBox(win, options);
    } else {
      await dialog.showMessageBox(options);
    }
  } finally {
    showing = false;
    // Avoid deep recursion.
    setImmediate(() => {
      void showNext();
    });
  }
}

export function enqueueDialog(dialogRequest: QueuedDialog): void {
  queue.push(dialogRequest);
  void showNext();
}
