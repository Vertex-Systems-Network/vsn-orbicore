-- ORB-005 / ORB-004: narrow PostgreSQL-authenticated synthetic job submission.
-- Schema owner runs migration. NOLOGIN submit role has no table grants and can
-- only invoke a SECURITY DEFINER entrypoint that validates real PG session
-- rows and atomic job/outbox/audit integrity. NOT a production HTTP cutover.
BEGIN;

DO $roles$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'orbicore_synthetic_submitter'
  ) THEN
    CREATE ROLE orbicore_synthetic_submitter NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
END
$roles$;

-- The migration must never grant raw job, outbox or audit write access to its
-- caller role. This role is not a service login; CI uses SET LOCAL ROLE.
REVOKE ALL PRIVILEGES ON TABLE public.jobs, public.job_outbox,
  public.audit_events, public.users, public.sessions, public.accounts,
  public.organizations, public.secret_references
  FROM orbicore_synthetic_submitter;
GRANT USAGE ON SCHEMA public TO orbicore_synthetic_submitter;

-- Timestamp ties must never choose the wrong audit head. Existing imported
-- rows acquire a monotonically assigned position; their old chain ordering
-- still requires an independent migration/cutover proof.
ALTER TABLE public.audit_events
  ADD COLUMN IF NOT EXISTS audit_sequence BIGINT GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX IF NOT EXISTS audit_events_sequence_unique
  ON public.audit_events(audit_sequence);

