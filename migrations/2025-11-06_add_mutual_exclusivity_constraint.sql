-- Migration: Add constraint to enforce mutual exclusivity between pre_reserved and is_locked
-- Date: 2025-11-06
-- Description: A job cannot be both pre-reserved and locked at the same time

-- Add constraint to jobs table
ALTER TABLE public.jobs
ADD CONSTRAINT jobs_pre_reserved_locked_exclusivity_chk
CHECK (NOT (pre_reserved = true AND is_locked = true));

-- Update any existing rows that violate this constraint (if any)
-- Priority: is_locked takes precedence over pre_reserved
UPDATE public.jobs
SET pre_reserved = false
WHERE pre_reserved = true AND is_locked = true;
