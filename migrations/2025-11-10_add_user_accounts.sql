-- Track application users for shared desktop installs.
CREATE TABLE IF NOT EXISTS public.app_users (
    id bigserial PRIMARY KEY,
    email text NOT NULL,
    display_name text,
    password_hash text NOT NULL,
    role text NOT NULL DEFAULT 'operator',
    force_password_reset boolean NOT NULL DEFAULT false,
    last_login_at timestamptz,
    active_session_token uuid,
    active_session_issued_at timestamptz,
    failed_attempts integer NOT NULL DEFAULT 0,
    locked_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT app_users_email_not_empty CHECK (length(trim(coalesce(email, ''))) > 0),
    CONSTRAINT app_users_password_not_empty CHECK (length(trim(coalesce(password_hash, ''))) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_ci_idx ON public.app_users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS app_users_active_session_idx ON public.app_users (active_session_token) WHERE active_session_token IS NOT NULL;
