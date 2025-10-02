SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

CREATE SCHEMA IF NOT EXISTS public;
ALTER SCHEMA public OWNER TO pg_database_owner;
COMMENT ON SCHEMA public IS 'standard public schema';

CREATE TYPE public.job_status AS ENUM (
    'PENDING',
    'STAGED',
    'LOAD_FINISH',
    'LABEL_FINISH',
    'CNC_FINISH',
    'FORWARDED_TO_NESTPICK',
    'NESTPICK_COMPLETE'
);

ALTER TYPE public.job_status OWNER TO postgres;

-- Removed duplicate enum job_status_new

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END$$;

ALTER FUNCTION public.set_updated_at() OWNER TO postgres;
SET default_tablespace = '';
SET default_table_access_method = heap;

CREATE TABLE public.cncstats (
    key character varying(100) NOT NULL,
    api_ip character varying(100),
    currentprogram character varying(50),
    mode character varying(50),
    status character varying(50),
    alarm character varying(50),
    emg character varying(50),
    powerontime character varying(50),
    cuttingtime character varying(50),
    alarmhistory character varying(50),
    vacuumtime character varying(50),
    drillheadtime character varying(50),
    spindletime character varying(50),
    conveyortime character varying(50),
    greasetime character varying(50)
);

ALTER TABLE public.cncstats OWNER TO woodtron_user;

CREATE TABLE public.grundner (
    id integer NOT NULL,
    type_data integer NOT NULL,
    customer_id character varying(50),
    length_mm integer,
    width_mm integer,
    thickness_mm integer,
    stock integer,
    stock_available integer,
    last_updated character varying(50),
    reserved_stock integer DEFAULT 0
);

ALTER TABLE public.grundner OWNER TO woodtron_user;

CREATE SEQUENCE public.grundner_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.grundner_id_seq OWNER TO woodtron_user;
ALTER SEQUENCE public.grundner_id_seq OWNED BY public.grundner.id;

