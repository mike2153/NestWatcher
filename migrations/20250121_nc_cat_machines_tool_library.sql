-- NC-Cat integration for machines + global tool library
-- Run this AFTER your existing schema (functions like public.set_updated_at() already exist).

BEGIN;

-- 1) Extend machines table with NC-Cat integration columns
ALTER TABLE public.machines
  ADD COLUMN IF NOT EXISTS nc_cat_machine_id text UNIQUE,
  ADD COLUMN IF NOT EXISTS nc_cat_config jsonb,
  ADD COLUMN IF NOT EXISTS settings_version text,
  ADD COLUMN IF NOT EXISTS last_settings_sync_at timestamptz;

COMMENT ON COLUMN public.machines.nc_cat_machine_id IS
  'Stable NC-Cat MachineConfig.id used to map NC-Cat snapshots to this machine';

COMMENT ON COLUMN public.machines.nc_cat_config IS
  'Latest NC-Cat MachineConfig blob (machineParams, drill head, tool changers, strategies, etc.)';

COMMENT ON COLUMN public.machines.settings_version IS
  'Optional NC-Cat settings version string for this machine (from settings.json / snapshot)';

COMMENT ON COLUMN public.machines.last_settings_sync_at IS
  'Timestamp when WE last applied an NC-Cat MachineConfig snapshot to this machine';


-- 2) Global tool library table (shared across all machines)

CREATE TABLE IF NOT EXISTS public.tool_library (
  id            text PRIMARY KEY,        -- matches NC-Cat ToolLibraryTool.id
  name          text NOT NULL,
  type          text NOT NULL,           -- e.g. 'end-mill'
  diameter_mm   numeric NOT NULL,
  length_mm     numeric NOT NULL,

  material_type text,                    -- optional default material
  notes         text,

  created_at    timestamptz DEFAULT now() NOT NULL,
  updated_at    timestamptz DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.tool_library IS
  'Global catalogue of tools (geometry and identity) shared across machines and NC-Cat';

COMMENT ON COLUMN public.tool_library.id IS
  'NC-Cat ToolLibraryTool.id used in settings.json and NcCatSettingsSnapshot';


-- 3) Indexes for tool_library

CREATE INDEX IF NOT EXISTS tool_library_name_idx
  ON public.tool_library USING btree (name);

CREATE INDEX IF NOT EXISTS tool_library_type_idx
  ON public.tool_library USING btree (type);


-- 4) Trigger to keep tool_library.updated_at in sync
-- Assumes public.set_updated_at() already exists from your base schema.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_tool_library_updated'
      AND tgrelid = 'public.tool_library'::regclass
  ) THEN
    CREATE TRIGGER trg_tool_library_updated
    BEFORE UPDATE ON public.tool_library
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END;
$$;

COMMIT;
