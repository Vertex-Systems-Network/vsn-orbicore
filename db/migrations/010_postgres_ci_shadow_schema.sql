-- ORB-005 Slice B: explicitly gated, synthetic-only shadow credential
-- *schema proof*. Does not verify passwords, issue sessions, import accounts,
-- or participate in default HTTP authentication. Apply in disposable CI only.
BEGIN;

DO $ci_only$
BEGIN
  IF current_setting('orbicore.ci_shadow_fixture', TRUE)
     IS DISTINCT FROM 'enabled' THEN
    RAISE EXCEPTION 'ci_shadow_schema_explicit_opt_in_required'
      USING ERRCODE = '42501';
  END IF;
END
$ci_only$;

-- Production credential storage will require its own reviewed migration,
-- crypto design and grant governance. These values are CI placeholders,
-- deliberately not usable verifiers.
CREATE SCHEMA IF NOT EXISTS orbicore_ci_shadow;
REVOKE ALL ON SCHEMA orbicore_ci_shadow FROM PUBLIC;

DO $role$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname='orbicore_ci_shadow_stager'
  ) THEN
    CREATE ROLE orbicore_ci_shadow_stager NOLOGIN NOINHERIT NOBYPASSRLS;
  ELSIF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname='orbicore_ci_shadow_stager'
      AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit)
  ) THEN
    RAISE EXCEPTION 'unsafe_existing_ci_shadow_role'
      USING ERRCODE='42501';
  END IF;
END
$role$;

CREATE TABLE IF NOT EXISTS orbicore_ci_shadow.credential_drafts (
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  credential_epoch BIGINT NOT NULL CHECK (credential_epoch >= 1),
  source_epoch BIGINT NOT NULL CHECK (source_epoch >= 1),
  fixture_marker TEXT NOT NULL
    CHECK (fixture_marker = 'ci_fixture_only_no_password'),
  kdf_profile TEXT NOT NULL
    CHECK (kdf_profile = 'ci_placeholder_not_a_verifier'),
  verifier_salt TEXT NOT NULL
    CHECK (verifier_salt ~ '^ci_fixture:[0-9a-f]{32}$'),
  verifier_digest TEXT NOT NULL
    CHECK (verifier_digest ~ '^ci_fixture:[0-9a-f]{64}$'),
  state TEXT NOT NULL
    CHECK (state IN ('shadow_only','invalidated')),
  idempotency_key TEXT NOT NULL
    CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ci_shadow_draft_pk
    PRIMARY KEY (organization_id, user_id, credential_epoch),
  CONSTRAINT ci_shadow_user_tenant_fk
    FOREIGN KEY (user_id, organization_id)
    REFERENCES public.users(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT ci_shadow_idempotency_unique
    UNIQUE (organization_id, idempotency_key)
);

-- At most one pending synthetic draft per user. Epoch changes and
-- invalidations require a later independently authorized writer design.
CREATE UNIQUE INDEX IF NOT EXISTS ci_shadow_one_pending_draft
  ON orbicore_ci_shadow.credential_drafts (organization_id, user_id)
  WHERE state='shadow_only';

-- Even if an administrator accidentally grants direct schema/table access,
-- non-BYPASSRLS roles see/modify zero rows: no permissive policies exist.
ALTER TABLE orbicore_ci_shadow.credential_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE orbicore_ci_shadow.credential_drafts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE orbicore_ci_shadow.credential_drafts
  FROM PUBLIC,orbicore_tenant_readonly,orbicore_synthetic_submitter,
  orbicore_ci_shadow_stager;
REVOKE ALL ON SCHEMA orbicore_ci_shadow
  FROM PUBLIC,orbicore_tenant_readonly,orbicore_synthetic_submitter,
  orbicore_ci_shadow_stager;

COMMENT ON TABLE orbicore_ci_shadow.credential_drafts IS
  'CI-only synthetic shadow metadata; no real password verifiers or runtime writes';

COMMIT;
