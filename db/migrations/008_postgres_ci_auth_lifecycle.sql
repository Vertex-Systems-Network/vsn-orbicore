-- ORB-005: disposable PostgreSQL synthetic password/MFA session lifecycle.
-- Applies after 001-007. This is deliberately NOT production login parity:
-- existing SQLite scrypt credentials are not imported or verified here.
-- Only explicit ci_pg_bcrypt_only fixture password records are eligible.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

CREATE TABLE IF NOT EXISTS ci_pg_login_limits (
  email_digest TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures BETWEEN 0 AND 50),
  window_started TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  locked_until TIMESTAMPTZ
);
REVOKE ALL ON TABLE public.ci_pg_login_limits FROM PUBLIC;
REVOKE ALL ON TABLE public.ci_pg_login_limits FROM orbicore_synthetic_submitter;

ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS ci_mfa_failures INTEGER
  NOT NULL DEFAULT 0 CHECK (ci_mfa_failures BETWEEN 0 AND 5);

-- The caller supplies only fresh randomly generated *hashes*, not a role,
-- user ID or tenant. The function reads credential material internally and
-- returns no salt/hash or user identifier. Invalid and missing users are
-- indistinguishable to the HTTP caller. Each email has bounded attempts.
CREATE OR REPLACE FUNCTION public.orbicore_ci_password_login(
  p_email TEXT,
  p_password TEXT,
  p_session_hash TEXT
) RETURNS TABLE (
  accepted BOOLEAN, needs_mfa BOOLEAN, tenant_id TEXT, rate_limited BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  v_email TEXT;
  v_digest TEXT;
  v_id TEXT;
  v_tenant TEXT;
  v_hash TEXT;
  v_mfa BOOLEAN;
  v_failures INTEGER;
  v_window TIMESTAMPTZ;
  v_locked TIMESTAMPTZ;
  v_now TIMESTAMPTZ;
BEGIN
  IF p_email IS NULL OR length(p_email) NOT BETWEEN 3 AND 254 OR
     p_password IS NULL OR length(p_password) NOT BETWEEN 8 AND 128 OR
     p_session_hash IS NULL OR p_session_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN QUERY SELECT FALSE,FALSE,NULL::TEXT,FALSE;
    RETURN;
  END IF;
  v_email := lower(btrim(p_email));
  IF v_email !~ '^[^[:space:]@]+@[^[:space:]@]+$' THEN
    RETURN QUERY SELECT FALSE,FALSE,NULL::TEXT,FALSE;
    RETURN;
  END IF;

  v_digest := encode(sha256(convert_to(v_email,'UTF8')),'hex');
  -- Prevent interleaved login attempts for the same identifier without
  -- exposing its email in an advisory lock or login-limit row.
  PERFORM pg_advisory_xact_lock(hashtextextended('orbicore:ci:login:' || v_digest,0));
  v_now := clock_timestamp();
  SELECT failures,window_started,locked_until
    INTO v_failures,v_window,v_locked
    FROM public.ci_pg_login_limits WHERE email_digest=v_digest FOR UPDATE;

  IF v_locked IS NOT NULL AND v_locked > v_now THEN
    RETURN QUERY SELECT FALSE,FALSE,NULL::TEXT,TRUE;
    RETURN;
  END IF;
  IF v_window IS NULL OR v_window < v_now - interval '15 minutes' THEN
    v_failures := 0;
    v_window := v_now;
  END IF;

  SELECT u.id,u.organization_id,u.password_hash,u.mfa_enabled
    INTO v_id,v_tenant,v_hash,v_mfa
    FROM public.users AS u
    WHERE lower(u.email)=v_email
      AND u.password_salt='ci_pg_bcrypt_only'
      AND u.disabled=FALSE
    FOR SHARE OF u;

  IF v_id IS NULL OR v_hash !~ '^\$2[abxy]\$' OR
     public.crypt(p_password,v_hash) IS DISTINCT FROM v_hash THEN
    v_failures := LEAST(50,COALESCE(v_failures,0)+1);
    INSERT INTO public.ci_pg_login_limits(
      email_digest,failures,window_started,locked_until
    ) VALUES(
      v_digest,v_failures,v_window,
      CASE WHEN v_failures>=5 THEN v_now+interval '15 minutes' END
    ) ON CONFLICT(email_digest) DO UPDATE
      SET failures=EXCLUDED.failures,window_started=EXCLUDED.window_started,
          locked_until=EXCLUDED.locked_until;
    RETURN QUERY SELECT FALSE,FALSE,NULL::TEXT,(v_failures>=5);
    RETURN;
  END IF;
  DELETE FROM public.ci_pg_login_limits WHERE email_digest=v_digest;

  INSERT INTO public.sessions(
    token_hash,organization_id,user_id,expires_at,mfa_verified,created_at
  ) VALUES(
    p_session_hash,v_tenant,v_id,
    v_now + CASE WHEN v_mfa THEN interval '5 minutes'
                 ELSE interval '1 hour' END,
    FALSE,v_now
  );

  RETURN QUERY SELECT TRUE,v_mfa,v_tenant,FALSE;
END
$body$;

-- A pending session cannot authorize work. A single recovery code may
-- upgrade it to a new *rotated* token hash. Invalid codes are bounded:
-- five failures revoke the pending session. This is a recovery-code proof,
-- not TOTP/decryption/passkey migration.
CREATE OR REPLACE FUNCTION public.orbicore_ci_finish_recovery_mfa(
  p_old_hash TEXT,p_new_hash TEXT,p_code_hash TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  v_user TEXT;
  v_org TEXT;
  v_failures INTEGER;
  v_consumed TEXT;
BEGIN
  IF p_old_hash IS NULL OR p_old_hash !~ '^[0-9a-f]{64}$'
     OR p_new_hash IS NULL OR p_new_hash !~ '^[0-9a-f]{64}$'
     OR p_old_hash=p_new_hash
     OR p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN FALSE;
  END IF;

  SELECT s.user_id,s.organization_id,s.ci_mfa_failures
    INTO v_user,v_org,v_failures
    FROM public.sessions AS s
    JOIN public.users AS u
      ON u.id=s.user_id AND u.organization_id=s.organization_id
    WHERE s.token_hash=p_old_hash
      AND s.expires_at > clock_timestamp()
      AND s.mfa_verified=FALSE
      AND u.mfa_enabled=TRUE AND u.disabled=FALSE
    FOR UPDATE OF s,u;

  IF v_user IS NULL THEN RETURN FALSE; END IF;
  IF v_failures>=5 THEN
    DELETE FROM public.sessions WHERE token_hash=p_old_hash;
    RETURN FALSE;
  END IF;

  UPDATE public.recovery_codes AS r
    SET used_at=clock_timestamp()
    WHERE r.user_id=v_user AND r.organization_id=v_org
      AND r.code_hash=p_code_hash AND r.used_at IS NULL
    RETURNING r.code_hash INTO v_consumed;

  IF v_consumed IS NULL THEN
    IF v_failures>=4 THEN
      DELETE FROM public.sessions WHERE token_hash=p_old_hash;
    ELSE
      UPDATE public.sessions SET ci_mfa_failures=ci_mfa_failures+1
        WHERE token_hash=p_old_hash;
    END IF;
    RETURN FALSE;
  END IF;

  UPDATE public.sessions
    SET token_hash=p_new_hash,mfa_verified=TRUE,
        ci_mfa_failures=0,expires_at=clock_timestamp()+interval '1 hour'
    WHERE token_hash=p_old_hash;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pending_mfa_session_disappeared'
      USING ERRCODE='23514';
  END IF;
  RETURN TRUE;
END
$body$;

CREATE OR REPLACE FUNCTION public.orbicore_ci_revoke_session(
  p_session_hash TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
BEGIN
  IF p_session_hash IS NULL OR p_session_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN FALSE;
  END IF;
  DELETE FROM public.sessions WHERE token_hash=p_session_hash;
  RETURN FOUND;
END
$body$;

-- PostgreSQL functions default to PUBLIC EXECUTE. Revoke again on reruns.
REVOKE ALL ON FUNCTION public.orbicore_ci_password_login(TEXT,TEXT,TEXT)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.orbicore_ci_finish_recovery_mfa(TEXT,TEXT,TEXT)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.orbicore_ci_revoke_session(TEXT)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.orbicore_ci_password_login(TEXT,TEXT,TEXT)
  TO orbicore_synthetic_submitter;
GRANT EXECUTE ON FUNCTION public.orbicore_ci_finish_recovery_mfa(TEXT,TEXT,TEXT)
  TO orbicore_synthetic_submitter;
GRANT EXECUTE ON FUNCTION public.orbicore_ci_revoke_session(TEXT)
  TO orbicore_synthetic_submitter;

COMMIT;
