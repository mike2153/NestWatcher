ALTER TABLE public.jobs
  ADD COLUMN locked_by text,
  ADD COLUMN staged_by text;
