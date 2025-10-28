import type { MachineHealthCode } from '../../../shared/src';

export type SerializableError = {
  message: string;
  stack?: string | null;
};

export type WatcherWorkerToMainMessage =
  | { type: 'registerWatcher'; name: string; label: string }
  | { type: 'watcherReady'; name: string; label?: string }
  | {
      type: 'log';
      level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
      msg: string;
      context?: Record<string, unknown>;
    }
  | {
      type: 'watcherEvent';
      name: string;
      label?: string;
      message: string;
      context?: Record<string, unknown>;
    }
  | {
      type: 'userAlert';
      title: string;
      message: string;
    }
  | {
      type: 'watcherError';
      name: string;
      label?: string;
      error: SerializableError;
      context?: Record<string, unknown>;
    }
  | {
      type: 'workerError';
      source: string;
      error: SerializableError;
      context?: Record<string, unknown>;
    }
  | {
      type: 'machineHealthSet';
      payload: {
        machineId: number | null;
        code: MachineHealthCode;
        message: string;
        severity?: 'info' | 'warning' | 'critical';
        context?: Record<string, unknown>;
      };
    }
  | {
      type: 'machineHealthClear';
      payload: {
        machineId: number | null;
        code: MachineHealthCode;
      };
    }
  | {
      type: 'dbNotify';
      channel: 'grundner' | 'allocated-material';
    }
  | {
      type: 'appAlert';
      category: 'grundner' | 'app';
      summary: string;
      details?: Record<string, unknown>;
    }
  | {
      type: 'appMessage';
      payload: {
        title: string;
        body: string;
        timestamp: string;
        source?: string;
      };
    };

export type MainToWatcherMessage = { type: 'shutdown'; reason?: string };
