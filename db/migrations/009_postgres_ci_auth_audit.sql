-- ORB-005: atomic, redacted hash-chain audit for the disposable PG CI auth
-- lifecycle. Apply AFTER 001-008. This remains NOT a production auth cutover.
-- An unaudited 008 entrypoint is no longer granted to the limited role.
BEGIN;

-- Internal-only helper. Invariant: fixed metadata, no cookies, raw passwords,
-- email, recovery code, challenge or hashed session tokens in audit rows.
CREATE OR REPLACE FUNCTION public.orbicore_ci_append_auth_audit(
  p_token_hash TEXT,p_action TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  v_actor TEXT;
  v_tenant TEXT;
  v_mfa BOOLEAN;
  v_verified BOOLEAN;
  v_previous TEXT;
  v_details TEXT;
  v_outcome TEXT;
  v_timestamp TIMESTAMPTZ;
  v_iso TEXT;
  v_payload TEXT;
  v_entry_hash TEXT;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_action NOT IN (
       'auth.login.success','auth.login.mfa_pending',
       'auth.mfa.recovery','auth.logout'
     ) THEN
    RETURN FALSE;
  END IF;

  SELECT u.id,s.organization_id,u.mfa_enabled,s.mfa_verified
  INTO v_actor,v_tenant,v_mfa,v_verified
  FROM public.sessions AS s
  JOIN public.users AS u
    ON u.id=s.user_id AND u.organization_id=s.organization_id
  WHERE s.token_hash=p_token_hash
    AND s.expires_at > clock_timestamp()
    AND (p_action='auth.logout' OR u.disabled=FALSE)
  FOR SHARE OF s,u;

  IF v_actor IS NULL OR
    (p_action='auth.login.success' AND v_mfa=TRUE AND v_verified=FALSE) OR
    (p_action='auth.login.mfa_pending' AND
      (v_mfa=FALSE OR v_verified=TRUE)) OR
    (p_action='auth.mfa.recovery' AND
      (v_mfa=FALSE OR v_verified=FALSE)) THEN
    RETURN FALSE;
  END IF;
  v_outcome := CASE WHEN p_action='auth.login.mfa_pending'
    THEN 'pending_mfa' ELSE 'completed' END;
  v_details := CASE p_action
    WHEN 'auth.login.success' THEN
      '{"source":"ci_fixture","method":"password"}'
    WHEN 'auth.login.mfa_pending' THEN
      '{"source":"ci_fixture","method":"password_mfa_pending"}'
    WHEN 'auth.mfa.recovery' THEN
      '{"source":"ci_fixture","method":"recovery_code"}'
    ELSE
      '{"source":"ci_fixture","method":"session_revocation"}'
  END;

  -- Identical tenant advisory key to migration 006 job writer, preserving
  -- single-tenant append order when HTTP auth and synthetic jobs race.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'orbicore:synthetic:audit:' || v_tenant,0
  ));

  SELECT entry_hash INTO v_previous
  FROM public.audit_events
  WHERE organization_id=v_tenant
  ORDER BY audit_sequence DESC
  LIMIT 1;
  IF FOUND AND
     (v_previous IS NULL OR v_previous !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'unverified_auth_audit_head_refused'
      USING ERRCODE='23514';
  END IF;
  v_previous := COALESCE(v_previous,'GENESIS');
  v_timestamp := date_trunc('milliseconds',clock_timestamp());
  v_iso := to_char(v_timestamp AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  -- Node computeAuditEntryHash canonical ordered JSON-string array.
  v_payload := '[' ||
    to_json(v_previous)::TEXT || ',' ||
    to_json(v_tenant)::TEXT || ',' ||
    to_json(v_actor)::TEXT || ',' ||
    to_json(p_action)::TEXT || ',' ||
    to_json(v_actor)::TEXT || ',' ||
    to_json(v_outcome)::TEXT || ',' ||
    to_json(v_details)::TEXT || ',' ||
    to_json(v_iso)::TEXT || ']';
  v_entry_hash := encode(sha256(convert_to(v_payload,'UTF8')),'hex');

  INSERT INTO public.audit_events(
    id,organization_id,actor,action,target_id,outcome,
    created_at,details_json,details_raw_json,prev_hash,entry_hash
  ) VALUES(
    gen_random_uuid()::TEXT,v_tenant,v_actor,p_action,v_actor,v_outcome,
    v_timestamp,v_details::JSONB,v_details,v_previous,v_entry_hash
  );
  RETURN TRUE;
END
$body$;

-- New audited wrappers delegate to migration 008's protected functions
-- and append in the SAME transaction. A failure in the final audit INSERT
-- rolls back password session issuance, MFA code use/rotation, or logout.
CREATE OR REPLACE FUNCTION public.orbicore_ci_password_login_audited(
  p_email TEXT,p_password TEXT,p_session_hash TEXT
) RETURNS TABLE(
  accepted BOOLEAN,needs_mfa BOOLEAN,tenant_id TEXT,rate_limited BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  v_accepted BOOLEAN;
  v_mfa BOOLEAN;
  v_tenant TEXT;
  v_rate BOOLEAN;
  v_action TEXT;
BEGIN
  SELECT x.accepted,x.needs_mfa,x.tenant_id,x.rate_limited
    INTO v_accepted,v_mfa,v_tenant,v_rate
  FROM public.orbicore_ci_password_login(
    p_email,p_password,p_session_hash
  ) AS x;
  IF v_accepted=TRUE THEN
    v_action := CASE WHEN v_mfa THEN 'auth.login.mfa_pending'
      ELSE 'auth.login.success' END;
    IF NOT public.orbicore_ci_append_auth_audit(
      p_session_hash,v_action
    ) THEN
      RAISE EXCEPTION 'auth_login_audit_required'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN QUERY SELECT
    COALESCE(v_accepted,FALSE),COALESCE(v_mfa,FALSE),
    v_tenant,COALESCE(v_rate,FALSE);
END
$body$;

CREATE OR REPLACE FUNCTION public.orbicore_ci_finish_recovery_mfa_audited(
  p_old_hash TEXT,p_new_hash TEXT,p_code_hash TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE v_verified BOOLEAN;
BEGIN
  v_verified := public.orbicore_ci_finish_recovery_mfa(
    p_old_hash,p_new_hash,p_code_hash
  );
  IF v_verified AND NOT public.orbicore_ci_append_auth_audit(
    p_new_hash,'auth.mfa.recovery'
  ) THEN
    RAISE EXCEPTION 'auth_mfa_audit_required'
      USING ERRCODE='23514';
  END IF;
  RETURN COALESCE(v_verified,FALSE);
END
$body$;

CREATE OR REPLACE FUNCTION public.orbicore_ci_revoke_session_audited(
  p_token_hash TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE v_logged BOOLEAN;
BEGIN
  -- If the token is absent/expired, return FALSE: no forged audit record.
  v_logged := public.orbicore_ci_append_auth_audit(
    p_token_hash,'auth.logout'
  );
  IF NOT v_logged THEN RETURN FALSE; END IF;
  IF NOT public.orbicore_ci_revoke_session(p_token_hash) THEN
    RAISE EXCEPTION 'auth_logout_audit_required'
      USING ERRCODE='23514';
  END IF;
  RETURN TRUE;
END
$body$;

-- Keep helper and old entrypoints unavailable to CI runtime SQL callers:
-- the only granted auth operations are audited wrappers.
REVOKE ALL ON FUNCTION public.orbicore_ci_append_auth_audit(TEXT,TEXT)
  FROM PUBLIC,orbicore_synthetic_submitter;
REVOKE ALL ON FUNCTION public.orbicore_ci_password_login(TEXT,TEXT,TEXT)
  FROM PUBLIC,orbicore_synthetic_submitter;
REVOKE ALL ON FUNCTION public.orbicore_ci_finish_recovery_mfa(TEXT,TEXT,TEXT)
  FROM PUBLIC,orbicore_synthetic_submitter;
REVOKE ALL ON FUNCTION public.orbicore_ci_revoke_session(TEXT)
  FROM PUBLIC,orbicore_synthetic_submitter;

REVOKE ALL ON FUNCTION public.orbicore_ci_password_login_audited(TEXT,TEXT,TEXT)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.orbicore_ci_finish_recovery_mfa_audited(TEXT,TEXT,TEXT)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.orbicore_ci_revoke_session_audited(TEXT)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.orbicore_ci_password_login_audited(TEXT,TEXT,TEXT)
  TO orbicore_synthetic_submitter;
GRANT EXECUTE ON FUNCTION public.orbicore_ci_finish_recovery_mfa_audited(TEXT,TEXT,TEXT)
  TO orbicore_synthetic_submitter;
GRANT EXECUTE ON FUNCTION public.orbicore_ci_revoke_session_audited(TEXT)
  TO orbicore_synthetic_submitter;

COMMIT;
