// CI-only SQLite v7 migration-source provenance gate.
// These exact names mirror the seven schema_migrations records written by
// createDatabase in the local prototype. This does NOT apply PG migrations.
export const SQLITE_V7_MIGRATIONS = Object.freeze([
  "initial_inventory_auth",
  "preflight_contacts_capabilities_migrations_storage",
  "team_rbac_site_snapshots_restore_drill",
  "automation_rules_storage_drills_migration_checkpoints",
  "wordpress_lifecycle_staging_and_rollback",
  "audit_chain_and_job_recovery",
  "secret_references_and_deployment_readiness",
]);

export function validateSqliteV7Manifest(rows) {
  if (!Array.isArray(rows) || rows.length !== SQLITE_V7_MIGRATIONS.length) {
    throw new Error("sqlite_v7_migration_manifest_mismatch");
  }
  for (let index = 0; index < SQLITE_V7_MIGRATIONS.length; index += 1) {
    const row = rows[index];
    const time = row?.applied_at;
    if (row?.version !== index + 1 || row.name !== SQLITE_V7_MIGRATIONS[index] ||
        typeof time !== "string" || !Number.isFinite(Date.parse(time)) ||
        new Date(time).toISOString() !== time) {
      throw new Error("sqlite_v7_migration_manifest_mismatch");
    }
  }
  return Object.freeze({ supported:true, version:7, count:7 });
}

export function assertSupportedSqliteV7Manifest(sqlite) {
  if (!sqlite || typeof sqlite.prepare !== "function") {
    throw new TypeError("sqlite_source_required");
  }
  const rows = sqlite.prepare(
    "SELECT version,name,applied_at FROM schema_migrations ORDER BY version",
  ).all();
  return validateSqliteV7Manifest(rows);
}
