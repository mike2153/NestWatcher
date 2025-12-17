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
 * Get CPU ID on Windows using WMIC
 */
async function getCpuId(): Promise<string> {
  try {
    const { stdout } = await execAsync('wmic cpu get ProcessorId /format:value', {
      timeout: 10000,
      windowsHide: true,
    });
    const match = stdout.match(/ProcessorId=([A-F0-9]+)/i);
    if (match && match[1]) {
      return match[1].trim();
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to get CPU ID via WMIC');
  }

  // Fallback: Try PowerShell
  try {
    const { stdout } = await execAsync(
      'powershell -Command "(Get-CimInstance Win32_Processor).ProcessorId"',
      { timeout: 10000, windowsHide: true }
    );
    const id = stdout.trim();
    if (id && id.length > 0) {
      return id;
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to get CPU ID via PowerShell');
  }

  return 'UNKNOWN_CPU';
}

/**
 * Get motherboard serial number on Windows using WMIC
 */
async function getMotherboardSerial(): Promise<string> {
  try {
    const { stdout } = await execAsync('wmic baseboard get SerialNumber /format:value', {
      timeout: 10000,
      windowsHide: true,
    });
    const match = stdout.match(/SerialNumber=(.+)/i);
    if (match && match[1]) {
      const serial = match[1].trim();
      // Some motherboards return "To be filled by O.E.M." or similar
      if (serial && !serial.toLowerCase().includes('to be filled') && serial !== 'Default string') {
        return serial;
      }
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to get motherboard serial via WMIC');
  }

  // Fallback: Try getting BIOS serial instead
  try {
    const { stdout } = await execAsync('wmic bios get SerialNumber /format:value', {
      timeout: 10000,
      windowsHide: true,
    });
    const match = stdout.match(/SerialNumber=(.+)/i);
    if (match && match[1]) {
      const serial = match[1].trim();
      if (serial && !serial.toLowerCase().includes('to be filled') && serial !== 'Default string') {
        return serial;
      }
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to get BIOS serial via WMIC');
  }

  // Fallback: Try PowerShell for baseboard
  try {
    const { stdout } = await execAsync(
      'powershell -Command "(Get-CimInstance Win32_BaseBoard).SerialNumber"',
      { timeout: 10000, windowsHide: true }
    );
    const serial = stdout.trim();
    if (serial && !serial.toLowerCase().includes('to be filled') && serial !== 'Default string') {
      return serial;
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to get motherboard serial via PowerShell');
  }

  // Last resort: Use motherboard manufacturer + product
  try {
    const { stdout } = await execAsync(
      'wmic baseboard get Manufacturer,Product /format:value',
      { timeout: 10000, windowsHide: true }
    );
    const mfgMatch = stdout.match(/Manufacturer=(.+)/i);
    const prodMatch = stdout.match(/Product=(.+)/i);
    if (mfgMatch && prodMatch) {
      return `${mfgMatch[1].trim()}_${prodMatch[1].trim()}`;
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to get motherboard info via WMIC');
  }

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

    logger.debug({ cpuId: cpuId.substring(0, 8) + '...', motherboardSerial: motherboardSerial.substring(0, 8) + '...' }, 'Hardware identifiers collected');

    cachedHardwareId = hashHardwareIds(cpuId, motherboardSerial);

    logger.info({ hardwareIdPrefix: cachedHardwareId.substring(0, 16) + '...' }, 'Hardware ID generated');

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
