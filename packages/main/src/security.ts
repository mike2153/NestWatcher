import { app, session, shell, type WebContents } from 'electron';
import { logger } from './logger';
import type { Session } from 'electron';

const DEFAULT_EXTERNAL_ORIGINS = ['https://woodtron.com', 'https://www.woodtron.com'];
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['https:', 'mailto:', 'tel:']);
const ALLOWED_EXTERNAL_ORIGINS = new Set<string>([
  ...DEFAULT_EXTERNAL_ORIGINS,
  ...((process.env.APP_ALLOWED_EXTERNAL_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0))
]);

function getInternalOrigins(): Set<string> {
  const origins = new Set<string>();
  origins.add('file://');
  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) {
    try {
      origins.add(new URL(devServer).origin);
    } catch (err) {
      logger.warn({ devServer, err }, 'Invalid VITE_DEV_SERVER_URL; falling back to packaged CSP');
    }
  }
  return origins;
}

function isInternalNavigation(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'file:') return true;
    const allowedOrigins = getInternalOrigins();
    const origin = `${parsed.protocol}//${parsed.host}`;
    return allowedOrigins.has(origin);
  } catch {
    return false;
  }
}

function isAllowedExternal(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) return false;
    if (parsed.protocol === 'mailto:' || parsed.protocol === 'tel:') return true;
    const origin = `${parsed.protocol}//${parsed.host}`;
    return ALLOWED_EXTERNAL_ORIGINS.has(origin);
  } catch {
    return false;
  }
}

export function applyWindowNavigationGuards(contents: WebContents, options?: { allowExternal?: boolean }) {
  const allowExternal = options?.allowExternal ?? true;

  contents.setWindowOpenHandler(({ url }) => {
    if (allowExternal && isAllowedExternal(url)) {
      shell
        .openExternal(url)
        .catch((err) => logger.error({ err, url }, 'Failed to open external URL'));
    } else {
      logger.warn({ url }, 'Blocked window.open navigation');
    }
    return { action: 'deny' };
  });

  const handleNavigation = (event: Electron.Event, url: string) => {
    if (isInternalNavigation(url)) return;
    event.preventDefault();
    if (allowExternal && isAllowedExternal(url)) {
      shell
        .openExternal(url)
        .catch((err) => logger.error({ err, url }, 'Failed to open external URL'));
    } else {
      logger.warn({ url }, 'Blocked navigation attempt');
    }
  };

  contents.on('will-navigate', handleNavigation);
  contents.on('will-redirect', handleNavigation);
}

let cspConfigured = false;

function buildContentSecurityPolicy(): string {
  const directives: Record<string, Set<string>> = {
    'default-src': new Set(["'self'"]),
    'script-src': new Set(["'self'"]),
    'style-src': new Set(["'self'", "'unsafe-inline'"]),
    'img-src': new Set(["'self'", 'data:']),
    'font-src': new Set(["'self'"]),
    'connect-src': new Set(["'self'"]),
    'object-src': new Set(["'none'"]),
    'frame-ancestors': new Set(["'none'"]),
    'base-uri': new Set(["'self'"]),
    'form-action': new Set(["'self'"])
  };

  const devServer = process.env.VITE_DEV_SERVER_URL;
  const isDevelopment = !app.isPackaged;
  if (devServer) {
    try {
      const devUrl = new URL(devServer);
      directives['connect-src'].add(devUrl.origin);
      directives['connect-src'].add(`ws://${devUrl.host}`);
      directives['script-src'].add(devUrl.origin);
      if (isDevelopment) {
        directives['script-src'].add(`ws://${devUrl.host}`);
      }
    } catch (err) {
      logger.warn({ devServer, err }, 'Invalid dev server URL; skipping dev CSP extras');
    }
  }

  if (isDevelopment) {
    directives['script-src'].add("'unsafe-inline'");
    directives['script-src'].add("'unsafe-eval'");
    directives['connect-src'].add('ws://localhost:*');
  }

  return Object.entries(directives)
    .map(([key, values]) => `${key} ${Array.from(values).join(' ')}`)
    .join('; ');
}

export function ensureContentSecurityPolicy() {
  if (cspConfigured) return;
  const policy = buildContentSecurityPolicy();
  const targetSession = session.defaultSession;

  targetSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    responseHeaders['Content-Security-Policy'] = [policy];
    callback({ responseHeaders });
  });

  cspConfigured = true;
  logger.info({ policy }, 'Content Security Policy applied');
}

// Apply a custom CSP to a specific session (e.g., NC Catalyst window)
export function applyCustomContentSecurityPolicy(targetSession: Session, policy: string) {
  targetSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    responseHeaders['Content-Security-Policy'] = [policy];
    callback({ responseHeaders });
  });
  logger.info({ policy }, 'Custom Content Security Policy applied to session');
}

export function logSecurityConfigurationSummary() {
  logger.info(
    {
      allowedExternalOrigins: Array.from(ALLOWED_EXTERNAL_ORIGINS),
      allowedExternalProtocols: Array.from(ALLOWED_EXTERNAL_PROTOCOLS),
      internalOrigins: Array.from(getInternalOrigins()),
      packaged: app.isPackaged
    },
    'Navigation security configuration'
  );
}


