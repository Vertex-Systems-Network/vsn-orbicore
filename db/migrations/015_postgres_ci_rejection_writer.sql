-- ORB-004: CI-only role-restricted, tenant-bound synthetic signal quarantine.
-- Runtime app login and provider authorization remain SQLite; no production role.
BEGIN;
DO $guard$ BEGIN
 IF current_setting('orbicore.ci_signal_fixture',true)
   IS DISTINCT FROM 'enabled' THEN
   RAISE EXCEPTION 'ci_signal_writer_fixture_gate_required' USING ERRCODE='42501';
 END IF;
END $guard$;
DO $role$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles
   WHERE rolname='orbicore_ci_signal_recorder') THEN
  CREATE ROLE orbicore_ci_signal_recorder NOLOGIN NOINHERIT NOBYPASSRLS;
 ELSIF EXISTS(SELECT 1 FROM pg_catalog.pg_roles
   WHERE rolname='orbicore_ci_signal_recorder'
   AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit
        OR rolcreatedb OR rolcreaterole)) THEN
  RAISE EXCEPTION 'unsafe_ci_signal_recorder_role' USING ERRCODE='42501';
 END IF;
END $role$;
CREATE TABLE IF NOT EXISTS public.ci_signal_writer_scopes(
 principal_name NAME PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES public.organizations(id),
 registered_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.ci_signal_writer_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ci_signal_writer_scopes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.ci_signal_writer_scopes FROM PUBLIC,orbicore_ci_signal_recorder;
REVOKE ALL ON public.job_signal_rejections
 FROM PUBLIC,orbicore_ci_signal_recorder,orbicore_tenant_readonly;

-- session_user remains the authenticated login even after SET ROLE; a
-- caller-settable tenant-id GUC cannot switch scope. SQL runs as trusted owner.
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
   OR p_org IS NULL OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
   OR p_entry IS NULL OR p_entry !~ '^[0-9]{1,20}-[0-9]{1,20}$'
   OR p_reason IS NULL OR p_reason NOT IN
    ('tenant_mismatch','invalid_job_id','missing_job')
   OR p_worker IS NULL OR p_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
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

CREATE OR REPLACE FUNCTION public.orbicore_ci_inspect_signal_rejections(
 p_org TEXT,p_limit INTEGER
) RETURNS TABLE(
 reason TEXT,occurrences INTEGER,
 first_seen_at TIMESTAMPTZ,last_seen_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $body$
BEGIN
 IF current_setting('orbicore.ci_signal_fixture',true)
    IS DISTINCT FROM 'enabled'
   OR p_org IS NULL OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
   OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
   OR NOT EXISTS(
     SELECT 1 FROM public.ci_signal_writer_scopes AS s
     WHERE s.principal_name=session_user AND s.organization_id=p_org
   ) THEN
  RAISE EXCEPTION 'ci_signal_scope_denied' USING ERRCODE='42501';
 END IF;
 RETURN QUERY
  SELECT x.reason,x.occurrences,x.first_seen_at,x.last_seen_at
  FROM public.job_signal_rejections AS x WHERE x.organization_id=p_org
  ORDER BY x.last_seen_at DESC,x.redis_entry_id DESC LIMIT p_limit;
END $body$;

REVOKE ALL ON FUNCTION public.orbicore_ci_record_signal_rejection(
 TEXT,TEXT,TEXT,TEXT) FROM PUBLIC,orbicore_tenant_readonly;
REVOKE ALL ON FUNCTION public.orbicore_ci_inspect_signal_rejections(
 TEXT,INTEGER) FROM PUBLIC,orbicore_tenant_readonly;
GRANT USAGE ON SCHEMA public TO orbicore_ci_signal_recorder;
GRANT EXECUTE ON FUNCTION public.orbicore_ci_record_signal_rejection(
 TEXT,TEXT,TEXT,TEXT) TO orbicore_ci_signal_recorder;
GRANT EXECUTE ON FUNCTION public.orbicore_ci_inspect_signal_rejections(
 TEXT,INTEGER) TO orbicore_ci_signal_recorder;
COMMIT;
