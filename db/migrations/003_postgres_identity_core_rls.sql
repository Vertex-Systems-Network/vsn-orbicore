-- ORB-005: additive PostgreSQL core identity/session and read-scoped tenant contract.
-- NOT a complete SQLite v7 parity migration, not a production cutover.
-- Must run under schema owner/operator with CREATEROLE; NOLOGIN role is CI-proof only.
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS users_id_organization_unique
  ON users (id, organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_casefold_unique
  ON users (lower(email));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  mfa_verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sessions_user_tenant_fk FOREIGN KEY (user_id, organization_id)
    REFERENCES users (id, organization_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS sessions_tenant_user_expiry
  ON sessions (organization_id, user_id, expires_at);

-- The existing SQLite SHA-256 chain hashes the *exact original JSON text*
-- (including key order). PostgreSQL jsonb canonicalization is not text-stable,
-- so preserve the source serialized JSON separately when importing audit rows.
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS details_raw_json TEXT;
DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'audit_details_raw_match'
      AND conrelid = 'audit_events'::regclass
  ) THEN
    ALTER TABLE audit_events ADD CONSTRAINT audit_details_raw_match
      CHECK (details_raw_json IS NULL OR details_raw_json::jsonb = details_json);
  END IF;
END
$guard$;

-- Read-only NOLOGIN proof role. Do not give untrusted callers direct SQL
-- sessions with an arbitrarily writable custom tenant GUC.
DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orbicore_tenant_readonly') THEN
    CREATE ROLE orbicore_tenant_readonly NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
END
$guard$;

DO $scopes$
DECLARE
  scoped_table TEXT;
  predicate TEXT;
BEGIN
  FOREACH scoped_table IN ARRAY ARRAY[
    'organizations','users','accounts','sites','jobs',
    'audit_events','job_outbox','sessions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', scoped_table);
    predicate := CASE scoped_table
      WHEN 'organizations' THEN
        'id = NULLIF(current_setting(''orbicore.tenant_id'', true), '''')'
      WHEN 'sites' THEN
        'EXISTS (SELECT 1 FROM accounts a WHERE a.id = account_id AND a.organization_id = NULLIF(current_setting(''orbicore.tenant_id'', true), ''''))'
      ELSE
        'organization_id = NULLIF(current_setting(''orbicore.tenant_id'', true), '''')'
    END;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = current_schema() AND tablename = scoped_table
        AND policyname = 'tenant_readonly_scope'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_readonly_scope ON %I FOR SELECT TO orbicore_tenant_readonly USING (%s)',
        scoped_table, predicate
      );
    END IF;
    EXECUTE format('GRANT SELECT ON TABLE %I TO orbicore_tenant_readonly', scoped_table);
  END LOOP;
END
$scopes$;

-- Avoid granting credential material via the read-only tenant role. The
-- policies above scope rows; column grants separately restrict disclosure.
REVOKE ALL PRIVILEGES ON TABLE users, sessions FROM orbicore_tenant_readonly;
GRANT SELECT (id, organization_id, email, role, disabled, mfa_enabled, created_at)
  ON TABLE users TO orbicore_tenant_readonly;
GRANT SELECT (organization_id, user_id, expires_at, mfa_verified, created_at)
  ON TABLE sessions TO orbicore_tenant_readonly;

COMMIT;
