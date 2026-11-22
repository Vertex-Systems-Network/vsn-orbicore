-- ORB-004 CI-only complete synthetic job execution gateway. No production
-- HTTP login, provider command, root/WHM operation or credential authority.
-- Requires 001,002,003,014,015 and a *separately provisioned* PG login.
BEGIN;
DO $gate$ BEGIN
 IF current_setting('orbicore.ci_worker_fixture',true)
   IS DISTINCT FROM 'enabled' THEN
  RAISE EXCEPTION 'ci_worker_fixture_explicit_gate_required'
    USING ERRCODE='42501';
 END IF;
END $gate$;
DO $role$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles
  WHERE rolname='orbicore_ci_worker_gateway') THEN
   CREATE ROLE orbicore_ci_worker_gateway NOLOGIN NOINHERIT NOBYPASSRLS;
 ELSIF EXISTS(SELECT 1 FROM pg_catalog.pg_roles
  WHERE rolname='orbicore_ci_worker_gateway'
    AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit
      OR rolcreatedb OR rolcreaterole)) THEN
   RAISE EXCEPTION 'unsafe_ci_worker_gateway_role'
     USING ERRCODE='42501';
 END IF;
END $role$;
CREATE TABLE IF NOT EXISTS public.ci_worker_principal_scopes(
 principal_name NAME PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES public.organizations(id),
 registered_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.ci_worker_principal_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ci_worker_principal_scopes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ci_worker_principal_scopes
 FROM PUBLIC,orbicore_ci_worker_gateway;
REVOKE ALL ON TABLE public.jobs,public.job_outbox,public.accounts,
 public.users,public.organizations,public.audit_events,
 public.secret_references,public.job_signal_rejections,public.sessions
 FROM orbicore_ci_worker_gateway;

-- This *private* helper runs only as trusted schema owner when invoked from
-- the fixed functions below. session_user is the authenticated PG login even
-- after SET ROLE. A tenant_id GUC or caller-supplied org never establishes
-- authority on its own. No direct EXECUTE for CI worker or PUBLIC.
CREATE OR REPLACE FUNCTION public.orbicore_ci_worker_require_scope(
 p_org TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $body$
BEGIN
 IF current_setting('orbicore.ci_worker_fixture',true)
    IS DISTINCT FROM 'enabled'
   OR p_org IS NULL OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
   OR NOT EXISTS(
    SELECT 1 FROM public.ci_worker_principal_scopes AS s
    WHERE s.principal_name=session_user AND s.organization_id=p_org
   ) THEN
  RAISE EXCEPTION 'ci_worker_scope_denied' USING ERRCODE='42501';
 END IF;
END $body$;

-- Caller must BEGIN a SQL transaction, execute this function, publish to
-- Redis, mark that same outbox row, and COMMIT on the SAME PG connection.
-- FOR UPDATE SKIP LOCKED holds a row lock through that external send. If
-- Redis fails, the surrounding transaction ROLLBACK retains the PG intent.
CREATE OR REPLACE FUNCTION public.orbicore_ci_worker_pick_outbox(
 p_org TEXT
) RETURNS TABLE(outbox_id UUID, job_id TEXT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $body$
BEGIN
 PERFORM public.orbicore_ci_worker_require_scope(p_org);
 RETURN QUERY
 SELECT o.id,o.job_id FROM public.job_outbox AS o
 WHERE o.organization_id=p_org AND o.published_at IS NULL
 ORDER BY o.created_at,o.id FOR UPDATE OF o SKIP LOCKED LIMIT 1;
END $body$;

CREATE OR REPLACE FUNCTION public.orbicore_ci_worker_confirm_outbox(
 p_org TEXT,p_outbox UUID,p_redis_entry TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $body$
DECLARE v_id UUID;
BEGIN
 PERFORM public.orbicore_ci_worker_require_scope(p_org);
 IF p_outbox IS NULL OR p_redis_entry IS NULL OR
   p_redis_entry !~ '^[0-9]{1,20}-[0-9]{1,20}$' THEN RETURN FALSE;END IF;
 UPDATE public.job_outbox AS o
 SET published_at=clock_timestamp(),redis_entry_id=p_redis_entry,
     publish_attempts=o.publish_attempts+1
 WHERE o.organization_id=p_org AND o.id=p_outbox
   AND o.published_at IS NULL
 RETURNING o.id INTO v_id;
 RETURN v_id IS NOT NULL;
END $body$;

CREATE OR REPLACE FUNCTION public.orbicore_ci_worker_reconcile_outbox(
 p_org TEXT,p_older_seconds INTEGER
) RETURNS TABLE(job_id TEXT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $body$
BEGIN
 PERFORM public.orbicore_ci_worker_require_scope(p_org);
 IF p_older_seconds IS NULL OR
    p_older_seconds NOT BETWEEN 1 AND 86400 THEN
  RAISE EXCEPTION 'ci_worker_bad_reconcile_window' USING ERRCODE='22023';
 END IF;
 RETURN QUERY
 UPDATE public.job_outbox AS o
 SET published_at=NULL,redis_entry_id=NULL
 FROM public.jobs AS j
 WHERE o.job_id=j.id AND o.organization_id=j.organization_id
   AND o.organization_id=p_org
   AND o.published_at<clock_timestamp()-
     make_interval(secs=>p_older_seconds)
   AND (j.status='queued' OR
     (j.status='running' AND (j.lease_expires_at IS NULL OR
       j.lease_expires_at<=clock_timestamp())))
 RETURNING o.job_id;
END $body$;

-- No account/user/passkey/session/password fields may be read by workers.
-- This narrow existence/status probe returns only the tenant's job status.
CREATE OR REPLACE FUNCTION public.orbicore_ci_worker_job_status(
 p_org TEXT,p_job TEXT
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $body$
DECLARE v_state TEXT;
BEGIN
 PERFORM public.orbicore_ci_worker_require_scope(p_org);
 IF p_job IS NULL OR p_job !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
 THEN RETURN NULL;END IF;
 SELECT j.status INTO v_state FROM public.jobs AS j
 WHERE j.organization_id=p_org AND j.id=p_job;
 RETURN v_state;
END $body$;

-- Claim strictly the signaled job, never an arbitrary next job. Lease UUID
-- is regenerated per attempt and future completion must match that token.
CREATE OR REPLACE FUNCTION public.orbicore_ci_worker_claim_signaled(
 p_org TEXT,p_job TEXT,p_worker TEXT,p_lease_seconds INTEGER
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $body$
DECLARE v_token UUID;
BEGIN
 PERFORM public.orbicore_ci_worker_require_scope(p_org);
 IF p_job IS NULL OR p_job !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
   OR p_worker IS NULL OR p_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
   OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 1 AND 3600
 THEN RAISE EXCEPTION 'ci_worker_bad_claim' USING ERRCODE='22023';END IF;
 UPDATE public.jobs AS j
 SET status='running',attempts=j.attempts+1,
   started_at=clock_timestamp(),lease_owner=p_worker,
   lease_token=gen_random_uuid(),
   lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds)
 WHERE j.organization_id=p_org AND j.id=p_job
   AND j.attempts<j.max_attempts
   AND (j.status='queued' OR
     (j.status='running' AND (j.lease_expires_at IS NULL OR
       j.lease_expires_at<=clock_timestamp())))
 RETURNING j.lease_token INTO v_token;
 RETURN v_token;
END $body$;

-- Atomic policy recheck *inside the same transaction as completion*. Lock
-- the job, its account, and the source PostgreSQL actor to serialize against
-- revocation/tenant transfer. Result JSON is fixed synthetic data, not
-- supplied by Redis, a caller or an external provider.
CREATE OR REPLACE FUNCTION public.orbicore_ci_worker_finalize(
 p_org TEXT,p_job TEXT,p_token UUID
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $body$
DECLARE
 v_job RECORD;
 v_source TEXT;
 v_role TEXT;
 v_disabled BOOLEAN;
BEGIN
 PERFORM public.orbicore_ci_worker_require_scope(p_org);
 IF p_token IS NULL OR p_job IS NULL OR
   p_job !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
 THEN RAISE EXCEPTION 'ci_worker_bad_finalize' USING ERRCODE='22023';END IF;
 SELECT j.account_id,j.requested_by,j.type
 INTO v_job FROM public.jobs AS j
 WHERE j.organization_id=p_org AND j.id=p_job AND j.lease_token=p_token
   AND j.status='running' AND j.lease_expires_at>clock_timestamp()
 FOR UPDATE OF j;
 IF NOT FOUND THEN RETURN 'lost_lease';END IF;
 SELECT a.source INTO v_source FROM public.accounts AS a
 WHERE a.id=v_job.account_id AND a.organization_id=p_org
 FOR SHARE OF a;
 SELECT u.role,u.disabled INTO v_role,v_disabled
 FROM public.users AS u
 WHERE u.id=v_job.requested_by AND u.organization_id=p_org
 FOR SHARE OF u;
 IF v_job.type IS DISTINCT FROM 'inventory_refresh'
   OR v_source IS DISTINCT FROM 'mock_fixture'
   OR v_disabled IS DISTINCT FROM FALSE
   OR v_role IS NULL OR v_role NOT IN ('owner','admin','operator') THEN
  UPDATE public.jobs AS j SET
    status='failed',error='synthetic_policy_denied',
    completed_at=clock_timestamp(),lease_owner=NULL,
    lease_token=NULL,lease_expires_at=NULL
  WHERE j.organization_id=p_org AND j.id=p_job AND j.lease_token=p_token;
  RETURN 'policy_denied';
 END IF;
 UPDATE public.jobs AS j SET
  status='completed',completed_at=clock_timestamp(),error=NULL,
  result_json=jsonb_build_object(
    'source','mock_fixture','live',false,'accountId',v_job.account_id,
    'processedBy','synthetic_redis_worker'),
  lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
 WHERE j.organization_id=p_org AND j.id=p_job AND j.lease_token=p_token;
 RETURN 'completed';
END $body$;

CREATE OR REPLACE FUNCTION public.orbicore_ci_worker_fail_expired(
 p_org TEXT
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $body$
DECLARE v_count INTEGER;
BEGIN
 PERFORM public.orbicore_ci_worker_require_scope(p_org);
 UPDATE public.jobs AS j
 SET status='failed',error='lease_retry_exhausted',
     completed_at=clock_timestamp(),
     lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
 WHERE j.organization_id=p_org AND j.status='running'
   AND j.attempts>=j.max_attempts
   AND (j.lease_expires_at IS NULL OR
        j.lease_expires_at<=clock_timestamp());
 GET DIAGNOSTICS v_count=ROW_COUNT;
 RETURN v_count;
END $body$;

-- PostgreSQL has PUBLIC EXECUTE as default for new functions. Never commit
-- an interval in which arbitrary DB logins can invoke SECURITY DEFINER.
REVOKE ALL ON FUNCTION public.orbicore_ci_worker_require_scope(TEXT)
 FROM PUBLIC,orbicore_ci_worker_gateway;
REVOKE ALL ON FUNCTION public.orbicore_ci_worker_pick_outbox(TEXT)
 FROM PUBLIC;
REVOKE ALL ON FUNCTION public.orbicore_ci_worker_confirm_outbox(TEXT,UUID,TEXT)
 FROM PUBLIC;
REVOKE ALL ON FUNCTION public.orbicore_ci_worker_reconcile_outbox(TEXT,INTEGER)
 FROM PUBLIC;
REVOKE ALL ON FUNCTION public.orbicore_ci_worker_job_status(TEXT,TEXT)
 FROM PUBLIC;
REVOKE ALL ON FUNCTION public.orbicore_ci_worker_claim_signaled(TEXT,TEXT,TEXT,INTEGER)
 FROM PUBLIC;
REVOKE ALL ON FUNCTION public.orbicore_ci_worker_finalize(TEXT,TEXT,UUID)
 FROM PUBLIC;
REVOKE ALL ON FUNCTION public.orbicore_ci_worker_fail_expired(TEXT)
 FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO orbicore_ci_worker_gateway;
GRANT EXECUTE ON FUNCTION public.orbicore_ci_worker_pick_outbox(TEXT)
 TO orbicore_ci_worker_gateway;
GRANT EXECUTE ON FUNCTION public.orbicore_ci_worker_confirm_outbox(TEXT,UUID,TEXT)
 TO orbicore_ci_worker_gateway;
GRANT EXECUTE ON FUNCTION public.orbicore_ci_worker_reconcile_outbox(TEXT,INTEGER)
 TO orbicore_ci_worker_gateway;
GRANT EXECUTE ON FUNCTION public.orbicore_ci_worker_job_status(TEXT,TEXT)
 TO orbicore_ci_worker_gateway;
GRANT EXECUTE ON FUNCTION public.orbicore_ci_worker_claim_signaled(TEXT,TEXT,TEXT,INTEGER)
 TO orbicore_ci_worker_gateway;
GRANT EXECUTE ON FUNCTION public.orbicore_ci_worker_finalize(TEXT,TEXT,UUID)
 TO orbicore_ci_worker_gateway;
GRANT EXECUTE ON FUNCTION public.orbicore_ci_worker_fail_expired(TEXT)
 TO orbicore_ci_worker_gateway;

-- Reuse the already restricted metadata-only signal functions from 015.
-- Both their login->tenant map and this new map must be admin-registered.
GRANT EXECUTE ON FUNCTION public.orbicore_ci_record_signal_rejection(TEXT,TEXT,TEXT,TEXT)
 TO orbicore_ci_worker_gateway;
GRANT EXECUTE ON FUNCTION public.orbicore_ci_inspect_signal_rejections(TEXT,INTEGER)
 TO orbicore_ci_worker_gateway;
COMMIT;
