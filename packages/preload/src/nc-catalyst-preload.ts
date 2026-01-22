/**
 * Minimal preload script for NC-Cat window.
 * NC-Cat should NOT have access to NestWatcher's window.api methods.
 * It only needs IPC for communicating auth state and validation data.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type {
  SharedSettingsSnapshot,
  NcCatHeadlessValidateRequest,
  NcCatHeadlessValidateResponse,
  NcCatSubmitValidationReq,
  NcCatSubmitValidationRes,
  SubscriptionAuthState,
  OpenJobInSimulatorReq,
  NcCatProfilesListRes,
  NcCatProfile,
  NcCatProfileSaveReq,
  NcCatProfileSetActiveReq,
  NcCatProfileDeleteReq,
  NcCatAssignProfileReq,
  NcCatAssignProfileRes,
  NcCatProfileMachinesReq,
  NcCatProfileMachinesRes
} from '../../shared/src';
import { type ResultEnvelope } from '../../shared/src/result';

type NcCatLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
type NcCatLogPayload = { level: NcCatLogLevel; message: string; timestamp: string };

const NC_CAT_LOG_FORWARDER_KEY = '__nestWatcherNcCatLogForwarderInstalled__';
const NC_CAT_LOG_CHANNEL = 'nc-catalyst:log';

function formatLogArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack || arg.message;
  if (typeof arg === 'string') return arg;
  if (typeof arg === 'number' || typeof arg === 'boolean' || typeof arg === 'bigint') return String(arg);
  if (arg == null) return String(arg);

  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(
      arg,
      (_key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
        }
        return value;
      },
      2
    );
  } catch {
    try {
      return String(arg);
    } catch {
      return '[Unserializable]';
    }
  }
}

function formatLogMessage(args: unknown[]): string {
  const joined = args.map(formatLogArg).join(' ');
  const maxLen = 8_000;
  return joined.length > maxLen ? `${joined.slice(0, maxLen)}…` : joined;
}

function sendNcCatLog(level: NcCatLogLevel, args: unknown[]) {
  try {
    const payload: NcCatLogPayload = {
      level,
      message: formatLogMessage(args),
      timestamp: new Date().toISOString()
    };
    ipcRenderer.send(NC_CAT_LOG_CHANNEL, payload);
  } catch {
    // never let logging break NC-Cat
  }
}

function installNcCatConsoleForwarding() {
  const consoleAny = console as unknown as Record<string, unknown>;
  if (consoleAny[NC_CAT_LOG_FORWARDER_KEY]) return;
  consoleAny[NC_CAT_LOG_FORWARDER_KEY] = true;

  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
    trace: console.trace.bind(console)
  };

  console.log = (...args: unknown[]) => {
    original.log(...args);
    sendNcCatLog('info', args);
  };

  console.info = (...args: unknown[]) => {
    original.info(...args);
    sendNcCatLog('info', args);
  };

  console.warn = (...args: unknown[]) => {
    original.warn(...args);
    sendNcCatLog('warn', args);
  };

  console.error = (...args: unknown[]) => {
    original.error(...args);
    sendNcCatLog('error', args);
  };

  console.debug = (...args: unknown[]) => {
    original.debug(...args);
    sendNcCatLog('debug', args);
  };

  console.trace = (...args: unknown[]) => {
    original.trace(...args);
    sendNcCatLog('trace', args);
  };

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('error', (event) => {
      // event.error is often the most useful thing here
      sendNcCatLog('error', ['window:error', (event as ErrorEvent).message, (event as ErrorEvent).error]);
    });

    window.addEventListener('unhandledrejection', (event) => {
      sendNcCatLog('error', ['window:unhandledrejection', (event as PromiseRejectionEvent).reason]);
    });
  }
}

installNcCatConsoleForwarding();

const subscriptionAuthRequestStateHandlers = new Set<() => void>();
let pendingSubscriptionAuthStateRequest = false;

// Listen for auth state requests from main process
ipcRenderer.on('nc-catalyst:auth:requestState', () => {
  if (subscriptionAuthRequestStateHandlers.size > 0) {
    for (const handler of subscriptionAuthRequestStateHandlers) {
      try {
        handler();
      } catch {
        // ignore
      }
    }
  } else {
    pendingSubscriptionAuthStateRequest = true;
  }
});

const invokeResult = <T>(channel: string, ...args: unknown[]): Promise<ResultEnvelope<T>> =>
  ipcRenderer.invoke(channel, ...args) as Promise<ResultEnvelope<T>>;

// Expose minimal API for NC-Cat
// We expose this under both 'nestWatcherBridge' (new) and 'api' (for NC-Cat compatibility)
const ncCatApi = {
  // Get shared settings from NestWatcher
  getSharedSettings: () => invokeResult<SharedSettingsSnapshot>('nc-catalyst:get-shared-settings'),

  // Submit validation results to NestWatcher
  submitValidation: (req: NcCatSubmitValidationReq) =>
    invokeResult<NcCatSubmitValidationRes>('nc-catalyst:submit-validation', req),

  // ---------------------------------------------------------------------------------
  // NC-Cat Machine Profiles CRUD (stored in PostgreSQL)
  // ---------------------------------------------------------------------------------
  profiles: {
    list: () => invokeResult<NcCatProfilesListRes>('nc-catalyst:profiles:list'),
    save: (req: NcCatProfileSaveReq) => invokeResult<NcCatProfile>('nc-catalyst:profiles:save', req),
    setActive: (req: NcCatProfileSetActiveReq) =>
      invokeResult<null>('nc-catalyst:profiles:setActive', req),
    delete: (req: NcCatProfileDeleteReq) => invokeResult<null>('nc-catalyst:profiles:delete', req),

    // Profile ↔ Machine assignment
    assign: (req: NcCatAssignProfileReq) =>
      invokeResult<NcCatAssignProfileRes>('nc-catalyst:profiles:assign', req),
    getMachines: (req: NcCatProfileMachinesReq) =>
      invokeResult<NcCatProfileMachinesRes>('nc-catalyst:profiles:machines', req)
  },

  // Listen for headless validation requests (NestWatcher -> NC-Cat)
  onValidationRequest: (listener: (payload: NcCatHeadlessValidateRequest) => void) => {
    const channel = 'nc-catalyst:validation:request';
    const handler = (_event: Electron.IpcRendererEvent, payload: NcCatHeadlessValidateRequest) =>
      listener(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  // Send headless validation response back to NestWatcher
  sendValidationResponse: (response: NcCatHeadlessValidateResponse) => {
    ipcRenderer.send('nc-catalyst:validation:response', response);
  },

  // Listen for jobs being opened in NC-Cat
  onOpenJobs: (listener: (payload: OpenJobInSimulatorReq) => void) => {
    const channel = 'nc-catalyst:open-jobs';
    const handler = (_event: Electron.IpcRendererEvent, payload: OpenJobInSimulatorReq) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  // Subscription auth state management
  subscriptionAuth: {
    // Get hardware ID from main process
    getHardwareId: () => invokeResult<string>('nc-catalyst:auth:getHardwareId'),

    // Register handler to respond to auth state requests
    onRequestState: (handler: () => void) => {
      subscriptionAuthRequestStateHandlers.add(handler);
      if (pendingSubscriptionAuthStateRequest) {
        pendingSubscriptionAuthStateRequest = false;
        try {
          handler();
        } catch {
          // ignore
        }
      }
      return () => {
        subscriptionAuthRequestStateHandlers.delete(handler);
      };
    },

    // Send auth state response to main process
    sendStateResponse: (state: SubscriptionAuthState) => {
      ipcRenderer.send('nc-catalyst:auth:stateResponse', state);
    },

    // Send auth state update to main process (when state changes)
    sendStateUpdate: (state: SubscriptionAuthState) => {
      ipcRenderer.send('nc-catalyst:auth:stateUpdate', state);
    },

    // Listen for login requests from NestWatcher
    onLoginRequest: (listener: (req: { email: string; password: string }) => void) => {
      const channel = 'nc-catalyst:auth:loginRequest';
      const handler = (_event: Electron.IpcRendererEvent, req: { email: string; password: string }) => listener(req);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },

    // Send login response back to NestWatcher
    sendLoginResponse: (response: { success: boolean; state?: SubscriptionAuthState; error?: string }) => {
      ipcRenderer.send('nc-catalyst:auth:loginResponse', response);
    },

    // Listen for logout requests from NestWatcher
    onLogoutRequest: (listener: () => void) => {
      const channel = 'nc-catalyst:auth:logoutRequest';
      const handler = () => listener();
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },

    // Send logout response back to NestWatcher
    sendLogoutResponse: () => {
      ipcRenderer.send('nc-catalyst:auth:logoutResponse');
    }
  }
};

// Expose under both names for compatibility
contextBridge.exposeInMainWorld('nestWatcherBridge', ncCatApi);

// NC-Cat expects window.api.ncCatalyst for backward compatibility
contextBridge.exposeInMainWorld('api', {
  ncCatalyst: ncCatApi
});

console.log('[NC-Cat Preload] Minimal NC-Cat preload loaded - window.nestWatcherBridge and window.api.ncCatalyst exposed');
