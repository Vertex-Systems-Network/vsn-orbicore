-- VSN ORBICORE PostgreSQL Target Schema (Parity with SQLite v6)
-- Prepared for ORB-016 / ORB-017 container & migration verification.

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  email TEXT NOT NULL UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  label TEXT NOT NULL,
  provider TEXT NOT NULL,
  host TEXT NOT NULL,
  username TEXT NOT NULL,
  health TEXT NOT NULL CHECK (health IN ('healthy', 'attention', 'offline')),
  used_bytes BIGINT NOT NULL,
  quota_bytes BIGINT NOT NULL,
  last_synced_at TIMESTAMPTZ,
  source TEXT NOT NULL CHECK (source IN ('mock_fixture', 'provider')),
  capability_profile TEXT NOT NULL DEFAULT 'cpanel_uapi_standard'
);

CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  kind TEXT NOT NULL,
  document_root TEXT NOT NULL,
  php_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'attention'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  type TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  idempotency_key TEXT UNIQUE,
  requested_by TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  result_json JSONB,
  error TEXT
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details_json JSONB NOT NULL,
  prev_hash TEXT,
  entry_hash TEXT
);

CREATE TABLE IF NOT EXISTS wp_site_state (
  site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  core_version TEXT NOT NULL DEFAULT '6.7.2',
  previous_core_version TEXT,
  pending_updates INTEGER NOT NULL DEFAULT 0,
  previous_pending_updates INTEGER,
  staging_url TEXT,
  staging_created_at TIMESTAMPTZ,
  last_restore_point_sha256 TEXT,
  last_action TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS secret_references (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cpanel_uapi_token', 's3_access_key', 'smtp_credential')),
  reference_uri TEXT NOT NULL,
  masked_preview TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  key_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);
