import { EventEmitter } from 'events';

const emitter = new EventEmitter();

export function emitReadyRefresh(machineId: number): void {
  emitter.emit('ready-refresh', machineId);
}

export function subscribeReadyRefresh(listener: (machineId: number) => void): () => void {
  emitter.on('ready-refresh', listener);
  return () => {
    emitter.off('ready-refresh', listener);
  };
}
