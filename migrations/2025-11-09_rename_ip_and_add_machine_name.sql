-- Migration: Rename IP columns and add machine_name to cncstats
-- Date: 2025-11-09

-- Machines: cnc_ip -> pc_ip
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'machines' AND column_name = 'cnc_ip'
  ) THEN
    ALTER TABLE public.machines RENAME COLUMN cnc_ip TO pc_ip;
  END IF;
END $$;

-- Try renaming the index if it exists; otherwise create the expected one.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'i' AND n.nspname = 'public' AND c.relname = 'machines_cnc_ip_idx'
  ) THEN
    ALTER INDEX public.machines_cnc_ip_idx RENAME TO machines_pc_ip_idx;
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'i' AND n.nspname = 'public' AND c.relname = 'machines_pc_ip_idx'
  ) THEN
    CREATE INDEX machines_pc_ip_idx ON public.machines USING btree (pc_ip);
  END IF;
END $$;

-- cncstats: api_ip -> pc_ip, add machine_name
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cncstats' AND column_name = 'api_ip'
  ) THEN
    ALTER TABLE public.cncstats RENAME COLUMN api_ip TO pc_ip;
  END IF;
END $$;

ALTER TABLE public.cncstats
  ADD COLUMN IF NOT EXISTS machine_name text;

