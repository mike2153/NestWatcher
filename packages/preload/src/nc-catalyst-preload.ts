/**
 * Minimal preload script for NC-Cat window.
 * NC-Cat should NOT have access to NestWatcher's window.api methods.
 * It only needs IPC for communicating auth state and validation data.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type {
  SharedSettingsSnapshot,
  NcCatSubmitValidationReq,
  NcCatSubmitValidationRes,
  SubscriptionAuthState
} from '../../shared/src';
import { type ResultEnvelope } from '../../shared/src/result';

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

  // Listen for jobs being opened in NC-Cat
  onOpenJobs: (listener: (payload: any) => void) => {
    const channel = 'nc-catalyst:open-jobs';
    const handler = (_event: Electron.IpcRendererEvent, payload: any) => listener(payload);
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
