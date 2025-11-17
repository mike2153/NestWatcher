-- Migration: Remove machine PC socket settings
-- Date: 2025-11-07
-- Description: The CNC telemetry collector now writes directly to Postgres, so the Electron app no longer stores PC IP/port values.

ALTER TABLE public.machines
  DROP CONSTRAINT IF EXISTS machines_pc_port_check;

DROP INDEX IF EXISTS machines_pc_ip_idx;

ALTER TABLE public.machines
  DROP COLUMN IF EXISTS pc_ip;

ALTER TABLE public.machines
  DROP COLUMN IF EXISTS pc_port;
