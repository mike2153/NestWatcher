import { join } from 'path';
import { vi } from 'vitest';
import type { IpcMain } from 'electron';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

const ipcMain = {
  handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(channel, handler);
  }),
  removeHandler: vi.fn((channel: string) => {
    handlers.delete(channel);
  })
};

const resolvedUserData = () => {
  const override = process.env.WOODTRON_USER_DATA_PATH;
  if (override && override.trim()) return override.trim();
  return join(process.cwd(), '.woodtron');
};

const app = {
  getPath: vi.fn((key: string) => (key === 'userData' ? resolvedUserData() : resolvedUserData())),
  isReady: vi.fn(() => true),
  whenReady: vi.fn(() => Promise.resolve()),
  on: vi.fn()
};

const shell = {
  openExternal: vi.fn(async () => undefined)
};

const shared = {
  app,
  ipcMain,
  BrowserWindow: class {},
  shell
};

vi.mock('electron', () => shared);

(async () => {
  const bridgeModule = await import('../../packages/main/src/ipc/ipcBridge');
  const mod = bridgeModule as { __setIpcMain?: (mock: IpcMain) => void };
  if (mod && typeof mod.__setIpcMain === 'function') {
    mod.__setIpcMain(ipcMain as unknown as IpcMain);
  }
})();

(globalThis as unknown as { __IPC_HANDLERS__?: Map<string, (...args: unknown[]) => unknown> }).__IPC_HANDLERS__ = handlers;







