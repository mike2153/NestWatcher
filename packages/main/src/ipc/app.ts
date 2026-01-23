import { err, ok } from 'neverthrow';
import type { AppError } from '../../../shared/src';
import { createAppError } from './errors';
import { registerResultHandler } from './result';

let showMainWindow: (() => void) | null = null;

export function requestShowMainWindow() {
  showMainWindow?.();
}

/**
 * Provide a callback that shows the main BrowserWindow.
 *
 * Main keeps the window hidden until the renderer tells us React has painted the splash.
 */
export function setShowMainWindow(handler: (() => void) | null) {
  showMainWindow = handler;
}

export function registerAppIpc() {
  // No auth required: this is used during app boot, before any user session exists.
  registerResultHandler(
    'app:readyToShow',
    async () => {
      if (!showMainWindow) {
        return err(createAppError('app.noWindow', 'Main window is not ready to show yet.'));
      }
      showMainWindow();
      return ok<null, AppError>(null);
    },
    { requiresAuth: false }
  );
}
