-- ORB-005: PostgreSQL tenant-linked operational feature state (SQLite v7 slice).
-- This additive migration is CI-verified with mock-only data. It does NOT
-- cut over the HTTP API, copy jobs, or authorize live provider actions.
-- Apply after 001-004; schema owner is required for DDL.
BEGIN;

-- PostgreSQL's original sites table had only account_id, which prevented
-- tenant-pinned site FKs on feature tables. Backfill any existing sites before
-- requiring a tenant on all future site writes.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS organization_id TEXT;
UPDATE sites s
SET organization_id = a.organization_id
FROM accounts a
WHERE s.account_id = a.id AND s.organization_id IS NULL;
ALTER TABLE sites ALTER COLUMN organization_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sites_id_organization_unique
  ON sites(id, organization_id);
DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='sites_account_tenant_fk'
      AND conrelid='sites'::regclass
  ) THEN
    ALTER TABLE sites ADD CONSTRAINT sites_account_tenant_fk
      FOREIGN KEY (account_id, organization_id)
      REFERENCES accounts(id, organization_id);
  END IF;
END
$guard$;

-- Existing site state now gets the same site/organization composite FK.
DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='wp_state_site_tenant_fk'
      AND conrelid='wp_site_state'::regclass
  ) THEN
    ALTER TABLE wp_site_state ADD CONSTRAINT wp_state_site_tenant_fk
      FOREIGN KEY(site_id, organization_id)
      REFERENCES sites(id, organization_id) ON DELETE CASCADE;
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS capability_snapshots (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  profile_name TEXT NOT NULL,
  capabilities_json TEXT NOT NULL CHECK (jsonb_typeof(capabilities_json::jsonb) = 'object'),
  source TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT capabilities_account_tenant_fk FOREIGN KEY(account_id, organization_id)
    REFERENCES accounts(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS capabilities_tenant_account
  ON capability_snapshots(organization_id, account_id, fetched_at);

CREATE TABLE IF NOT EXISTS migration_plans (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  site_id TEXT NOT NULL,
  source_account_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  strategy TEXT NOT NULL CHECK(strategy IN (
    'wordpress_optimized','generic_php','whm_account_package'
  )),
  state TEXT NOT NULL CHECK(state IN (
    'planned','preflight','snapshot','transfer','restore','verify',
    'ready_for_cutover','cutover','monitor','completed','blocked',
    'failed','rolled_back'
  )),
  preflight_json TEXT NOT NULL CHECK(jsonb_typeof(preflight_json::jsonb) = 'object'),
  checksum_sha256 TEXT,
  rollback_note TEXT,
  blocker_reason TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  checkpoint_percent INTEGER NOT NULL DEFAULT 0 CHECK(checkpoint_percent BETWEEN 0 AND 100),
  failed_at_stage TEXT,
  CONSTRAINT migration_site_tenant_fk FOREIGN KEY(site_id, organization_id)
    REFERENCES sites(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT migration_source_account_tenant_fk FOREIGN KEY(source_account_id, organization_id)
    REFERENCES accounts(id, organization_id),
  CONSTRAINT migration_target_account_tenant_fk FOREIGN KEY(target_account_id, organization_id)
    REFERENCES accounts(id, organization_id)
);
CREATE INDEX IF NOT EXISTS migrations_tenant_state
  ON migration_plans(organization_id, state, created_at);

CREATE TABLE IF NOT EXISTS storage_policies (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  account_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('media_offload','backup_archival','static_assets')),
  target_endpoint TEXT NOT NULL,
  target_bucket TEXT NOT NULL,
  threshold_percent INTEGER NOT NULL CHECK(threshold_percent BETWEEN 50 AND 99),
  estimated_reclaim_bytes BIGINT NOT NULL DEFAULT 0 CHECK(estimated_reclaim_bytes >= 0),
  status TEXT NOT NULL CHECK(status IN ('dry_run_only','paused')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  last_drill_status TEXT,
  last_drill_at TIMESTAMPTZ,
  CONSTRAINT storage_account_tenant_fk FOREIGN KEY(account_id, organization_id)
    REFERENCES accounts(id, organization_id)
);
CREATE INDEX IF NOT EXISTS storage_tenant_account
  ON storage_policies(organization_id, account_id);

CREATE TABLE IF NOT EXISTS site_snapshots (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  site_id TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  details_json TEXT NOT NULL CHECK(jsonb_typeof(details_json::jsonb) = 'object'),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT snapshot_site_tenant_fk FOREIGN KEY(site_id, organization_id)
    REFERENCES sites(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS snapshots_tenant_site
  ON site_snapshots(organization_id, site_id, created_at);

CREATE TABLE IF NOT EXISTS automation_rules (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  rule_type TEXT NOT NULL CHECK(rule_type IN (
    'inventory_stale_refresh','quota_threshold_alert','backup_snapshot_schedule'
  )),
  approval_mode TEXT NOT NULL CHECK(approval_mode IN ('manual_approval','dry_run_bounded')),
  daily_run_cap INTEGER NOT NULL DEFAULT 3 CHECK(daily_run_cap BETWEEN 1 AND 50),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS automation_rule_id_tenant_unique
  ON automation_rules(id, organization_id);
CREATE INDEX IF NOT EXISTS automation_rule_tenant_enabled
  ON automation_rules(organization_id, enabled);

CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  rule_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  status TEXT NOT NULL,
  summary_json TEXT NOT NULL CHECK(jsonb_typeof(summary_json::jsonb) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT automation_run_rule_tenant_fk FOREIGN KEY(rule_id, organization_id)
    REFERENCES automation_rules(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS automation_runs_tenant_rule
  ON automation_runs(organization_id, rule_id, created_at);

-- Protect all feature tables from a NOLOGIN read role by default; only grant
-- nonsecret metadata. Preflight JSON, endpoints/buckets, document roots,
-- snapshot details and secret references remain hidden.
DO $rls$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'capability_snapshots','migration_plans','storage_policies',
    'site_snapshots','automation_rules','automation_runs',
    'wp_site_state','secret_references'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    IF table_name <> 'secret_references' AND NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname=current_schema()
        AND tablename=table_name AND policyname='tenant_readonly_scope'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_readonly_scope ON %I FOR SELECT TO orbicore_tenant_readonly ' ||
        'USING (organization_id = NULLIF(current_setting(''orbicore.tenant_id'',true),''''))',
        table_name
      );
    END IF;
  END LOOP;
END
$rls$;

REVOKE ALL PRIVILEGES ON TABLE
  capability_snapshots, migration_plans, storage_policies, site_snapshots,
  automation_rules, automation_runs, wp_site_state, secret_references
  FROM orbicore_tenant_readonly;
-- Sites gained a tenant column; avoid leaking document_root through the
-- former table-level SELECT grant from migration 003.
REVOKE ALL PRIVILEGES ON TABLE sites FROM orbicore_tenant_readonly;
GRANT SELECT(id, organization_id, account_id, domain, kind, php_version, status)
  ON sites TO orbicore_tenant_readonly;
GRANT SELECT(id, organization_id, account_id, profile_name, source, fetched_at)
  ON capability_snapshots TO orbicore_tenant_readonly;
GRANT SELECT(id, organization_id, site_id, strategy, state, checkpoint_percent,
             created_at, updated_at)
  ON migration_plans TO orbicore_tenant_readonly;
GRANT SELECT(id, organization_id, account_id, mode, threshold_percent,
             status, created_at, last_drill_status, last_drill_at)
  ON storage_policies TO orbicore_tenant_readonly;
GRANT SELECT(id, organization_id, site_id, action, status, created_at)
  ON site_snapshots TO orbicore_tenant_readonly;
GRANT SELECT(id, organization_id, name, rule_type, approval_mode, daily_run_cap,
             enabled, last_run_at, created_at)
  ON automation_rules TO orbicore_tenant_readonly;
GRANT SELECT(id, organization_id, rule_id, status, created_at)
  ON automation_runs TO orbicore_tenant_readonly;
GRANT SELECT(site_id, organization_id, core_version, pending_updates,
             last_action, updated_at)
  ON wp_site_state TO orbicore_tenant_readonly;

COMMIT;
