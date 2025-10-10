-- Migration: add pre_reserved and rename is_reserved -> is_locked
-- Safe to run multiple times (IF NOT EXISTS where possible)

BEGIN;

-- 1) Add new pre_reserved flag
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS pre_reserved boolean NOT NULL DEFAULT false;

-- 2) Rename existing is_reserved -> is_locked (if not already renamed)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'is_reserved'
  ) THEN
    ALTER TABLE public.jobs RENAME COLUMN is_reserved TO is_locked;
  END IF;
END$$;

-- 3) Update dependent views (drop and recreate with new column name)
-- jobs_history
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname = 'jobs_history') THEN
    DROP VIEW public.jobs_history;
  END IF;
END$$;

CREATE VIEW public.jobs_history AS
SELECT
  key,
  folder,
  ncfile,
  material,
  parts,
  size,
  thickness,
  pre_reserved,
  is_locked,
  status,
  machine_id,
  dateadded,
  staged_at,
  cut_at,
  nestpick_completed_at,
  updated_at,
  pallet,
  last_error
FROM public.jobs
WHERE status = 'NESTPICK_COMPLETE'::public.job_status;

-- jobs_pending
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname = 'jobs_pending') THEN
    DROP VIEW public.jobs_pending;
  END IF;
END$$;

CREATE VIEW public.jobs_pending AS
SELECT
  key,
  folder,
  ncfile,
  material,
  parts,
  size,
  thickness,
  pre_reserved,
  is_locked,
  status,
  machine_id,
  dateadded,
  staged_at,
  cut_at,
  nestpick_completed_at,
  updated_at,
  pallet,
  last_error
FROM public.jobs
WHERE status = 'PENDING'::public.job_status;

-- machine_jobs
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname = 'machine_jobs') THEN
    DROP VIEW public.machine_jobs;
  END IF;
END$$;

CREATE VIEW public.machine_jobs AS
SELECT
  key,
  folder,
  ncfile,
  material,
  parts,
  size,
  thickness,
  pre_reserved,
  is_locked,
  status,
  machine_id,
  dateadded,
  staged_at,
  cut_at,
  nestpick_completed_at,
  updated_at,
  pallet,
  last_error
FROM public.jobs
WHERE status IN ('STAGED'::public.job_status, 'CNC_FINISH'::public.job_status, 'FORWARDED_TO_NESTPICK'::public.job_status);

-- 4) Enforce: pre_reserved only when status = 'PENDING'
-- Clean up any violations before adding the constraint
UPDATE public.jobs SET pre_reserved = FALSE WHERE status <> 'PENDING'::public.job_status AND pre_reserved = TRUE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'jobs_pre_reserved_pending_chk' AND conrelid = 'public.jobs'::regclass
  ) THEN
    ALTER TABLE public.jobs
      ADD CONSTRAINT jobs_pre_reserved_pending_chk
      CHECK (pre_reserved = FALSE OR status = 'PENDING'::public.job_status);
  END IF;
END$$;

COMMIT;
