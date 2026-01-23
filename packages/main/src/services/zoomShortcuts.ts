import type { WebContents } from 'electron';

// Chromium (and therefore Electron) treats "Zoom In" as Ctrl + "=" on many keyboards,
// because the "+" symbol is typically Shift + "=".
//
// In practice this means:
// - The user presses Ctrl++
// - Electron reports key "=" or code "Equal" (varies by keyboard/layout)
// - Zoom In does not fire unless we explicitly handle it
//
// We install a small, safe main-process handler that:
// - Intercepts Ctrl/Cmd +/-/= (and numpad add/subtract)
// - Adjusts the current webContents zoom factor
// - Prevents the default handling to avoid inconsistent behavior across windows

const INSTALLED = new WeakSet<WebContents>();

const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function getZoomFactor(webContents: WebContents): Promise<number> {
  // Electron has changed zoom APIs over time.
  //
  // In some versions:
  //   webContents.getZoomFactor() -> number (sync)
  //
  // In older versions:
  //   webContents.getZoomFactor(callback) (async callback)
  //
  // If we only use the callback style on a newer Electron, the callback is never called,
  // which would cause our zoom handler to "hang" after we preventDefault.
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (n: unknown) => {
      if (resolved) return;
      resolved = true;
      resolve(typeof n === 'number' && Number.isFinite(n) ? n : 1);
    };

    try {
      const maybeReturn = (webContents as unknown as { getZoomFactor: (...args: any[]) => any }).getZoomFactor(
        (factor: unknown) => finish(factor)
      );

      // Newer Electron returns the factor synchronously.
      if (typeof maybeReturn === 'number') {
        finish(maybeReturn);
      }
    } catch {
      finish(1);
    }
  });
}

export function installZoomShortcuts(webContents: WebContents): void {
  if (INSTALLED.has(webContents)) return;
  INSTALLED.add(webContents);

  webContents.on('before-input-event', (event, input) => {
    // Only handle key down; this avoids double-triggering on key up.
    if (input.type !== 'keyDown') return;

    const ctrlOrCmd = input.control || input.meta;
    if (!ctrlOrCmd) return;
    if (input.alt) return;

    // Normalize common variants for "Zoom In" and "Zoom Out".
    // Notes:
    // - Ctrl++ is often reported as key "=" with Shift held.
    // - Numpad + is often code "NumpadAdd".
    // - Different keyboard layouts may report different key values, so we match several.
    const key = input.key;
    const code = input.code;

    const isZoomIn =
      key === '+' ||
      key === '=' ||
      key === 'Add' ||
      key === 'Plus' ||
      code === 'Equal' ||
      code === 'NumpadAdd';

    const isZoomOut =
      key === '-' ||
      key === 'Subtract' ||
      key === 'Minus' ||
      // Some layouts report Shift+- as "_"; this keeps behavior sane.
      key === '_' ||
      code === 'Minus' ||
      code === 'NumpadSubtract';

    const isZoomReset =
      key === '0' ||
      code === 'Digit0' ||
      code === 'Numpad0';

    if (!isZoomIn && !isZoomOut && !isZoomReset) return;

    event.preventDefault();

    void (async () => {
      const current = await getZoomFactor(webContents);
      if (isZoomReset) {
        webContents.setZoomFactor(1);
        return;
      }

      const next = clamp(current + (isZoomIn ? ZOOM_STEP : -ZOOM_STEP), ZOOM_MIN, ZOOM_MAX);
      webContents.setZoomFactor(next);
    })();
  });
}
