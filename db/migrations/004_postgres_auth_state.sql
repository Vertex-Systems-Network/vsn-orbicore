-- ORB-005: additive tenant-bound PostgreSQL auth-state schema.
-- This is NOT a deployment cutover or runtime identity-role grant.
-- All credential-bearing columns are inaccessible to the read-only proof role.
BEGIN;

CREATE TABLE IF NOT EXISTS passkeys (
  credential_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0 CHECK(counter >= 0),
  transports_json TEXT NOT NULL DEFAULT '[]'
    CHECK(jsonb_typeof(transports_json::jsonb) = 'array'),
  device_type TEXT NOT NULL,
  backed_up BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  CONSTRAINT passkeys_tenant_user_fk FOREIGN KEY(user_id, organization_id)
    REFERENCES users(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS passkeys_user_scope
  ON passkeys(organization_id, user_id);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  handle_hash TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  challenge TEXT NOT NULL,
  user_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('registration','login')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT webauthn_challenges_tenant_user_fk FOREIGN KEY(user_id, organization_id)
    REFERENCES users(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS webauthn_challenges_user_expiry
  ON webauthn_challenges(organization_id, user_id, expires_at);

CREATE TABLE IF NOT EXISTS authenticators (
  user_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  encrypted_secret TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  pending_expires_at TIMESTAMPTZ,
  last_totp_step BIGINT NOT NULL DEFAULT -1 CHECK(last_totp_step >= -1),
  CONSTRAINT authenticators_tenant_user_fk FOREIGN KEY(user_id, organization_id)
    REFERENCES users(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  user_id TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  code_hash TEXT NOT NULL,
  used_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, code_hash),
  CONSTRAINT recovery_codes_tenant_user_fk FOREIGN KEY(user_id, organization_id)
    REFERENCES users(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS login_challenges (
  token_hash TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT login_challenges_tenant_user_fk FOREIGN KEY(user_id, organization_id)
    REFERENCES users(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL,
  event TEXT NOT NULL,
  recipient TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  last_error TEXT,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ,
  CONSTRAINT notification_outbox_tenant_user_fk FOREIGN KEY(user_id, organization_id)
    REFERENCES users(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS notification_outbox_user_scope
  ON notification_outbox(organization_id, user_id, status);

CREATE TABLE IF NOT EXISTS recovery_contacts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  address TEXT NOT NULL,
  verified_at TIMESTAMPTZ,
  verification_token_hash TEXT,
  verification_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(user_id, channel),
  CONSTRAINT recovery_contacts_tenant_user_fk FOREIGN KEY(user_id, organization_id)
    REFERENCES users(id, organization_id) ON DELETE CASCADE
);

-- The source also has a global bootstrap-token table. Persist its schema
-- for parity, but never allow the synthetic importer to copy active tokens:
-- bootstrap authorization and deployment cutover are separate gates.
CREATE TABLE IF NOT EXISTS bootstrap_tokens (
  token_hash TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL
);

-- RLS is enabled for all tenant tables. No read role has unrestricted
-- access to recovery hashes, authenticator secrets, WebAuthn public-key
-- credential payloads, challenge tokens or notification recipients.
DO $rls$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'passkeys', 'webauthn_challenges', 'authenticators', 'recovery_codes',
    'login_challenges', 'notification_outbox', 'recovery_contacts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
  END LOOP;
END
$rls$;

-- Only minimal nonsecret metadata is visible to the proof role, with a
-- tenant read policy. The GUC is set solely by trusted CI transactions.
DO $rls$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'passkeys', 'notification_outbox', 'recovery_contacts'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname=current_schema()
      AND tablename=table_name AND policyname='tenant_readonly_scope') THEN
      EXECUTE format(
        'CREATE POLICY tenant_readonly_scope ON %I FOR SELECT ' ||
        'TO orbicore_tenant_readonly USING ' ||
        '(organization_id = NULLIF(current_setting(''orbicore.tenant_id'', true), ''''))',
        table_name
      );
    END IF;
  END LOOP;
END
$rls$;

REVOKE ALL PRIVILEGES ON TABLE passkeys, webauthn_challenges, authenticators,
  recovery_codes, login_challenges, notification_outbox, recovery_contacts,
  bootstrap_tokens FROM orbicore_tenant_readonly;
GRANT SELECT (organization_id, user_id, device_type, backed_up, created_at, last_used_at)
  ON TABLE passkeys TO orbicore_tenant_readonly;
GRANT SELECT (organization_id, user_id, event, status, attempts, created_at, updated_at)
  ON TABLE notification_outbox TO orbicore_tenant_readonly;
GRANT SELECT (organization_id, user_id, channel, verified_at, created_at)
  ON TABLE recovery_contacts TO orbicore_tenant_readonly;

COMMIT;