-- Only the owner of this function is allowed to touch the underlying tables.
-- It must be owned by the controlled database schema owner, never an untrusted
-- or caller-controlled role. search_path is fixed; every table is qualified.
CREATE OR REPLACE FUNCTION public.orbicore_submit_synthetic_inventory(
  p_token_hash TEXT,
  p_organization_id TEXT,
  p_account_id TEXT,
  p_idempotency_key TEXT
) RETURNS TABLE(job_id TEXT, created BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  v_actor TEXT;
  v_key_hash TEXT;
  v_job_id TEXT;
  v_existing_account TEXT;
  v_existing_actor TEXT;
  v_existing_tenant TEXT;
  v_previous TEXT;
  v_details TEXT := '{"source":"mock_fixture","live":false,"type":"inventory_refresh"}';
  v_created_at TIMESTAMPTZ;
  v_created_iso TEXT;
  v_hash_payload TEXT;
  v_hash TEXT;
BEGIN
  -- All caller-controlled identifiers are tightly bounded; never accept an
  -- actor ID, role, job type, provider endpoint or arbitrary audit payload.
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_organization_id IS NULL OR
        p_organization_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR p_account_id IS NULL OR
        p_account_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR p_idempotency_key IS NULL OR
        length(p_idempotency_key) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'invalid_synthetic_submission_arguments' USING ERRCODE = '22023';
  END IF;

  -- PostgreSQL session, not SQLite or a caller-settable tenant GUC, is the
  -- authorization source. Shared locks serialize against user disable,
  -- role change, session revocation and account source/tenant changes.
  SELECT u.id INTO v_actor
  FROM public.sessions AS s
  JOIN public.users AS u
    ON u.id = s.user_id AND u.organization_id = s.organization_id
  JOIN public.accounts AS a
    ON a.organization_id = u.organization_id
   AND a.id = p_account_id
  WHERE s.token_hash = p_token_hash
    AND s.organization_id = p_organization_id
    AND s.expires_at > clock_timestamp()
    AND (u.mfa_enabled = FALSE OR s.mfa_verified = TRUE)
    AND u.disabled = FALSE
    AND u.role IN ('owner','admin','operator')
    AND a.source = 'mock_fixture'
  FOR SHARE OF s, u, a;

  IF v_actor IS NULL THEN
    -- Avoid disclosing tenant, user existence or private account metadata.
    RAISE EXCEPTION 'synthetic_submission_policy_denied' USING ERRCODE = '42501';
  END IF;

  -- Existing code SHA-256(tenant + NUL + idempotencyKey) uses a bytea NUL.
  -- PostgreSQL text cannot contain NUL; sha256(bytea) is built into PG16.
  v_key_hash := encode(sha256(
    convert_to(p_organization_id, 'UTF8') || decode('00','hex') ||
    convert_to(p_idempotency_key, 'UTF8')
  ), 'hex');

  INSERT INTO public.jobs(
    id, organization_id, account_id, requested_by, type,
    status, idempotency_key, created_at
  ) VALUES (
    gen_random_uuid()::text, p_organization_id, p_account_id, v_actor,
    'inventory_refresh', 'queued', v_key_hash, clock_timestamp()
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_job_id;

  IF v_job_id IS NULL THEN
    SELECT j.id, j.account_id, j.requested_by, j.organization_id
      INTO v_job_id, v_existing_account, v_existing_actor, v_existing_tenant
    FROM public.jobs AS j
    WHERE j.idempotency_key = v_key_hash;

    IF v_job_id IS NULL
       OR v_existing_account IS DISTINCT FROM p_account_id
       OR v_existing_actor IS DISTINCT FROM v_actor
       OR v_existing_tenant IS DISTINCT FROM p_organization_id THEN
      RAISE EXCEPTION 'idempotency_key_payload_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT v_job_id, FALSE;
    RETURN;
  END IF;

  -- One and only one durable signal, or neither job nor signal commits.
  INSERT INTO public.job_outbox(job_id, organization_id)
  VALUES (v_job_id, p_organization_id);

  -- Serializes this function's audit appends per tenant. This is deliberately
  -- not a global audit ordering/migration guarantee for other writers.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'orbicore:synthetic:audit:' || p_organization_id, 0
  ));
  SELECT a.entry_hash INTO v_previous
  FROM public.audit_events AS a
  WHERE a.organization_id = p_organization_id
  ORDER BY a.audit_sequence DESC
  LIMIT 1;

  IF FOUND AND (v_previous IS NULL OR v_previous !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'unverified_audit_head_refused' USING ERRCODE = '23514';
  END IF;
  v_previous := COALESCE(v_previous, 'GENESIS');
  v_created_at := date_trunc('milliseconds', clock_timestamp());
  v_created_iso := to_char(v_created_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  -- Deliberately mirrors Node computeAuditEntryHash's ordered string-array
  -- serialization for this *fixed ASCII-only event*. Details raw JSON is a
  -- separate TEXT value; JSONB must never silently reorder its hash input.
  v_hash_payload := '[' ||
    to_json(v_previous)::text || ',' ||
    to_json(p_organization_id)::text || ',' ||
    to_json(v_actor)::text || ',' ||
    to_json('job.enqueue'::text)::text || ',' ||
    to_json(v_job_id)::text || ',' ||
    to_json('queued'::text)::text || ',' ||
    to_json(v_details)::text || ',' ||
    to_json(v_created_iso)::text || ']';
  v_hash := encode(sha256(convert_to(v_hash_payload, 'UTF8')), 'hex');

  INSERT INTO public.audit_events(
    id, organization_id, actor, action, target_id, outcome, created_at,
    details_json, details_raw_json, prev_hash, entry_hash
  ) VALUES (
    gen_random_uuid()::text, p_organization_id, v_actor, 'job.enqueue',
    v_job_id, 'queued', v_created_at,
    v_details::jsonb, v_details, v_previous, v_hash
  );

  RETURN QUERY SELECT v_job_id, TRUE;
END
$body$;

-- PostgreSQL grants EXECUTE to PUBLIC by default for new functions. Remove
-- that default explicitly on every rerun, including an upgraded deployment.
REVOKE ALL ON FUNCTION public.orbicore_submit_synthetic_inventory(
  TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.orbicore_submit_synthetic_inventory(
  TEXT, TEXT, TEXT, TEXT
) TO orbicore_synthetic_submitter;

COMMIT;
