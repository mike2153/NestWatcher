import { vi } from 'vitest';

// Minimal Electron mocks for unit tests that import main/preload modules.
type IpcEventMap = Map<string, Array<(...args: unknown[]) => void>>;

const ipcListeners: IpcEventMap = new Map();
const sentIpc: Array<{ channel: string; args: unknown[] }> = [];

const webContents = {
  send: (channel: string, ...args: unknown[]) => {
    sentIpc.push({ channel, args });
  },
  isDestroyed: () => false
};

class MockBrowserWindow {
  static getFocusedWindow() {
    return null;
  }

  static getAllWindows() {
    return [{ isDestroyed: () => false, webContents } as unknown as MockBrowserWindow];
  }

  webContents = webContents;
  isDestroyed() {
    return false;
  }
}

const ipcMain = {
  handle: vi.fn(),
  on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
    const list = ipcListeners.get(channel) ?? [];
    list.push(listener);
    ipcListeners.set(channel, list);
  }),
  emit: (channel: string, ...args: unknown[]) => {
    const list = ipcListeners.get(channel) ?? [];
    for (const listener of list) {
      listener(...args);
    }
  }
};

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => process.cwd()), isReady: vi.fn(() => true) },
  BrowserWindow: MockBrowserWindow,
  session: { fromPartition: vi.fn(() => ({})) },
  ipcMain,
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  __mock: {
    emitIpcMain: (channel: string, ...args: unknown[]) => ipcMain.emit(channel, ...args),
    getSentIpc: () => [...sentIpc],
    clearSentIpc: () => {
      sentIpc.length = 0;
    }
  }
}));
