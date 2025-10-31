--
-- PostgreSQL database dump
--

-- Dumped from database version 17.5
-- Dumped by pg_dump version 17.5

-- Started on 2025-10-31 14:44:15

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

--
-- TOC entry 6 (class 2615 OID 2200)
-- Name: public; Type: SCHEMA; Schema: -; Owner: pg_database_owner
--

CREATE SCHEMA public;


ALTER SCHEMA public OWNER TO pg_database_owner;

--
-- TOC entry 5073 (class 0 OID 0)
-- Dependencies: 6
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: pg_database_owner
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- TOC entry 949 (class 1247 OID 25645)
-- Name: job_status; Type: TYPE; Schema: public; Owner: postgres
--

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

--
-- TOC entry 946 (class 1247 OID 25198)
-- Name: job_status_new; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.job_status_new AS ENUM (
    'PENDING',
    'STAGED',
    'LOAD_FINISH',
    'LABEL_FINISH',
    'CNC_FINISH',
    'FORWARDED_TO_NESTPICK',
    'NESTPICK_COMPLETE'
);


ALTER TYPE public.job_status_new OWNER TO postgres;

--
-- TOC entry 310 (class 1255 OID 33181)
-- Name: jobs_set_load_finish_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.jobs_set_load_finish_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
            BEGIN
            IF NEW.event_type = 'status:LOAD_FINISH' THEN
            UPDATE public.jobs
            SET load_finish_at = COALESCE(load_finish_at, NEW.created_at)
            WHERE key = NEW.key;
            END IF;
            RETURN NEW;
            END;
            $$;


ALTER FUNCTION public.jobs_set_load_finish_at() OWNER TO postgres;

--
-- TOC entry 311 (class 1255 OID 33263)
-- Name: notify_channel(); Type: FUNCTION; Schema: public; Owner: woodtron_user
--

CREATE FUNCTION public.notify_channel() RETURNS trigger
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


ALTER FUNCTION public.notify_channel() OWNER TO woodtron_user;

--
-- TOC entry 309 (class 1255 OID 24901)
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

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

--
-- TOC entry 221 (class 1259 OID 24593)
-- Name: grundner; Type: TABLE; Schema: public; Owner: woodtron_user
--

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
    reserved_stock integer DEFAULT 0,
    pre_reserved integer DEFAULT 0
);


ALTER TABLE public.grundner OWNER TO woodtron_user;

--
-- TOC entry 224 (class 1259 OID 24919)
-- Name: jobs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.jobs (
    key character varying(100) NOT NULL,
    folder character varying(255),
    ncfile character varying(255),
    material character varying(255),
    parts character varying(255),
    size character varying(255),
    thickness character varying(255),
    is_locked boolean DEFAULT false,
    machine_id integer,
    dateadded timestamp with time zone,
    staged_at timestamp with time zone,
    cut_at timestamp with time zone,
    nestpick_completed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    pallet character varying(50),
    last_error text,
    status public.job_status DEFAULT 'PENDING'::public.job_status,
    load_finish_at timestamp with time zone,
    processing_ms integer GENERATED ALWAYS AS (
CASE
    WHEN ((nestpick_completed_at IS NULL) OR (load_finish_at IS NULL)) THEN NULL::integer
    ELSE ((EXTRACT(epoch FROM (nestpick_completed_at - load_finish_at)) * (1000)::numeric))::integer
END) STORED,
    pre_reserved boolean DEFAULT false NOT NULL,
    qty integer DEFAULT 0 NOT NULL,
    allocated_at timestamp with time zone,
    CONSTRAINT jobs_key_not_blank CHECK ((length(btrim((key)::text)) > 0)),
    CONSTRAINT jobs_pre_reserved_pending_chk CHECK (((pre_reserved = false) OR (status = 'PENDING'::public.job_status)))
);


ALTER TABLE public.jobs OWNER TO postgres;

--
-- TOC entry 5074 (class 0 OID 0)
-- Dependencies: 224
-- Name: TABLE jobs; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.jobs IS 'Canonical job lifecycle row (single source of truth; use status + timestamps)';


--
-- TOC entry 230 (class 1259 OID 33290)
-- Name: allocated_material_view; Type: VIEW; Schema: public; Owner: woodtron_user
--

CREATE VIEW public.allocated_material_view AS
 SELECT g.id AS grundner_id,
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
    COALESCE(NULLIF(TRIM(BOTH FROM j.folder), ''::text), NULLIF(regexp_replace((j.key)::text, '^.*/([^/]+)/[^/]+$'::text, '\\1'::text), (j.key)::text)) AS folder,
    j.ncfile,
    j.material,
    j.pre_reserved AS job_pre_reserved,
    j.is_locked AS job_is_locked,
    j.updated_at,
    j.allocated_at,
        CASE
            WHEN j.is_locked THEN 'locked'::text
            ELSE 'pre_reserved'::text
        END AS allocation_status
   FROM (public.jobs j
     JOIN public.grundner g ON (((TRIM(BOTH FROM COALESCE(j.material, ''::character varying)) <> ''::text) AND (((TRIM(BOTH FROM j.material) ~ '^[0-9]+$'::text) AND (g.type_data = (TRIM(BOTH FROM j.material))::integer)) OR ((NOT (TRIM(BOTH FROM j.material) ~ '^[0-9]+$'::text)) AND ((g.customer_id)::text = TRIM(BOTH FROM j.material)))))))
  WHERE ((j.pre_reserved = true) OR (j.is_locked = true));


