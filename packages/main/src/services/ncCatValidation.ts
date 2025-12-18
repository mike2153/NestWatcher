import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';
import { logger } from '../logger';

/**
 * Validation status for an NC file
 */
export type ValidationStatus = 'pass' | 'warnings' | 'errors';

/**
 * Validation result from NC Cat
 */
export interface NcCatValidationResult {
  status: ValidationStatus;
  warnings: string[];
  errors: string[];
  syntax: string[];
}

/**
 * Full validation response including MES data
 */
export interface NcCatValidationResponse {
  success: boolean;
  validation?: NcCatValidationResult;
  mesData?: {
    ncEstRuntime: number;
    yieldPercentage: number;
    usableOffcuts: Array<{ x: number; y: number; z: number }>;
    wasteOffcutM2: number;
    wasteOffcutDustM3: number;
    TotalToolDustM3: number;
    TotalDrillDustM3: number;
    SheetTotalDustM3: number;
    toolUsage: Array<{
      toolNumber: string;
      toolName: string;
      cuttingDistanceMeters: number;
      toolDustM3: number;
    }>;
    drillUsage: Array<{
      drillNumber: string;
      drillName: string;
      holeCount: number;
      drillDistanceMeters: number;
      drillDustM3: number;
    }>;
  };
  error?: string;
}

/**
 * Request structure for NC Cat validation
 */
export interface NcCatValidationRequest {
  /** Path to the NC file (for reference) */
  ncFilePath: string;
  /** Folder name (job folder) */
  folderName: string;
  /** Raw NC file content */
  ncContent: string;
  /** Machine profile ID to use for validation (optional) */
  profileId?: string | null;
}

const VALIDATION_TIMEOUT_MS = 60000; // 60 seconds timeout for validation

/**
 * Request NC Cat to validate an NC file (headless).
 * Uses IPC to communicate with the NC Cat background window.
 *
 * @param ncCatWindow - The NC Cat BrowserWindow instance
 * @param request - Validation request with NC file content
 * @returns Promise resolving to validation response
 */
export async function validateNcFile(
  ncCatWindow: BrowserWindow | null,
  request: NcCatValidationRequest
): Promise<NcCatValidationResponse> {
  if (!ncCatWindow || ncCatWindow.isDestroyed()) {
    logger.warn('NC Cat background window not available for validation');
    return {
      success: false,
      error: 'NC Cat background window not available'
    };
  }

  const requestId = `validation-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      ipcMain.removeListener('nc-catalyst:validation:response', handler);
      logger.warn(
        { requestId, ncFilePath: request.ncFilePath },
        'NC Cat validation request timed out'
      );
      resolve({
        success: false,
        error: `Validation request timed out after ${VALIDATION_TIMEOUT_MS / 1000} seconds`
      });
    }, VALIDATION_TIMEOUT_MS);

    const handler = (
      _event: Electron.IpcMainEvent,
      response: NcCatValidationResponse & { requestId?: string }
    ) => {
      // Only handle responses matching our request ID
      if (response.requestId !== requestId) return;

      clearTimeout(timeoutId);
      ipcMain.removeListener('nc-catalyst:validation:response', handler);

      logger.info(
        {
          requestId,
          ncFilePath: request.ncFilePath,
          success: response.success,
          status: response.validation?.status
        },
        'NC Cat validation response received'
      );

      resolve(response);
    };

    ipcMain.on('nc-catalyst:validation:response', handler);

    logger.info(
      { requestId, ncFilePath: request.ncFilePath, folderName: request.folderName },
      'Sending NC Cat validation request'
    );

    // Send validation request to NC Cat window
    ncCatWindow.webContents.send('nc-catalyst:validation:request', {
      ...request,
      requestId
    });
  });
}

/**
 * Check if an NC Cat window is available for validation
 */
export function isNcCatAvailable(ncCatWindow: BrowserWindow | null): boolean {
  return ncCatWindow !== null && !ncCatWindow.isDestroyed();
}
