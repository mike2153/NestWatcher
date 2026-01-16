import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';
import { logger } from '../logger';
import type { NcCatHeadlessValidateRequest, NcCatHeadlessValidateResponse } from '../../../shared/src';

const VALIDATION_TIMEOUT_MS = 60000;

export async function requestHeadlessValidation(
  ncCatWindow: BrowserWindow | null,
  request: Omit<NcCatHeadlessValidateRequest, 'requestId'>
): Promise<NcCatHeadlessValidateResponse> {
  const requestId = `nccat-validation-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  if (!ncCatWindow || ncCatWindow.isDestroyed()) {
    logger.warn('NC Cat background window not available for validation');
    return {
      requestId,
      success: false,
      error: 'NC Cat background window not available'
    };
  }

  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      ipcMain.removeListener('nc-catalyst:validation:response', handler);
      logger.warn(
        { requestId, folderName: request.folderName },
        'NC Cat validation request timed out'
      );
      resolve({
        requestId,
        success: false,
        error: `Validation request timed out after ${VALIDATION_TIMEOUT_MS / 1000} seconds`
      });
    }, VALIDATION_TIMEOUT_MS);

    const handler = (
      _event: Electron.IpcMainEvent,
      response: NcCatHeadlessValidateResponse
    ) => {
      if (response.requestId !== requestId) return;

      clearTimeout(timeoutId);
      ipcMain.removeListener('nc-catalyst:validation:response', handler);

      logger.info(
        {
          requestId,
          folderName: request.folderName,
          success: response.success,
          fileCount: response.results?.length ?? 0
        },
        'NC Cat validation response received'
      );

      resolve(response);
    };

    ipcMain.on('nc-catalyst:validation:response', handler);

    logger.info(
      { requestId, folderName: request.folderName, fileCount: request.files.length },
      'Sending NC Cat headless validation request'
    );

    ncCatWindow.webContents.send('nc-catalyst:validation:request', {
      ...request,
      requestId
    });
  });
}

export function isNcCatAvailable(ncCatWindow: BrowserWindow | null): boolean {
  return ncCatWindow !== null && !ncCatWindow.isDestroyed();
}