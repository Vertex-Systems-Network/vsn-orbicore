-- ORB-004: CI-only authenticated wakeup -> exact PG outbox/Redis ID anchor.
-- Requires migrations 014-016, schema owner controls all function bodies.
BEGIN;
DO $gate$ BEGIN
 IF current_setting('orbicore.ci_worker_fixture',true)
   IS DISTINCT FROM 'enabled' THEN
  RAISE EXCEPTION 'ci_wakeup_anchor_fixture_gate_required'
    USING ERRCODE='42501';
 END IF;
END $gate$;

-- Migration 014's auto-named CHECK reason enum is deliberately extended.
-- A second execution replaces only this known migration-owned constraint.
ALTER TABLE public.job_signal_rejections
  DROP CONSTRAINT IF EXISTS job_signal_rejections_reason_check;
ALTER TABLE public.job_signal_rejections
  ADD CONSTRAINT job_signal_rejections_reason_check
  CHECK(reason IN(
    'tenant_mismatch','invalid_job_id','missing_job',
    'invalid_signature','outbox_mismatch'
  ));

-- Version the restricted existing function IN THIS new migration; migration
-- 015 remains immutable for old deployments. Existing function grants and
-- ownership are retained by CREATE OR REPLACE, PUBLIC stays revoked.
CREATE OR REPLACE FUNCTION public.orbicore_ci_record_signal_rejection(
 p_org TEXT,p_entry TEXT,p_reason TEXT,p_worker TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $body$
DECLARE v_seen TEXT;
BEGIN
 IF current_setting('orbicore.ci_signal_fixture',true)
   IS DISTINCT FROM 'enabled'
   OR p_org IS NULL OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}
