import { withClient } from './db';
import { logger } from '../logger';

// Minimal runtime schema patches.
//
// This repo does not currently run formal migrations automatically.
// We apply small additive patches at startup so older databases do not break
// when new columns are introduced.

export async function applyDbPatches(): Promise<void> {
  await ensureJobsManualLifecycleColumn();
}

async function ensureJobsManualLifecycleColumn(): Promise<void> {
  try {
    await withClient(async (c) => {
      await c.query(`ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS manual_lifecycle jsonb`);
    });
  } catch (err) {
    logger.warn({ err }, 'dbPatches: failed to ensure jobs.manual_lifecycle column');
  }
}
