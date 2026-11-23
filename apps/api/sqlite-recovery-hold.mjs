// A CI-only source-side marker is an explicit startup *deny*, not a recovery
// permit. Its presence alone is sufficient: malformed rows cannot bypass it.
// There is deliberately no automatic release, replay or migration API.
const TABLE = "orbicore_ci_active_recovery_hold";
export const CI_SOURCE_RECOVERY_HOLD_ERROR = "ci_sqlite_source_recovery_hold_manual_review_required";

export function rejectCiSourceRecoveryHold(sqlite) {
  if (!sqlite || typeof sqlite.prepare !== "function") {
    throw new TypeError("sqlite_source_required");
  }
  const found=sqlite.prepare(
    "SELECT type FROM sqlite_master WHERE name=? AND type IN ('table','view') LIMIT 1",
  ).get(TABLE);
  if (found) throw new Error(CI_SOURCE_RECOVERY_HOLD_ERROR);
  return true;
}

// Durable source-local SQLite triggers protect ordinary DML on *all*
// connections using this file, including ones that never called createApp.
// This is a CI-only safety net, not a DDL/administrator/WORM boundary.
// The transaction-owning initializer installs these while holding SQLite's
// BEGIN IMMEDIATE writer lock. A later committed hold marker fails all writes.
export function installCiSourceHoldWriteGuards(sqlite) {
  if (!sqlite || typeof sqlite.prepare !== "function" || typeof sqlite.exec !== "function") {
    throw new TypeError("sqlite_source_required");
  }
  rejectCiSourceRecoveryHold(sqlite);
  const tables = sqlite.prepare(
    "SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> ? ORDER BY name",
  ).all(TABLE);
  const existingTrigger = sqlite.prepare(
    "SELECT tbl_name AS tableName, sql FROM main.sqlite_master WHERE type='trigger' AND name=?",
  );
  for (const table of tables) {
    // Encode the *name*, not its sorted index: schema upgrades may add tables
    // before current ones. Names must remain stable after restart/upgrade.
    const stableId = Buffer.from(table.name, "utf8").toString("hex");
    const tableName = '"' + table.name.replaceAll('"', '""') + '"';
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      const triggerName = `orbicore_ci_hold_${stableId}_${operation.toLowerCase()}`;
      const triggerSql = `CREATE TRIGGER IF NOT EXISTS "${triggerName}"
        BEFORE ${operation} ON main.${tableName}
        WHEN EXISTS (
          SELECT 1 FROM main.sqlite_master
          WHERE name = '${TABLE}' AND type IN ('table', 'view')
        )
        BEGIN SELECT RAISE(ABORT, '${CI_SOURCE_RECOVERY_HOLD_ERROR}'); END`;
      const installed = existingTrigger.get(triggerName);
      // Do not silently reuse a same-name schema trigger with a different
      // table/denial contract after a malformed schema upgrade.
      if (installed && (
        installed.tableName !== table.name ||
        !installed.sql?.includes(`WHERE name = '${TABLE}'`) ||
        !installed.sql?.includes(`RAISE(ABORT, '${CI_SOURCE_RECOVERY_HOLD_ERROR}')`)
      )) throw new Error("ci_sqlite_source_guard_conflict");
      sqlite.exec(triggerSql);
    }
  }
  return tables.length;
}
