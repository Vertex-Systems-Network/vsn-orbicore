// ORB-005: fixed-schema operational feature import used only from the
// CI-gated, offline synthetic full-snapshot transaction. This module NEVER
// opens its own DB transaction or makes hosting/provider requests.
export const FEATURE_TABLES = Object.freeze([
  "capability_snapshots",
  "migration_plans",
  "storage_policies",
  "site_snapshots",
  "automation_rules",
  "automation_runs",
  "wp_site_state",
]);

// All SQL table/column identifiers are hardcoded at module load, not caller
// data. JSON strings preserve the exact SQLite representation (not JSONB).
const FEATURE_COLUMNS = Object.freeze({
  capability_snapshots: [
    "id", "account_id", "organization_id", "profile_name",
    "capabilities_json", "source", "fetched_at",
  ],
  migration_plans: [
    "id", "organization_id", "site_id", "source_account_id",
    "target_account_id", "strategy", "state", "preflight_json",
    "checksum_sha256", "rollback_note", "blocker_reason", "created_by",
    "created_at", "updated_at", "checkpoint_percent", "failed_at_stage",
  ],
  storage_policies: [
    "id", "organization_id", "account_id", "mode", "target_endpoint",
    "target_bucket", "threshold_percent", "estimated_reclaim_bytes",
    "status", "created_by", "created_at", "last_drill_status", "last_drill_at",
  ],
  site_snapshots: [
    "id", "organization_id", "site_id", "action", "status",
    "checksum_sha256", "details_json", "created_by", "created_at",
  ],
  automation_rules: [
    "id", "organization_id", "name", "rule_type", "approval_mode",
    "daily_run_cap", "enabled", "last_run_at", "created_by", "created_at",
  ],
  automation_runs: [
    "id", "organization_id", "rule_id", "actor_id", "status",
    "summary_json", "created_at",
  ],
  wp_site_state: [
    "site_id", "organization_id", "core_version", "previous_core_version",
    "pending_updates", "previous_pending_updates", "staging_url",
    "staging_created_at", "last_restore_point_sha256", "last_action",
    "updated_at",
  ],
});
const BOOL_COLUMNS = Object.freeze({
  automation_rules: new Set(["enabled"]),
});

export async function insertSyntheticFeatureState({ client, source }) {
  if (!client || typeof client.query !== "function") {
    throw new TypeError("PostgreSQL transactional client required");
  }
  if (!source || FEATURE_TABLES.some((table) => !Array.isArray(source[table]))) {
    throw new TypeError("Complete synthetic feature-table snapshot required");
  }
  for (const table of FEATURE_TABLES) {
    const columns = FEATURE_COLUMNS[table];
    const placeholders = columns.map((_, i) => "$" + (i + 1)).join(", ");
    const statement = "INSERT INTO " + table + " (" + columns.join(", ") +
      ") VALUES (" + placeholders + ")";
    for (const row of source[table]) {
      const values = columns.map((column) => {
        const value = row[column];
        if (value === undefined) throw new Error("missing_feature_column:" + table + "." + column);
        return BOOL_COLUMNS[table]?.has(column) ? Boolean(value) : value;
      });
      await client.query(statement, values);
    }
  }
}
