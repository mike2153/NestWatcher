-- Migration: Remove CNC port column
-- Date: 2025-11-08
-- Description: CNC telemetry now writes directly to Postgres, so the per-machine TCP port is unused.

ALTER TABLE public.machines
  DROP CONSTRAINT IF EXISTS machines_cnc_port_check;

ALTER TABLE public.machines
  DROP COLUMN IF EXISTS cnc_port;
