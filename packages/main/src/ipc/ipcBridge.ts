import { ipcMain as electronIpcMain } from 'electron';

type IpcMainLike = typeof electronIpcMain;

let currentIpcMain: IpcMainLike = electronIpcMain;

export function getIpcMain(): IpcMainLike {
  return currentIpcMain;
}

export function __setIpcMain(mock: IpcMainLike) {
  currentIpcMain = mock;
}
