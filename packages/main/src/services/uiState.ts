import { app, nativeTheme } from 'electron';
import type { BrowserWindow } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from '../logger';

export type ThemePreference = 'system' | 'light' | 'dark' | 'modern';

export type WindowState = {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
};

type UiState = {
  window?: WindowState;
  theme?: ThemePreference;
};

const DEFAULT_WINDOW: WindowState = { width: 1280, height: 800 };
let cachedState: UiState | null = null;

function getStatePath() {
  const base = app.getPath('userData');
  return join(base, 'ui-state.json');
}

function loadState(): UiState {
  if (cachedState) return cachedState;
  const file = getStatePath();
  try {
    if (!existsSync(file)) {
      cachedState = {};
      return cachedState;
    }
    const raw = readFileSync(file, 'utf8');
    cachedState = JSON.parse(raw) as UiState;
    return cachedState ?? {};
  } catch (error) {
    logger.warn({ error }, 'Failed to load UI state');
    cachedState = {};
    return cachedState;
  }
}

function persistState(next: UiState) {
  const file = getStatePath();
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
    cachedState = next;
  } catch (error) {
    logger.warn({ error }, 'Failed to persist UI state');
  }
}

function clampWindowBounds(bounds: Partial<WindowState>): WindowState {
  const width = Math.max(bounds.width ?? DEFAULT_WINDOW.width, 960);
  const height = Math.max(bounds.height ?? DEFAULT_WINDOW.height, 600);
  const x = Number.isFinite(bounds.x) ? bounds.x : undefined;
  const y = Number.isFinite(bounds.y) ? bounds.y : undefined;
  return { width, height, x, y, maximized: bounds.maximized ?? false };
}

export function getStoredWindowState(): WindowState {
  const state = loadState();
  return clampWindowBounds(state.window ?? DEFAULT_WINDOW);
}

function captureWindowState(win: BrowserWindow) {
  if (win.isDestroyed()) return;
  const isFullScreen = win.isFullScreen();
  const isMaximized = win.isMaximized() || isFullScreen;
  const bounds = isMaximized ? win.getNormalBounds() : win.getBounds();
  const next: UiState = {
    ...loadState(),
    window: clampWindowBounds({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized: isMaximized
    })
  };
  persistState(next);
}

export function monitorWindowState(win: BrowserWindow) {
  let timer: NodeJS.Timeout | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      captureWindowState(win);
    }, 500);
  };
  win.on('move', schedule);
  win.on('resize', schedule);
  win.on('maximize', schedule);
  win.on('unmaximize', schedule);
  win.on('close', () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    captureWindowState(win);
  });
}

export function getThemePreference(): ThemePreference {
  const state = loadState();
  const pref = state.theme;
  if (pref === 'light' || pref === 'dark' || pref === 'system' || pref === 'modern') {
    return pref;
  }
  return 'system';
}

export function applyStoredThemePreference(): ThemePreference {
  const preference = getThemePreference();
  // Electron supports 'system' | 'light' | 'dark' for themeSource.
  nativeTheme.themeSource = preference === 'modern' ? 'dark' : preference;
  return preference;
}

export function setThemePreference(preference: ThemePreference) {
  nativeTheme.themeSource = preference === 'modern' ? 'dark' : preference;
  const next: UiState = { ...loadState(), theme: preference };
  persistState(next);
}

