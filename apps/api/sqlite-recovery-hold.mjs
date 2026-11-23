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

// Connection-local trigger guards extend the CI hold to direct SQLite DML
// that bypasses the HTTP/worker transaction helpers. TEMP triggers are
// intentionally bound only to this application connection; they do not
// rewrite the source schema or interfere with a separate forensic auditor.
// A hold created by another connection is checked when each row is written.
export function installCiSourceHoldWriteGuards(sqlite) {
  if (!sqlite || typeof sqlite.prepare !== "function" || typeof sqlite.exec !== "function") {
    throw new TypeError("sqlite_source_required");
  }
  const tables = sqlite.prepare(
    "SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> ? ORDER BY name",
  ).all(TABLE);
  for (let i = 0; i < tables.length; i += 1) {
    // The name is SQLite schema data, not trusted source code.
    const tableName = '"' + tables[i].name.replaceAll('"', '""') + '"';
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      const triggerName = 'orbicore_ci_hold_' + i + '_' + operation.toLowerCase();
      sqlite.exec(`CREATE TEMP TRIGGER IF NOT EXISTS "${triggerName}"
        BEFORE ${operation} ON main.${tableName}
        WHEN EXISTS (
          SELECT 1 FROM main.sqlite_master
          WHERE name = '${TABLE}' AND type IN ('table', 'view')
        )
        BEGIN SELECT RAISE(ABORT, '${CI_SOURCE_RECOVERY_HOLD_ERROR}'); END`);
    }
  }
  return tables.length;
}
