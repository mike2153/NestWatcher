import { eq } from 'drizzle-orm';
import { ncCatProfiles, machines } from '../db/schema';
import { withDb } from './db';
import { logger } from '../logger';
import { getActiveNcCatWindow, startNcCatBackgroundWindow } from '../ipc/hypernest';
import { isNcCatAvailable, requestHeadlessValidation } from './ncCatValidation';
import type {
  NcCatHeadlessValidationFileInput,
  NcCatHeadlessValidationFileResult,
  NcCatHeadlessValidationReason
} from '../../../shared/src';

const RETRY_BASE_DELAY_MS = 2000;
const RETRY_MAX_ATTEMPTS = 3;

type NcCatProfileSelection = {
  profileId: string;
  profileName: string;
  profileSettings: unknown;
};

async function getProfileById(profileId: string): Promise<NcCatProfileSelection | null> {
  const rows = await withDb((db) =>
    db
      .select({ id: ncCatProfiles.id, name: ncCatProfiles.name, settings: ncCatProfiles.settings })
      .from(ncCatProfiles)
      .where(eq(ncCatProfiles.id, profileId))
      .limit(1)
  );
  const row = rows[0];
  if (!row) return null;
  return { profileId: row.id, profileName: row.name, profileSettings: row.settings };
}

async function getActiveProfile(): Promise<NcCatProfileSelection | null> {
  const rows = await withDb((db) =>
    db
      .select({ id: ncCatProfiles.id, name: ncCatProfiles.name, settings: ncCatProfiles.settings })
      .from(ncCatProfiles)
      .where(eq(ncCatProfiles.isActive, true))
      .limit(1)
  );
  const row = rows[0];
  if (!row) return null;
  return { profileId: row.id, profileName: row.name, profileSettings: row.settings };
}

async function hasAnyProfiles(): Promise<boolean> {
  const rows = await withDb((db) => db.select({ id: ncCatProfiles.id }).from(ncCatProfiles).limit(1));
  return rows.length > 0;
}

async function resolveProfileForMachineId(machineId?: number | null): Promise<NcCatProfileSelection | null> {
  if (machineId == null) return null;
  const rows = await withDb((db) =>
    db
      .select({ profileId: machines.ncCatProfileId })
      .from(machines)
      .where(eq(machines.machineId, machineId))
      .limit(1)
  );
  const profileId = rows[0]?.profileId ?? null;
  if (!profileId) return null;
  return getProfileById(profileId);
}

async function resolveProfileForMachineName(machineNameHint?: string | null): Promise<NcCatProfileSelection | null> {
  if (!machineNameHint) return null;
  const rows = await withDb((db) =>
    db
      .select({ name: machines.name, profileId: machines.ncCatProfileId })
      .from(machines)
  );
  const match = rows.find((row) => row.name.toLowerCase() == machineNameHint.toLowerCase());
  const profileId = match?.profileId ?? null;
  if (!profileId) return null;
  return getProfileById(profileId);
}

export type HeadlessValidationOutcome =
  | {
      ok: true;
      results: NcCatHeadlessValidationFileResult[];
      profileId: string | null;
      profileName: string | null;
    }
  | {
      ok: false;
      skipped: true;
      reason: string;
    }
  | {
      ok: false;
      error: string;
    };

export async function runHeadlessValidationWithRetry(params: {
  reason: NcCatHeadlessValidationReason;
  folderName: string;
  files: NcCatHeadlessValidationFileInput[];
  machineId?: number | null;
  machineNameHint?: string | null;
}): Promise<HeadlessValidationOutcome> {
  if (!params.files.length) {
    return { ok: false, error: 'No NC files provided for validation' };
  }

  let profile = await resolveProfileForMachineId(params.machineId ?? null);
  if (!profile) {
    profile = await resolveProfileForMachineName(params.machineNameHint ?? null);
  }
  if (!profile) {
    profile = await getActiveProfile();
  }

  if (!profile) {
    const hasProfiles = await hasAnyProfiles();
    return {
      ok: false,
      skipped: true,
      reason: hasProfiles ? 'No active NC-Cat profile set' : 'No machine profiles found'
    };
  }

  const requestBase = {
    reason: params.reason,
    folderName: params.folderName,
    files: params.files,
    profileId: profile.profileId,
    profileName: profile.profileName,
    profileSettings: profile.profileSettings,
    machineNameHint: params.machineNameHint ?? null
  } as const;

  let lastError = 'NC Cat validation failed';

  for (let attempt = 0; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
    startNcCatBackgroundWindow();
    const ncCatWindow = getActiveNcCatWindow();

    if (!isNcCatAvailable(ncCatWindow)) {
      lastError = 'NC Cat background window not available';
    } else {
      const response = await requestHeadlessValidation(ncCatWindow, requestBase);
      if (response.success && response.results) {
        return {
          ok: true,
          results: response.results,
          profileId: response.profileId ?? profile.profileId,
          profileName: response.profileName ?? profile.profileName
        };
      }
      lastError = response.error ?? 'NC Cat validation failed';
    }

    if (attempt < RETRY_MAX_ATTEMPTS) {
      const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      logger.warn({ attempt, delayMs, error: lastError }, 'NC Cat validation retry scheduled');
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return { ok: false, error: lastError };
}