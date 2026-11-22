-- ORB-005 Slice C2: CI-only shadow invalidation and monotonic source epoch.
-- Depends on 003, 010, 011. Does not make shadow verifiers login-capable.
BEGIN;
DO $ci_guard$
BEGIN
  IF current_setting('orbicore.ci_shadow_fixture', TRUE)
      IS DISTINCT FROM 'enabled' THEN
    RAISE EXCEPTION 'ci_shadow_invalidation_explicit_opt_in_required'
      USING ERRCODE='42501';
  END IF;
END $ci_guard$;

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='orbicore_ci_shadow_reconciler') THEN
    CREATE ROLE orbicore_ci_shadow_reconciler NOLOGIN NOINHERIT NOBYPASSRLS;
  ELSIF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname='orbicore_ci_shadow_reconciler'
    AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit)
  ) THEN
    RAISE EXCEPTION 'unsafe_existing_shadow_reconciler_role'
      USING ERRCODE='42501';
  END IF;
END $role$;

CREATE TABLE IF NOT EXISTS orbicore_ci_shadow.source_epoch_fences (
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  confirmed_epoch BIGINT NOT NULL CHECK(confirmed_epoch>=2),
  source_event_id TEXT NOT NULL CHECK(source_event_id ~ '^[0-9a-f]{64}$'),
  reason TEXT NOT NULL CHECK(reason IN
    ('password_reset','disabled','mfa_enrolled','role_revoked')),
  reconciled_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ci_source_fence_pk PRIMARY KEY(organization_id,user_id),
  CONSTRAINT ci_source_fence_fk
    FOREIGN KEY(user_id,organization_id)
    REFERENCES public.users(id,organization_id) ON DELETE RESTRICT
);
ALTER TABLE orbicore_ci_shadow.source_epoch_fences ENABLE ROW LEVEL SECURITY;
ALTER TABLE orbicore_ci_shadow.source_epoch_fences FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE orbicore_ci_shadow.source_epoch_fences FROM
  PUBLIC,orbicore_tenant_readonly,orbicore_synthetic_submitter,
  orbicore_ci_shadow_stager,orbicore_ci_shadow_writer,
  orbicore_ci_shadow_reconciler;

-- The staging function (migration 011) holds FOR SHARE on the same PG user
-- row. A reconciliation locks FOR UPDATE on that row first. This serializes
-- both paths, including when the fence does not yet exist. Staging's BEFORE
-- INSERT trigger checks the latest *confirmed* fence after taking that lock.
CREATE OR REPLACE FUNCTION orbicore_ci_shadow.reject_stale_reauth_insert()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $guard$
DECLARE v_epoch BIGINT;
BEGIN
  IF current_setting('orbicore.ci_shadow_fixture',TRUE)
      IS DISTINCT FROM 'enabled' THEN
    RAISE EXCEPTION 'ci_shadow_staging_guard_required' USING ERRCODE='42501';
  END IF;
  SELECT f.confirmed_epoch INTO v_epoch
  FROM orbicore_ci_shadow.source_epoch_fences AS f
  WHERE f.organization_id=NEW.organization_id AND f.user_id=NEW.user_id;
  IF v_epoch IS NOT NULL AND NEW.source_epoch < v_epoch THEN
    RAISE EXCEPTION 'ci_stale_reauth_source_epoch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $guard$;
DROP TRIGGER IF EXISTS ci_reauth_stale_epoch_guard
  ON orbicore_ci_shadow.reauth_drafts;
CREATE TRIGGER ci_reauth_stale_epoch_guard
BEFORE INSERT ON orbicore_ci_shadow.reauth_drafts
FOR EACH ROW EXECUTE FUNCTION orbicore_ci_shadow.reject_stale_reauth_insert();