CREATE TABLE public.job_events (
    event_id bigint NOT NULL,
    key character varying(100) NOT NULL,
    machine_id integer,
    event_type text NOT NULL,
    payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.job_events OWNER TO postgres;
COMMENT ON TABLE public.job_events IS 'Append-only audit trail of lifecycle/file events (multi-PC safe)';

CREATE SEQUENCE public.job_events_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.job_events_event_id_seq OWNER TO postgres;
ALTER SEQUENCE public.job_events_event_id_seq OWNED BY public.job_events.event_id;

CREATE TABLE public.jobs (
    key character varying(100) NOT NULL,
    folder character varying(255),
    ncfile character varying(255),
    material character varying(255),
    parts character varying(255),
    size character varying(255),
    thickness character varying(255),
    is_reserved boolean DEFAULT false,
    machine_id integer,
    dateadded timestamp with time zone,
    staged_at timestamp with time zone,
    cut_at timestamp with time zone,
    nestpick_completed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    pallet character varying(50),
    last_error text,
    status public.job_status DEFAULT 'PENDING'::public.job_status,
    CONSTRAINT jobs_key_not_blank CHECK ((length(btrim((key)::text)) > 0))
);

ALTER TABLE public.jobs OWNER TO postgres;

COMMENT ON TABLE public.jobs IS 'Canonical job lifecycle row (single source of truth; use status + timestamps)';

CREATE VIEW public.jobs_history AS
 SELECT key,
    folder,
    ncfile,
    material,
    parts,
    size,
    thickness,
    is_reserved,
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
  WHERE (status = 'NESTPICK_COMPLETE'::public.job_status);

ALTER VIEW public.jobs_history OWNER TO postgres;

CREATE VIEW public.jobs_pending AS
 SELECT key,
    folder,
    ncfile,
    material,
    parts,
    size,
    thickness,
    is_reserved,
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
  WHERE (status = 'PENDING'::public.job_status);

ALTER VIEW public.jobs_pending OWNER TO postgres;

CREATE VIEW public.machine_jobs AS
 SELECT key,
    folder,
    ncfile,
    material,
    parts,
    size,
    thickness,
    is_reserved,
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
  WHERE (status = ANY (ARRAY['STAGED'::public.job_status, 'CNC_FINISH'::public.job_status, 'FORWARDED_TO_NESTPICK'::public.job_status]));

ALTER VIEW public.machine_jobs OWNER TO postgres;

CREATE TABLE public.machines (
    machine_id integer NOT NULL,
    name text NOT NULL,
    pc_ip inet,
    cnc_ip inet,
    cnc_port integer,
    ap_jobfolder text NOT NULL,
    nestpick_folder text NOT NULL,
    nestpick_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    pc_port integer DEFAULT 5000 NOT NULL,
    CONSTRAINT machines_cnc_port_check CHECK (((cnc_port >= 1) AND (cnc_port <= 65535))),
    CONSTRAINT machines_pc_port_check CHECK (((pc_port >= 1) AND (pc_port <= 65535)))
);

ALTER TABLE public.machines OWNER TO postgres;
COMMENT ON TABLE public.machines IS 'Per-CNC config: PC/CNC IPs, AutoPac/Nestpick folders, flags';
COMMENT ON COLUMN public.machines.ap_jobfolder IS 'Ready-To-Run / AutoPac intake (per machine)';
COMMENT ON COLUMN public.machines.nestpick_folder IS 'Where pallet-tagged CSVs are moved for Nestpick ingestion';
CREATE SEQUENCE public.machines_machine_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.machines_machine_id_seq OWNER TO postgres;
ALTER SEQUENCE public.machines_machine_id_seq OWNED BY public.machines.machine_id;
ALTER TABLE ONLY public.grundner ALTER COLUMN id SET DEFAULT nextval('public.grundner_id_seq'::regclass);
ALTER TABLE ONLY public.job_events ALTER COLUMN event_id SET DEFAULT nextval('public.job_events_event_id_seq'::regclass);
ALTER TABLE ONLY public.machines ALTER COLUMN machine_id SET DEFAULT nextval('public.machines_machine_id_seq'::regclass);
ALTER TABLE ONLY public.cncstats
    ADD CONSTRAINT cncstats_pkey PRIMARY KEY (key);
ALTER TABLE ONLY public.grundner
    ADD CONSTRAINT grundner_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.grundner
    ADD CONSTRAINT grundner_type_data_customer_id_key UNIQUE (type_data, customer_id);
ALTER TABLE ONLY public.job_events
    ADD CONSTRAINT job_events_pkey PRIMARY KEY (event_id);
ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.machines
    ADD CONSTRAINT machines_pkey PRIMARY KEY (machine_id);
CREATE INDEX job_events_created_idx ON public.job_events USING btree (created_at);
CREATE INDEX job_events_key_idx ON public.job_events USING btree (key);
CREATE INDEX job_events_machine_idx ON public.job_events USING btree (machine_id);
CREATE INDEX job_events_type_idx ON public.job_events USING btree (event_type);
CREATE INDEX jobs_dates_idx ON public.jobs USING btree (dateadded, staged_at, cut_at, nestpick_completed_at);
CREATE INDEX machines_cnc_ip_idx ON public.machines USING btree (cnc_ip);
CREATE INDEX machines_name_idx ON public.machines USING btree (name);
CREATE INDEX machines_pc_ip_idx ON public.machines USING btree (pc_ip);
CREATE TRIGGER trg_jobs_updated BEFORE UPDATE ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_machines_updated BEFORE UPDATE ON public.machines FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE ONLY public.job_events
    ADD CONSTRAINT job_events_key_fkey FOREIGN KEY (key) REFERENCES public.jobs(key) ON DELETE CASCADE;
ALTER TABLE ONLY public.job_events
    ADD CONSTRAINT job_events_machine_id_fkey FOREIGN KEY (machine_id) REFERENCES public.machines(machine_id) ON DELETE SET NULL;
ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_machine_id_fkey FOREIGN KEY (machine_id) REFERENCES public.machines(machine_id) ON DELETE SET NULL;
