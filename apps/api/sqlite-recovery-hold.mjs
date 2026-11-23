// A CI-only source-side marker is an explicit startup *deny*, not a recovery
// permit. Its presence alone is sufficient: malformed rows cannot bypass it.
// There is deliberately no automatic release, replay or migration API.
const TABLE = "orbicore_ci_active_recovery_hold";

export function rejectCiSourceRecoveryHold(sqlite) {
  if (!sqlite || typeof sqlite.prepare !== "function") {
    throw new TypeError("sqlite_source_required");
  }
  const found=sqlite.prepare(
    "SELECT type FROM sqlite_master WHERE name=? AND type IN ('table','view') LIMIT 1",
  ).get(TABLE);
  if (found) throw new Error("ci_sqlite_source_recovery_hold_manual_review_required");
  return true;
}