ALTER VIEW public.allocated_material_view OWNER TO woodtron_user;

--
-- TOC entry 219 (class 1259 OID 16404)
-- Name: cncstats; Type: TABLE; Schema: public; Owner: woodtron_user
--

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

--
-- TOC entry 220 (class 1259 OID 24592)
-- Name: grundner_id_seq; Type: SEQUENCE; Schema: public; Owner: woodtron_user
--

CREATE SEQUENCE public.grundner_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.grundner_id_seq OWNER TO woodtron_user;

--
-- TOC entry 5075 (class 0 OID 0)
-- Dependencies: 220
-- Name: grundner_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: woodtron_user
--

ALTER SEQUENCE public.grundner_id_seq OWNED BY public.grundner.id;


--
-- TOC entry 226 (class 1259 OID 24941)
-- Name: job_events; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.job_events (
    event_id bigint NOT NULL,
    key character varying(100) NOT NULL,
    machine_id integer,
    event_type text NOT NULL,
    payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.job_events OWNER TO postgres;

--
-- TOC entry 5076 (class 0 OID 0)
-- Dependencies: 226
-- Name: TABLE job_events; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.job_events IS 'Append-only audit trail of lifecycle/file events (multi-PC safe)';


--
-- TOC entry 225 (class 1259 OID 24940)
-- Name: job_events_event_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.job_events_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.job_events_event_id_seq OWNER TO postgres;

--
-- TOC entry 5077 (class 0 OID 0)
-- Dependencies: 225
-- Name: job_events_event_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.job_events_event_id_seq OWNED BY public.job_events.event_id;


--
-- TOC entry 227 (class 1259 OID 33227)
-- Name: jobs_history; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.jobs_history AS
 SELECT key,
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
  WHERE (status = 'NESTPICK_COMPLETE'::public.job_status);


ALTER VIEW public.jobs_history OWNER TO postgres;

--
-- TOC entry 228 (class 1259 OID 33231)
-- Name: jobs_pending; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.jobs_pending AS
 SELECT key,
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
  WHERE (status = 'PENDING'::public.job_status);


ALTER VIEW public.jobs_pending OWNER TO postgres;

--
-- TOC entry 229 (class 1259 OID 33235)
-- Name: machine_jobs; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.machine_jobs AS
 SELECT key,
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
  WHERE (status = ANY (ARRAY['STAGED'::public.job_status, 'CNC_FINISH'::public.job_status, 'FORWARDED_TO_NESTPICK'::public.job_status]));


ALTER VIEW public.machine_jobs OWNER TO postgres;

--
-- TOC entry 223 (class 1259 OID 24903)
-- Name: machines; Type: TABLE; Schema: public; Owner: postgres
--

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

--
-- TOC entry 5078 (class 0 OID 0)
-- Dependencies: 223
-- Name: TABLE machines; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.machines IS 'Per-CNC config: PC/CNC IPs, AutoPac/Nestpick folders, flags';


--
-- TOC entry 5079 (class 0 OID 0)
-- Dependencies: 223
-- Name: COLUMN machines.ap_jobfolder; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.machines.ap_jobfolder IS 'Ready-To-Run / AutoPac intake (per machine)';


--
-- TOC entry 5080 (class 0 OID 0)
-- Dependencies: 223
-- Name: COLUMN machines.nestpick_folder; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.machines.nestpick_folder IS 'Where pallet-tagged CSVs are moved for Nestpick ingestion';


--
-- TOC entry 222 (class 1259 OID 24902)
-- Name: machines_machine_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.machines_machine_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.machines_machine_id_seq OWNER TO postgres;

--
-- TOC entry 5081 (class 0 OID 0)
-- Dependencies: 222
-- Name: machines_machine_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.machines_machine_id_seq OWNED BY public.machines.machine_id;


--
-- TOC entry 4870 (class 2604 OID 24596)
-- Name: grundner id; Type: DEFAULT; Schema: public; Owner: woodtron_user
--

ALTER TABLE ONLY public.grundner ALTER COLUMN id SET DEFAULT nextval('public.grundner_id_seq'::regclass);


--
-- TOC entry 4884 (class 2604 OID 24944)
-- Name: job_events event_id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.job_events ALTER COLUMN event_id SET DEFAULT nextval('public.job_events_event_id_seq'::regclass);


--
-- TOC entry 4873 (class 2604 OID 24906)
-- Name: machines machine_id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.machines ALTER COLUMN machine_id SET DEFAULT nextval('public.machines_machine_id_seq'::regclass);


--
-- TOC entry 4891 (class 2606 OID 16410)
-- Name: cncstats cncstats_pkey; Type: CONSTRAINT; Schema: public; Owner: woodtron_user
--

ALTER TABLE ONLY public.cncstats
    ADD CONSTRAINT cncstats_pkey PRIMARY KEY (key);


--
-- TOC entry 4893 (class 2606 OID 24598)
-- Name: grundner grundner_pkey; Type: CONSTRAINT; Schema: public; Owner: woodtron_user
--

ALTER TABLE ONLY public.grundner
    ADD CONSTRAINT grundner_pkey PRIMARY KEY (id);


--
-- TOC entry 4895 (class 2606 OID 24600)
-- Name: grundner grundner_type_data_customer_id_key; Type: CONSTRAINT; Schema: public; Owner: woodtron_user
--

ALTER TABLE ONLY public.grundner
    ADD CONSTRAINT grundner_type_data_customer_id_key UNIQUE (type_data, customer_id);


--
-- TOC entry 4909 (class 2606 OID 24949)
-- Name: job_events job_events_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.job_events
    ADD CONSTRAINT job_events_pkey PRIMARY KEY (event_id);


--
-- TOC entry 4903 (class 2606 OID 24928)
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (key);


--
-- TOC entry 4900 (class 2606 OID 24914)
-- Name: machines machines_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.machines
    ADD CONSTRAINT machines_pkey PRIMARY KEY (machine_id);


--
-- TOC entry 4904 (class 1259 OID 33183)
-- Name: idx_job_events_key_type_time; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_job_events_key_type_time ON public.job_events USING btree (key, event_type, created_at);


--
-- TOC entry 4905 (class 1259 OID 24962)
-- Name: job_events_created_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX job_events_created_idx ON public.job_events USING btree (created_at);


--
-- TOC entry 4906 (class 1259 OID 24960)
-- Name: job_events_key_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX job_events_key_idx ON public.job_events USING btree (key);


--
-- TOC entry 4907 (class 1259 OID 24961)
-- Name: job_events_machine_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX job_events_machine_idx ON public.job_events USING btree (machine_id);


--
-- TOC entry 4910 (class 1259 OID 24963)
-- Name: job_events_type_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX job_events_type_idx ON public.job_events USING btree (event_type);


--
-- TOC entry 4901 (class 1259 OID 24939)
-- Name: jobs_dates_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX jobs_dates_idx ON public.jobs USING btree (dateadded, staged_at, cut_at, nestpick_completed_at);


--
-- TOC entry 4896 (class 1259 OID 24918)
-- Name: machines_cnc_ip_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX machines_cnc_ip_idx ON public.machines USING btree (cnc_ip);


--
-- TOC entry 4897 (class 1259 OID 24916)
-- Name: machines_name_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX machines_name_idx ON public.machines USING btree (name);


--
-- TOC entry 4898 (class 1259 OID 24917)
-- Name: machines_pc_ip_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX machines_pc_ip_idx ON public.machines USING btree (pc_ip);


--
-- TOC entry 4916 (class 2620 OID 33296)
-- Name: jobs trg_allocated_material_jobs; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_allocated_material_jobs AFTER INSERT OR DELETE OR UPDATE OF pre_reserved, is_locked, material ON public.jobs FOR EACH STATEMENT EXECUTE FUNCTION public.notify_channel('allocated_material_changed', 'tg_table_name');


--
-- TOC entry 4914 (class 2620 OID 33295)
-- Name: grundner trg_grundner_changed; Type: TRIGGER; Schema: public; Owner: woodtron_user
--

CREATE TRIGGER trg_grundner_changed AFTER INSERT OR DELETE OR UPDATE ON public.grundner FOR EACH STATEMENT EXECUTE FUNCTION public.notify_channel('grundner_changed', 'tg_table_name');


--
-- TOC entry 4918 (class 2620 OID 33182)
-- Name: job_events trg_jobs_load_finish; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_jobs_load_finish AFTER INSERT ON public.job_events FOR EACH ROW EXECUTE FUNCTION public.jobs_set_load_finish_at();


--
-- TOC entry 4917 (class 2620 OID 24977)
-- Name: jobs trg_jobs_updated; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_jobs_updated BEFORE UPDATE ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- TOC entry 4915 (class 2620 OID 24976)
-- Name: machines trg_machines_updated; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_machines_updated BEFORE UPDATE ON public.machines FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- TOC entry 4912 (class 2606 OID 24950)
-- Name: job_events job_events_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.job_events
    ADD CONSTRAINT job_events_key_fkey FOREIGN KEY (key) REFERENCES public.jobs(key) ON DELETE CASCADE;


--
-- TOC entry 4913 (class 2606 OID 24955)
-- Name: job_events job_events_machine_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.job_events
    ADD CONSTRAINT job_events_machine_id_fkey FOREIGN KEY (machine_id) REFERENCES public.machines(machine_id) ON DELETE SET NULL;


--
-- TOC entry 4911 (class 2606 OID 24929)
-- Name: jobs jobs_machine_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_machine_id_fkey FOREIGN KEY (machine_id) REFERENCES public.machines(machine_id) ON DELETE SET NULL;


-- Completed on 2025-10-31 14:44:15

--
-- PostgreSQL database dump complete
--