-- Dedicated CI reconciler can only invalidate drafts, never create or read
-- a verifier. Fixture marker blocks unapproved real account data. The caller
-- is responsible for verifying an immutable SQLite outbox event.
CREATE OR REPLACE FUNCTION orbicore_ci_shadow.apply_source_epoch_invalidation(
  p_org TEXT,p_user TEXT,p_epoch BIGINT,p_event_id TEXT,p_reason TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $apply$
DECLARE
  v_user TEXT;
  v_epoch BIGINT;
  v_event_id TEXT;
BEGIN
  IF current_setting('orbicore.ci_shadow_fixture',TRUE)
       IS DISTINCT FROM 'enabled'
    OR p_org IS NULL OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR p_user IS NULL OR p_user !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR p_epoch IS NULL OR p_epoch < 2
    OR p_event_id IS NULL OR p_event_id !~ '^[0-9a-f]{64}$'
    OR p_reason IS NULL OR p_reason NOT IN
       ('password_reset','disabled','mfa_enrolled','role_revoked') THEN
    RETURN FALSE;
  END IF;

  SELECT u.id INTO v_user FROM public.users AS u
  WHERE u.organization_id=p_org AND u.id=p_user
    AND u.password_salt='ci_reauth_fixture_no_pg_login'
  FOR UPDATE OF u;
  IF v_user IS NULL THEN RETURN FALSE; END IF;

  SELECT f.confirmed_epoch,f.source_event_id
    INTO v_epoch,v_event_id
  FROM orbicore_ci_shadow.source_epoch_fences AS f
  WHERE f.organization_id=p_org AND f.user_id=p_user
  FOR UPDATE OF f;

  IF v_epoch IS NOT NULL AND v_epoch>=p_epoch THEN
    -- Same epoch but a different event is a conflict, not an idempotent ack.
    RETURN v_epoch>p_epoch OR v_event_id=p_event_id;
  END IF;

  INSERT INTO orbicore_ci_shadow.source_epoch_fences(
    organization_id,user_id,confirmed_epoch,source_event_id,reason
  ) VALUES(p_org,p_user,p_epoch,p_event_id,p_reason)
  ON CONFLICT(organization_id,user_id)
  DO UPDATE SET confirmed_epoch=EXCLUDED.confirmed_epoch,
    source_event_id=EXCLUDED.source_event_id,reason=EXCLUDED.reason,
    reconciled_at=clock_timestamp();

  UPDATE orbicore_ci_shadow.reauth_drafts AS d
    SET state='invalidated'
  WHERE d.organization_id=p_org AND d.user_id=p_user
    AND d.state='shadow_only' AND d.source_epoch < p_epoch;
  RETURN TRUE;
END $apply$;

REVOKE ALL ON FUNCTION orbicore_ci_shadow.reject_stale_reauth_insert()
  FROM PUBLIC,orbicore_ci_shadow_writer,orbicore_ci_shadow_reconciler,
  orbicore_ci_shadow_stager,orbicore_tenant_readonly,orbicore_synthetic_submitter;
REVOKE ALL ON FUNCTION orbicore_ci_shadow.apply_source_epoch_invalidation(
  TEXT,TEXT,BIGINT,TEXT,TEXT
) FROM PUBLIC,orbicore_ci_shadow_writer,orbicore_ci_shadow_reconciler,
       orbicore_ci_shadow_stager,orbicore_tenant_readonly,
       orbicore_synthetic_submitter;
REVOKE ALL ON SCHEMA orbicore_ci_shadow FROM orbicore_ci_shadow_reconciler;
GRANT USAGE ON SCHEMA orbicore_ci_shadow TO orbicore_ci_shadow_reconciler;
GRANT EXECUTE ON FUNCTION orbicore_ci_shadow.apply_source_epoch_invalidation(
  TEXT,TEXT,BIGINT,TEXT,TEXT
) TO orbicore_ci_shadow_reconciler;
COMMENT ON TABLE orbicore_ci_shadow.source_epoch_fences IS
  'CI-only monotonic reconciled source epoch; no verifier and no production login authority';
COMMIT;
