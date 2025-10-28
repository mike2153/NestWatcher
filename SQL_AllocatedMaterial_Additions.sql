-- Additional schema elements for allocated material tracking and notifications

-- Ensure Grundner pre_reserved column exists with default
ALTER TABLE public.grundner
  ADD COLUMN IF NOT EXISTS pre_reserved integer DEFAULT 0;

ALTER TABLE public.grundner
  ALTER COLUMN pre_reserved SET DEFAULT 0;

-- Ensure jobs has pre_reserved and is_locked flags (idempotent)
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS pre_reserved boolean DEFAULT false;

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS is_locked boolean DEFAULT false;

-- Track when a job was last allocated (pre_reserved or locked)
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS allocated_at timestamp with time zone;

-- Replace the allocated material view (drop first to avoid column rename issues)
DROP VIEW IF EXISTS public.allocated_material_view;

CREATE VIEW public.allocated_material_view AS
 SELECT
    g.id AS grundner_id,
    g.type_data,
    g.customer_id,
    g.length_mm,
    g.width_mm,
    g.thickness_mm,
    g.stock,
    g.stock_available,
    g.reserved_stock,
    COALESCE(g.pre_reserved, 0) AS pre_reserved,
    j.key AS job_key,
    COALESCE(
      NULLIF(TRIM(j.folder), ''),
      NULLIF(regexp_replace(j.key, '^.*/([^/]+)/[^/]+$', '\\1'), j.key)
    ) AS folder,
    j.ncfile,
    j.material,
    j.pre_reserved AS job_pre_reserved,
    j.is_locked AS job_is_locked,
    j.updated_at,
    j.allocated_at AS allocated_at,
    CASE WHEN j.is_locked THEN 'locked' ELSE 'pre_reserved' END AS allocation_status
 FROM public.jobs j
 JOIN public.grundner g
   ON (
     TRIM(COALESCE(j.material, '')) <> '' AND
     (
       (TRIM(j.material) ~ '^[0-9]+$' AND g.type_data = CAST(TRIM(j.material) AS INTEGER)) OR
       (NOT TRIM(j.material) ~ '^[0-9]+$' AND g.customer_id = TRIM(j.material))
     )
   )
 WHERE j.pre_reserved = TRUE OR j.is_locked = TRUE;

ALTER VIEW public.allocated_material_view OWNER TO woodtron_user;

-- Keep existing trigger function if present; just replace its body.
-- If an older overloaded signature existed, drop that variant safely.
DROP FUNCTION IF EXISTS public.notify_channel(text, text);

CREATE OR REPLACE FUNCTION public.notify_channel()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  channel text;
  payload text;
BEGIN
  channel := COALESCE(TG_ARGV[0], '');
  IF channel = '' THEN
    RAISE EXCEPTION 'notify_channel requires channel name as first trigger argument';
  END IF;
  payload := COALESCE(TG_ARGV[1], '');
  PERFORM pg_notify(channel, payload);
  RETURN NULL;
END;
$$;

-- Notify listeners when Grundner stock changes
DROP TRIGGER IF EXISTS trg_grundner_changed ON public.grundner;
CREATE TRIGGER trg_grundner_changed
AFTER INSERT OR UPDATE OR DELETE ON public.grundner
FOR EACH STATEMENT
EXECUTE FUNCTION public.notify_channel('grundner_changed', TG_TABLE_NAME);

-- Notify listeners when job allocations change
DROP TRIGGER IF EXISTS trg_allocated_material_jobs ON public.jobs;
CREATE TRIGGER trg_allocated_material_jobs
AFTER INSERT OR UPDATE OF pre_reserved, is_locked, material OR DELETE ON public.jobs
FOR EACH STATEMENT
EXECUTE FUNCTION public.notify_channel('allocated_material_changed', TG_TABLE_NAME);

ALTER FUNCTION public.notify_channel() OWNER TO woodtron_user;
