BEGIN;

-- Add qty column to jobs for cut count
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS qty integer NOT NULL DEFAULT 0;

COMMIT;

