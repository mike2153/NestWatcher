/**
 * Hardware ID generation service for NestWatcher (Node.js/Electron).
 *
 * Generates a unique hardware ID by hashing CPU and motherboard information.
 * This ID is used for machine licensing to prevent sharing licenses across PCs.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { logger } from '../logger';

const execAsync = promisify(exec);

// Cache the hardware ID since it won't change during runtime
let cachedHardwareId: string | null = null;

/**
 * Get CPU ID on Windows using PowerShell
 */
async function getCpuId(): Promise<string> {
  try {
    const { stdout } = await execAsync(
      'powershell -Command "(Get-CimInstance Win32_Processor).ProcessorId"',
      { timeout: 10000, windowsHide: true }
    );
    const id = stdout.trim();
    if (id && id.length > 0) {
      logger.info({ cpuId: id }, 'CPU ID collected via PowerShell');
      return id;
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to get CPU ID via PowerShell');
  }

  logger.warn('CPU ID unavailable; using UNKNOWN_CPU');
  return 'UNKNOWN_CPU';
}

/**
 * Get motherboard serial number on Windows using PowerShell
 */
async function getMotherboardSerial(): Promise<string> {
  try {
    const { stdout } = await execAsync(
      'powershell -Command "(Get-CimInstance Win32_BaseBoard).SerialNumber"',
      { timeout: 10000, windowsHide: true }
    );
    const serial = stdout.trim();
    if (serial && !serial.toLowerCase().includes('to be filled') && serial !== 'Default string') {
      logger.info({ motherboardSerial: serial }, 'Motherboard serial collected via PowerShell');
      return serial;
    }
    if (serial) {
      logger.warn({ motherboardSerial: serial }, 'Motherboard serial from PowerShell is not usable');
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to get motherboard serial via PowerShell');
  }

  // Fallback: Try getting BIOS serial instead
  try {
    const { stdout } = await execAsync(
      'powershell -Command "(Get-CimInstance Win32_BIOS).SerialNumber"',
      { timeout: 10000, windowsHide: true }
    );
    const serial = stdout.trim();
    if (serial && !serial.toLowerCase().includes('to be filled') && serial !== 'Default string') {
      logger.info({ biosSerial: serial }, 'BIOS serial collected via PowerShell');
      return serial;
    }
    if (serial) {
      logger.warn({ biosSerial: serial }, 'BIOS serial from PowerShell is not usable');
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to get BIOS serial via PowerShell');
  }

  // Last resort: Use motherboard manufacturer + product
  try {
    const { stdout } = await execAsync(
      'powershell -Command "(Get-CimInstance Win32_BaseBoard | Select-Object Manufacturer, Product | ConvertTo-Csv -NoTypeInformation)"',
      { timeout: 10000, windowsHide: true }
    );
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length >= 2) {
      const values = lines[1].split(',').map((value) => value.replace(/^\"|\"$/g, '').trim());
      const manufacturer = values[0] || '';
      const product = values[1] || '';
      if (manufacturer || product) {
        const fallbackSerial = `${manufacturer}_${product}`.replace(/_+$/, '');
        logger.info(
          { motherboardSerial: fallbackSerial },
          'Motherboard serial fallback collected via PowerShell (Manufacturer + Product)'
        );
        return fallbackSerial;
      }
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to get motherboard info via PowerShell');
  }

  logger.warn('Motherboard serial unavailable; using UNKNOWN_MOTHERBOARD');
  return 'UNKNOWN_MOTHERBOARD';
}

/**
 * Generate a SHA-256 hash of the combined hardware identifiers
 */
function hashHardwareIds(cpuId: string, motherboardSerial: string): string {
  const combined = `${cpuId}:${motherboardSerial}`;
  const hash = createHash('sha256').update(combined).digest('hex');
  return hash;
}

/**
 * Get the hardware ID for this machine.
 * Returns a SHA-256 hash of the CPU ID and motherboard serial.
 *
 * The result is cached for the duration of the process since hardware doesn't change.
 */
export async function getHardwareId(): Promise<string> {
  if (cachedHardwareId) {
    return cachedHardwareId;
  }

  try {
    const [cpuId, motherboardSerial] = await Promise.all([
      getCpuId(),
      getMotherboardSerial(),
    ]);

    logger.info(
      { cpuId, motherboardSerial },
      'Hardware identifiers collected'
    );

    cachedHardwareId = hashHardwareIds(cpuId, motherboardSerial);

    logger.info({ hardwareId: cachedHardwareId }, 'Hardware ID generated');

    return cachedHardwareId;
  } catch (error) {
    logger.error({ error }, 'Failed to generate hardware ID');
    // Generate a fallback that's at least consistent for this session
    cachedHardwareId = `fallback-${createHash('sha256').update(Date.now().toString()).digest('hex')}`;
    return cachedHardwareId;
  }
}

/**
 * Clear the cached hardware ID (for testing purposes)
 */
export function clearHardwareIdCache(): void {
  cachedHardwareId = null;
}
