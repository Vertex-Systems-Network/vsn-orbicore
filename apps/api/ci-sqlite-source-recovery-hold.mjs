import {
  assertSyntheticQuarantineWitness, signSyntheticQuarantineWitness,
} from "./ci-active-quarantine-reconcile.mjs";
import { readValidatedSyntheticActiveQuarantineSnapshot } from "./ci-active-job-quarantine.mjs";
import { rejectCiSourceRecoveryHold } from "./sqlite-recovery-hold.mjs";

// This opt-in action is restricted to disposable CI fixture SQLite databases.
// It writes one durable *source-side* hold marker; not a migration/worker API.
const CONSENT="ci_fixture_active_jobs_quarantine_no_replay";
function requireCiOnly(consent) {
  if(process.env.GITHUB_ACTIONS!=="true" ||
     process.env.ORBICORE_CI_ACTIVE_QUARANTINE!=="1" ||
     process.env.ORBICORE_CI_SOURCE_RECOVERY_HOLD!=="1" ||
     consent!==CONSENT) {
    throw new Error("ci_source_hold_explicit_disposable_gate_required");
  }
}
export function establishCiSyntheticSourceRecoveryHold({
  sqlite,witness,key,consent=null,
}={}) {
  requireCiOnly(consent);
  // Check the cryptographic witness before any SQLite input/output.
  assertSyntheticQuarantineWitness(witness,key);
  if(!sqlite || typeof sqlite.exec!=="function" ||
     typeof sqlite.prepare!=="function") throw new TypeError("sqlite_source_required");
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    rejectCiSourceRecoveryHold(sqlite);
    const rows=readValidatedSyntheticActiveQuarantineSnapshot(sqlite);
    const actual=signSyntheticQuarantineWitness(rows,key,witness.nonce);
    if (actual.count!==witness.count || actual.digest!==witness.digest ||
        actual.mac!==witness.mac) {
      throw new Error("ci_source_hold_signed_snapshot_mismatch");
    }
    // DDL and insertion share the exact source SQLite transaction. A process
    // kill before COMMIT rolls the marker back; a committed marker persists.
    sqlite.exec(
      "CREATE TABLE orbicore_ci_active_recovery_hold ("+
      "slot INTEGER PRIMARY KEY CHECK(slot=1),"+
      "scope TEXT NOT NULL CHECK(scope='ci_fixture_active_jobs_quarantine_no_replay'),"+
      "source_digest TEXT NOT NULL CHECK(length(source_digest)=64),"+
      "nonce TEXT NOT NULL CHECK(length(nonce)=32),"+
      "row_count INTEGER NOT NULL CHECK(row_count BETWEEN 1 AND 20)"+
      ") STRICT",
    );
    sqlite.prepare(
      "INSERT INTO orbicore_ci_active_recovery_hold ("+
      "slot,scope,source_digest,nonce,row_count) VALUES (1,?,?,?,?)",
    ).run(CONSENT,witness.digest,witness.nonce,witness.count);
    sqlite.exec("COMMIT");
    return Object.freeze({
      scope:"ci_only_durable_source_startup_recovery_hold",
      protectedRows:rows.length,
      sourceDigest:witness.digest,
      durableSQLiteMarker:true,
      executable:false,
      releaseSupported:false,
      replayAuthorized:false,
      postgresWrites:0,
      redisSignals:0,
      providerCalls:0,
    });
  }catch(error){
    sqlite.exec("ROLLBACK");
    throw error;
  }
}
