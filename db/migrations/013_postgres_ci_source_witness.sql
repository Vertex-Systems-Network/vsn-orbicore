-- ORB-005 CI-only independent witness for already-committed synthetic
-- source credential outbox events. It cannot authenticate users or prove that
-- an event omitted before witness capture ever existed.
BEGIN;
DO $guard$
BEGIN
 IF current_setting('orbicore.ci_shadow_fixture',TRUE)
    IS DISTINCT FROM 'enabled' THEN
  RAISE EXCEPTION 'ci_source_witness_opt_in_required'
    USING ERRCODE='42501';
 END IF;
END $guard$;

DO $roles$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname='orbicore_ci_source_witness_writer'
 ) THEN
  CREATE ROLE orbicore_ci_source_witness_writer
    NOLOGIN NOINHERIT NOBYPASSRLS;
 ELSIF EXISTS (
  SELECT 1 FROM pg_roles
  WHERE rolname='orbicore_ci_source_witness_writer'
    AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit)
 ) THEN
  RAISE EXCEPTION 'unsafe_ci_source_witness_role'
    USING ERRCODE='42501';
 END IF;
END $roles$;

CREATE TABLE IF NOT EXISTS orbicore_ci_shadow.source_event_witnesses (
 organization_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 source_epoch BIGINT NOT NULL CHECK(source_epoch>=2),
 event_id TEXT NOT NULL CHECK(event_id ~ '^[0-9a-f]{64}$'),
 origin_key_id TEXT NOT NULL CHECK(origin_key_id ~ '^[a-z][a-z0-9_-]{1,31}$'),
 origin_mac TEXT NOT NULL CHECK(origin_mac ~ '^[0-9a-f]{64}$'),
 actor_id TEXT NOT NULL,
 witnessed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT ci_witness_pk PRIMARY KEY(organization_id,user_id,source_epoch),
 CONSTRAINT ci_witness_unique_event UNIQUE(event_id),
 CONSTRAINT ci_witness_user_fk FOREIGN KEY(user_id,organization_id)
   REFERENCES public.users(id,organization_id) ON DELETE RESTRICT,
 CONSTRAINT ci_witness_actor_fk FOREIGN KEY(actor_id,organization_id)
   REFERENCES public.users(id,organization_id) ON DELETE RESTRICT
);
ALTER TABLE orbicore_ci_shadow.source_event_witnesses
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE orbicore_ci_shadow.source_event_witnesses
  FORCE ROW LEVEL SECURITY;
REVOKE ALL ON orbicore_ci_shadow.source_event_witnesses
 FROM PUBLIC,orbicore_tenant_readonly,orbicore_synthetic_submitter,
 orbicore_ci_shadow_stager,orbicore_ci_shadow_writer,
 orbicore_ci_shadow_reconciler,orbicore_ci_source_witness_writer;

-- The role gets EXECUTE on this fixed function, never INSERT/SELECT/DELETE
-- on the table. The function intentionally does NOT independently know the
-- source HMAC key: only the CI adapter attests event authenticity before
-- calling it. A compromised writer can forge a denial-only witness.
CREATE OR REPLACE FUNCTION orbicore_ci_shadow.anchor_source_event_witness(
 p_org TEXT,p_user TEXT,p_epoch BIGINT,p_event TEXT,
 p_key TEXT,p_mac TEXT,p_actor TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $body$
DECLARE v_existing RECORD;
BEGIN
 IF current_setting('orbicore.ci_shadow_fixture',TRUE)
    IS DISTINCT FROM 'enabled'
  OR p_org IS NULL OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_user IS NULL OR p_user !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_actor IS NULL OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_epoch IS NULL OR p_epoch<2
  OR p_event IS NULL OR p_event !~ '^[0-9a-f]{64}$'
  OR p_key IS NULL OR p_key !~ '^[a-z][a-z0-9_-]{1,31}$'
  OR p_mac IS NULL OR p_mac !~ '^[0-9a-f]{64}$' THEN
   RETURN FALSE;
 END IF;
 IF NOT EXISTS (
  SELECT 1 FROM public.users AS u
  JOIN public.users AS actor
    ON actor.id=p_actor AND actor.organization_id=u.organization_id
  WHERE u.id=p_user AND u.organization_id=p_org
    AND u.password_salt='ci_reauth_fixture_no_pg_login'
    AND actor.password_salt='ci_reauth_fixture_no_pg_login'
 ) THEN RETURN FALSE; END IF;

 INSERT INTO orbicore_ci_shadow.source_event_witnesses(
  organization_id,user_id,source_epoch,event_id,origin_key_id,origin_mac,actor_id
 ) VALUES(p_org,p_user,p_epoch,p_event,p_key,p_mac,p_actor)
 ON CONFLICT DO NOTHING;

 SELECT event_id,origin_key_id,origin_mac,actor_id
 INTO v_existing
 FROM orbicore_ci_shadow.source_event_witnesses AS w
 WHERE w.organization_id=p_org AND w.user_id=p_user
   AND w.source_epoch=p_epoch;
 RETURN FOUND AND v_existing.event_id=p_event
   AND v_existing.origin_key_id=p_key
   AND v_existing.origin_mac=p_mac
   AND v_existing.actor_id=p_actor;
END $body$;

REVOKE ALL ON FUNCTION orbicore_ci_shadow.anchor_source_event_witness(
 TEXT,TEXT,BIGINT,TEXT,TEXT,TEXT,TEXT
) FROM PUBLIC,orbicore_tenant_readonly,orbicore_synthetic_submitter,
  orbicore_ci_shadow_stager,orbicore_ci_shadow_writer,
  orbicore_ci_shadow_reconciler,orbicore_ci_source_witness_writer;
GRANT USAGE ON SCHEMA orbicore_ci_shadow TO orbicore_ci_source_witness_writer;
GRANT EXECUTE ON FUNCTION orbicore_ci_shadow.anchor_source_event_witness(
 TEXT,TEXT,BIGINT,TEXT,TEXT,TEXT,TEXT
) TO orbicore_ci_source_witness_writer;
COMMENT ON TABLE orbicore_ci_shadow.source_event_witnesses IS
 'CI-only PostgreSQL witnessed event metadata; no password, token, verifier or login authority';
COMMIT;
