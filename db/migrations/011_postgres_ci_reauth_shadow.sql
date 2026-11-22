-- ORB-005 Slice C1 — disposable PostgreSQL CI-only reauthentication shadow.
-- No account migration, PostgreSQL login routing, credential export or session
-- authority. This schema MUST NOT be deployed outside explicit synthetic CI.
BEGIN;

DO $guard$
BEGIN
  IF current_setting('orbicore.ci_shadow_fixture', TRUE)
      IS DISTINCT FROM 'enabled' THEN
    RAISE EXCEPTION 'ci_reauth_shadow_explicit_opt_in_required'
      USING ERRCODE='42501';
  END IF;
END
$guard$;

-- Depends on migrations 003 (tenant FK) and 010 (private CI schema).
DO $roles$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname='orbicore_ci_shadow_writer'
  ) THEN
    CREATE ROLE orbicore_ci_shadow_writer NOLOGIN NOINHERIT NOBYPASSRLS;
  ELSIF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname='orbicore_ci_shadow_writer'
      AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit)
  ) THEN
    RAISE EXCEPTION 'unsafe_existing_ci_shadow_writer_role'
      USING ERRCODE='42501';
  END IF;
END
$roles$;

CREATE TABLE IF NOT EXISTS orbicore_ci_shadow.reauth_drafts (
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_epoch BIGINT NOT NULL CHECK (source_epoch > 0),
  kdf_profile TEXT NOT NULL
    CHECK (kdf_profile = 'scrypt-n32768-r8-p3-v1'),
  verifier_salt TEXT NOT NULL
    CHECK (verifier_salt ~ '^[0-9a-f]{48}$'),
  verifier_digest TEXT NOT NULL
    CHECK (verifier_digest ~ '^[0-9a-f]{128}$'),
  idempotency_key TEXT NOT NULL
    CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL DEFAULT 'shadow_only'
    CHECK (state IN ('shadow_only','invalidated')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ci_reauth_tenant_user_fk
    FOREIGN KEY (user_id,organization_id)
    REFERENCES public.users (id,organization_id) ON DELETE RESTRICT,
  CONSTRAINT ci_reauth_source_epoch_unique
    UNIQUE (organization_id,user_id,source_epoch),
  CONSTRAINT ci_reauth_idempotency_unique
    UNIQUE (organization_id,idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS ci_reauth_one_pending
  ON orbicore_ci_shadow.reauth_drafts (organization_id,user_id)
  WHERE state='shadow_only';

ALTER TABLE orbicore_ci_shadow.reauth_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE orbicore_ci_shadow.reauth_drafts FORCE ROW LEVEL SECURITY;
-- No RLS policies: every non-bypass role is denied all rows, even if a
-- direct table privilege were mistakenly granted.
REVOKE ALL ON orbicore_ci_shadow.reauth_drafts
  FROM PUBLIC,orbicore_tenant_readonly,orbicore_synthetic_submitter,
       orbicore_ci_shadow_stager,orbicore_ci_shadow_writer;

-- Test-only fixed-argument writer, intentionally not an auth verifier.
-- The SQL role CANNOT prove source SQLite reauthentication. Only a dedicated
-- CI adapter is allowed to call this function after checking a source user.
-- No target login route reads these records.
CREATE OR REPLACE FUNCTION orbicore_ci_shadow.stage_reauth_draft(
  p_org TEXT,p_user TEXT,p_email TEXT,p_role TEXT,
  p_source_epoch BIGINT,p_idempotency TEXT,p_salt TEXT,p_digest TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  v_actor TEXT;
  v_written TEXT;
BEGIN
  IF current_setting('orbicore.ci_shadow_fixture', TRUE)
       IS DISTINCT FROM 'enabled'
     OR p_org IS NULL OR
       p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR p_user IS NULL OR
       p_user !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR p_email IS NULL OR length(p_email) > 254
     OR p_email !~* '@[^[:space:]@]+[.](test|invalid)$'
     OR p_role NOT IN ('owner','admin','operator','viewer')
     OR p_source_epoch IS NULL OR p_source_epoch < 1
     OR p_idempotency IS NULL OR p_idempotency !~ '^[0-9a-f]{64}$'
     OR p_salt IS NULL OR p_salt !~ '^[0-9a-f]{48}$'
     OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{128}$' THEN
    RETURN FALSE;
  END IF;

  -- Compare against the real PG fixture identity; never trust a client
  -- supplied tenant GUC, a free-form actor or an arbitrary email label.
  SELECT u.id INTO v_actor
  FROM public.users AS u
  WHERE u.id=p_user AND u.organization_id=p_org
    AND lower(u.email)=lower(p_email) AND u.role=p_role
    AND u.disabled=FALSE AND u.mfa_enabled=FALSE
    AND u.password_salt='ci_reauth_fixture_no_pg_login'
  FOR SHARE OF u;
  IF v_actor IS NULL THEN RETURN FALSE; END IF;

  INSERT INTO orbicore_ci_shadow.reauth_drafts(
    organization_id,user_id,source_epoch,kdf_profile,
    verifier_salt,verifier_digest,idempotency_key,state
  ) VALUES(
    p_org,p_user,p_source_epoch,'scrypt-n32768-r8-p3-v1',
    p_salt,p_digest,p_idempotency,'shadow_only'
  ) ON CONFLICT DO NOTHING
  RETURNING user_id INTO v_written;
  -- Duplicate reauthentication is fail-closed, never a second authority.
  RETURN v_written IS NOT NULL;
END
$body$;

REVOKE ALL ON SCHEMA orbicore_ci_shadow FROM PUBLIC,
  orbicore_tenant_readonly,orbicore_synthetic_submitter,orbicore_ci_shadow_stager;
REVOKE ALL ON FUNCTION orbicore_ci_shadow.stage_reauth_draft(
  TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,TEXT
) FROM PUBLIC,orbicore_tenant_readonly,orbicore_synthetic_submitter,
       orbicore_ci_shadow_stager;
GRANT USAGE ON SCHEMA orbicore_ci_shadow TO orbicore_ci_shadow_writer;
GRANT EXECUTE ON FUNCTION orbicore_ci_shadow.stage_reauth_draft(
  TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,TEXT
) TO orbicore_ci_shadow_writer;

COMMENT ON TABLE orbicore_ci_shadow.reauth_drafts IS
  'CI-only derived verifiers from randomly generated synthetic passwords; never an authentication source';
COMMIT;
