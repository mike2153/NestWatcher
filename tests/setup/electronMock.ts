import { vi } from 'vitest';

// Minimal Electron mocks for unit tests that import main/preload modules.
vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: class {},
  session: { fromPartition: vi.fn(() => ({})) },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() }
}));