-- THIS function independently verifies the job/outbox/Redis entry binding
-- committed in PostgreSQL and uses the authenticated login/tenant mapping
-- from migration 016. Replaying an old signed HMAC into a different Redis
-- XADD entry gets a different Redis ID and fails this exact comparison.
CREATE OR REPLACE FUNCTION public.orbicore_ci_worker_validate_wakeup(
 p_org TEXT,p_job TEXT,p_outbox UUID,p_redis_id TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $body$
BEGIN
 PERFORM public.orbicore_ci_worker_require_scope(p_org);
 IF p_job IS NULL OR p_job !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
   OR p_outbox IS NULL
   OR p_redis_id IS NULL OR
     p_redis_id !~ '^[0-9]{1,20}-[0-9]{1,20}$'
 THEN RETURN FALSE;END IF;
 RETURN EXISTS(
  SELECT 1 FROM public.job_outbox AS o
  WHERE o.organization_id=p_org AND o.job_id=p_job
    AND o.id=p_outbox AND o.redis_entry_id=p_redis_id
    AND o.published_at IS NOT NULL
 );
END $body$;
REVOKE ALL ON FUNCTION public.orbicore_ci_worker_validate_wakeup(
 TEXT,TEXT,UUID,TEXT) FROM PUBLIC,orbicore_tenant_readonly;
GRANT EXECUTE ON FUNCTION public.orbicore_ci_worker_validate_wakeup(
 TEXT,TEXT,UUID,TEXT) TO orbicore_ci_worker_gateway;
COMMIT;

   OR p_entry IS NULL OR p_entry !~ '^[0-9]{1,20}-[0-9]{1,20}
-- THIS function independently verifies the job/outbox/Redis entry binding
-- committed in PostgreSQL and uses the authenticated login/tenant mapping
-- from migration 016. Replaying an old signed HMAC into a different Redis
-- XADD entry gets a different Redis ID and fails this exact comparison.
CREATE OR REPLACE FUNCTION public.orbicore_ci_worker_validate_wakeup(
 p_org TEXT,p_job TEXT,p_outbox UUID,p_redis_id TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $body$
BEGIN
 PERFORM public.orbicore_ci_worker_require_scope(p_org);
 IF p_job IS NULL OR p_job !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
   OR p_outbox IS NULL
   OR p_redis_id IS NULL OR
     p_redis_id !~ '^[0-9]{1,20}-[0-9]{1,20}$'
 THEN RETURN FALSE;END IF;
 RETURN EXISTS(
  SELECT 1 FROM public.job_outbox AS o
  WHERE o.organization_id=p_org AND o.job_id=p_job
    AND o.id=p_outbox AND o.redis_entry_id=p_redis_id
    AND o.published_at IS NOT NULL
 );
END $body$;
REVOKE ALL ON FUNCTION public.orbicore_ci_worker_validate_wakeup(
 TEXT,TEXT,UUID,TEXT) FROM PUBLIC,orbicore_tenant_readonly;
GRANT EXECUTE ON FUNCTION public.orbicore_ci_worker_validate_wakeup(
 TEXT,TEXT,UUID,TEXT) TO orbicore_ci_worker_gateway;
COMMIT;

   OR p_reason IS NULL OR p_reason NOT IN
    ('tenant_mismatch','invalid_job_id','missing_job',
      'invalid_signature','outbox_mismatch')
   OR p_worker IS NULL OR p_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}
-- THIS function independently verifies the job/outbox/Redis entry binding
-- committed in PostgreSQL and uses the authenticated login/tenant mapping
-- from migration 016. Replaying an old signed HMAC into a different Redis
-- XADD entry gets a different Redis ID and fails this exact comparison.
CREATE OR REPLACE FUNCTION public.orbicore_ci_worker_validate_wakeup(
 p_org TEXT,p_job TEXT,p_outbox UUID,p_redis_id TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $body$
BEGIN
 PERFORM public.orbicore_ci_worker_require_scope(p_org);
 IF p_job IS NULL OR p_job !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
   OR p_outbox IS NULL
   OR p_redis_id IS NULL OR
     p_redis_id !~ '^[0-9]{1,20}-[0-9]{1,20}$'
 THEN RETURN FALSE;END IF;
 RETURN EXISTS(
  SELECT 1 FROM public.job_outbox AS o
  WHERE o.organization_id=p_org AND o.job_id=p_job
    AND o.id=p_outbox AND o.redis_entry_id=p_redis_id
    AND o.published_at IS NOT NULL
 );
END $body$;
REVOKE ALL ON FUNCTION public.orbicore_ci_worker_validate_wakeup(
 TEXT,TEXT,UUID,TEXT) FROM PUBLIC,orbicore_tenant_readonly;
GRANT EXECUTE ON FUNCTION public.orbicore_ci_worker_validate_wakeup(
 TEXT,TEXT,UUID,TEXT) TO orbicore_ci_worker_gateway;
COMMIT;

 THEN RETURN FALSE; END IF;
 IF NOT EXISTS(
   SELECT 1 FROM public.ci_signal_writer_scopes AS s
   WHERE s.principal_name=session_user AND s.organization_id=p_org
 ) THEN RETURN FALSE;END IF;
 INSERT INTO public.job_signal_rejections(
   organization_id,redis_entry_id,reason,worker_id
 ) VALUES(p_org,p_entry,p_reason,p_worker)
 ON CONFLICT(organization_id,redis_entry_id) DO UPDATE
  SET occurrences=job_signal_rejections.occurrences+1,
      last_seen_at=clock_timestamp()
  WHERE job_signal_rejections.reason=EXCLUDED.reason
 RETURNING redis_entry_id INTO v_seen;
 RETURN v_seen IS NOT NULL;
END $body$;


REVOKE ALL ON FUNCTION public.orbicore_ci_record_signal_rejection(
 TEXT,TEXT,TEXT,TEXT) FROM PUBLIC,orbicore_tenant_readonly;

-- HMAC verifies in the Node CI fixture with ephemeral in-memory key.
-- THIS function independently verifies the job/outbox/Redis entry binding
-- committed in PostgreSQL and uses the authenticated login/tenant mapping
-- from migration 016. Replaying an old signed HMAC into a different Redis
-- XADD entry gets a different Redis ID and fails this exact comparison.
CREATE OR REPLACE FUNCTION public.orbicore_ci_worker_validate_wakeup(
 p_org TEXT,p_job TEXT,p_outbox UUID,p_redis_id TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $body$
BEGIN
 PERFORM public.orbicore_ci_worker_require_scope(p_org);
 IF p_job IS NULL OR p_job !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
   OR p_outbox IS NULL
   OR p_redis_id IS NULL OR
     p_redis_id !~ '^[0-9]{1,20}-[0-9]{1,20}$'
 THEN RETURN FALSE;END IF;
 RETURN EXISTS(
  SELECT 1 FROM public.job_outbox AS o
  WHERE o.organization_id=p_org AND o.job_id=p_job
    AND o.id=p_outbox AND o.redis_entry_id=p_redis_id
    AND o.published_at IS NOT NULL
 );
END $body$;
REVOKE ALL ON FUNCTION public.orbicore_ci_worker_validate_wakeup(
 TEXT,TEXT,UUID,TEXT) FROM PUBLIC,orbicore_tenant_readonly;
GRANT EXECUTE ON FUNCTION public.orbicore_ci_worker_validate_wakeup(
 TEXT,TEXT,UUID,TEXT) TO orbicore_ci_worker_gateway;
COMMIT;
