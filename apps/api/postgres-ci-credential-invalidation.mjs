import { randomBytes, scryptSync } from "node:crypto";

import { createCiSourceEventAttestor } from "./ci-source-event-attestation.mjs";

// ORB-005: CI-only durable SQLite outbox + PostgreSQL shadow invalidation.
// Normal HTTP login / password mutation paths intentionally do not import it.
const SOURCES = new Set(["password_reset", "disabled", "mfa_enrolled", "role_revoked"]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAIL = /^[^\s@]+@[^\s@]+\.(test|invalid)$/i;

function requireFixture() {
  if (process.env.GITHUB_ACTIONS !== "true" ||
      process.env.ORBICORE_CI_SYNTHETIC_REAUTH !== "1" ||
      process.env.ORBICORE_CI_SYNTHETIC_SHADOW_SCHEMA !== "1" ||
      process.env.ORBICORE_CI_SYNTHETIC_RECONCILE !== "1") {
    throw new Error("ci_shadow_reconciliation_explicit_gate_required");
  }
}
function requireSqlite(db) {
  if (!db || typeof db.exec !== "function" || typeof db.prepare !== "function")
    throw new TypeError("ci_reconciliation_requires_sqlite");
}
export function initializeCiSourceEpochJournal(sqlite) {
  requireFixture();
  requireSqlite(sqlite);
  // The fixture sidecar is never attached to default runtime credential writes.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ci_source_credential_epoch (
      user_id TEXT PRIMARY KEY REFERENCES users(id),
      epoch INTEGER NOT NULL CHECK(epoch>=1)
    );
    CREATE TABLE IF NOT EXISTS ci_source_credential_outbox (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE CHECK(length(event_id)=64),
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id),
      source_epoch INTEGER NOT NULL CHECK(source_epoch>=2),
      reason TEXT NOT NULL CHECK(reason IN
        ('password_reset','disabled','mfa_enrolled','role_revoked')),
      origin_key_id TEXT,
      origin_mac TEXT CHECK(origin_mac IS NULL OR length(origin_mac)=64),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','reconciled')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id,source_epoch)
    );
    CREATE INDEX IF NOT EXISTS ci_epoch_outbox_pending
      ON ci_source_credential_outbox(status,sequence);
  `);
}

export function changeCiSourceCredential({
  sqlite, userId, kind, newPassword, injectBeforeCommit=false,
  attestor,
} = {}) {
  requireFixture();
  requireSqlite(sqlite);
  if (typeof userId !== "string" || !IDENTIFIER.test(userId) ||
      !SOURCES.has(kind) ||
      (kind==="password_reset" &&
        (typeof newPassword !== "string" || newPassword.length < 8 ||
         newPassword.length > 256))) return false;
  let opened=false;
  try {
    sqlite.exec("BEGIN IMMEDIATE");
    opened=true;
    const identity=sqlite.prepare(
      "SELECT id,organization_id,email FROM users WHERE id=?",
    ).get(userId);
    const row=sqlite.prepare(
      "SELECT epoch FROM ci_source_credential_epoch WHERE user_id=?",
    ).get(userId);
    if (!identity || !IDENTIFIER.test(identity.organization_id) ||
        !MAIL.test(identity.email) || !row ||
        !Number.isSafeInteger(row.epoch) || row.epoch<1 ||
        row.epoch>=Number.MAX_SAFE_INTEGER) {
      sqlite.exec("ROLLBACK");opened=false;return false;
    }
    const nextEpoch=row.epoch+1;
    if (kind==="password_reset") {
      const salt=randomBytes(16).toString("hex");
      // Existing SQLite contract: hex text passed as UTF-8 scrypt salt.
      const hash=scryptSync(newPassword,salt,64).toString("hex");
      sqlite.prepare(
        "UPDATE users SET password_salt=?,password_hash=? WHERE id=?",
      ).run(salt,hash,userId);
    } else if (kind==="disabled") {
      sqlite.prepare("UPDATE users SET disabled=1 WHERE id=?").run(userId);
    } else if (kind==="mfa_enrolled") {
      // Test only: enrollment here does not provision or handle a real MFA key.
      sqlite.prepare("UPDATE users SET mfa_enabled=1 WHERE id=?").run(userId);
    } else if (kind==="role_revoked") {
      sqlite.prepare("UPDATE users SET role='viewer' WHERE id=?").run(userId);
    }
    sqlite.prepare(
      "UPDATE ci_source_credential_epoch SET epoch=? WHERE user_id=?",
    ).run(nextEpoch,userId);
    const id=randomBytes(32).toString("hex");
    if(process.env.ORBICORE_CI_SYNTHETIC_EVENT_ATTESTATION==="1" &&
       (!attestor || typeof attestor.sign!=="function"))
      throw new Error("ci_source_attestation_required");
    const signature=attestor?.sign({
      event_id:id,organization_id:identity.organization_id,
      user_id:userId,source_epoch:nextEpoch,reason:kind,
    });
    sqlite.prepare(
      "INSERT INTO ci_source_credential_outbox("+
      "event_id,organization_id,user_id,source_epoch,reason,"+
      "origin_key_id,origin_mac,status) "+
      "VALUES(?,?,?,?,?,?,?,'pending')",
    ).run(id,identity.organization_id,userId,nextEpoch,kind,
      signature?.originKeyId??null,signature?.originMac??null);
    if (injectBeforeCommit) throw new Error("ci_source_injected_before_commit");
    sqlite.exec("COMMIT");
    opened=false;
    return { userId, sourceEpoch:nextEpoch, reason:kind, eventId:id };
  } catch(error) {
    if(opened)try{sqlite.exec("ROLLBACK");}catch{/* preserve rejection */}
    if(error.message==="ci_source_injected_before_commit") throw error;
    throw new Error("ci_source_mutation_unavailable");
  }
}

export function createCiSourceEpochReconciler({sqlite,postgres,attestor}={}) {
  requireFixture();
  requireSqlite(sqlite);
  if(!postgres || typeof postgres.connect!=="function")
    throw new TypeError("ci_reconciliation_requires_restricted_postgres_pool");
  if(process.env.ORBICORE_CI_SYNTHETIC_EVENT_ATTESTATION==="1" &&
     (!attestor || typeof attestor.verify!=="function"))
    throw new Error("ci_source_attestation_required");

  async function reconcilePending({
    limit=100, order="asc", injectAfterPgCommit=false,
    injectBeforePgCommit=false,
  }={}) {
    if(!Number.isSafeInteger(limit)||limit<1||limit>100 ||
       !["asc","desc"].includes(order))
      throw new TypeError("invalid_ci_reconciliation_batch");
    // Only the order literal is interpolated. All event data is bound.
    const events=sqlite.prepare(
      "SELECT event_id,organization_id,user_id,source_epoch,reason,"+
      "origin_key_id,origin_mac "+
      "FROM ci_source_credential_outbox WHERE status='pending' "+
      "ORDER BY sequence "+(order==="desc"?"DESC":"ASC")+" LIMIT ?",
    ).all(limit);
    let reconciled=0;
    for(const e of events) {
      if(attestor && !attestor.verify(e))
        throw new Error("ci_reconciliation_source_event_mac_invalid");
      const identity=sqlite.prepare(
        "SELECT organization_id FROM users WHERE id=?",
      ).get(e.user_id);
      const current=sqlite.prepare(
        "SELECT epoch FROM ci_source_credential_epoch WHERE user_id=?",
      ).get(e.user_id);
      if (!identity || identity.organization_id!==e.organization_id ||
          !current || current.epoch<e.source_epoch) {
        throw new Error("ci_reconciliation_source_provenance_mismatch");
      }
      const client=await postgres.connect();
      let pgOpen=false;
      try {
        await client.query("BEGIN");
        pgOpen=true;
        await client.query("SET LOCAL ROLE orbicore_ci_shadow_reconciler");
        const result=await client.query(
          "SELECT orbicore_ci_shadow.apply_source_epoch_invalidation("+
          "$1,$2,$3,$4,$5) AS applied",
          [e.organization_id,e.user_id,e.source_epoch,e.event_id,e.reason],
        );
        if(result.rows[0]?.applied!==true)
          throw new Error("ci_shadow_invalidation_rejected");
        if(injectBeforePgCommit)
          throw new Error("ci_reconciliation_interrupted_before_pg_commit");
        await client.query("COMMIT");
        pgOpen=false;
      } catch {
        if(pgOpen)try{await client.query("ROLLBACK");}catch{/* fail closed */}
        throw new Error("ci_shadow_reconciliation_unavailable");
      } finally {
        client.release();
      }
      // Simulates crash between a confirmed PG commit and SQLite ack. Durable
      // SQLite event stays pending; a new process must safely replay it.
      if(injectAfterPgCommit)
        throw new Error("ci_reconciliation_interrupted_after_pg_commit");
      let sqliteOpen=false;
      try {
        sqlite.exec("BEGIN IMMEDIATE"); sqliteOpen=true;
        const update=sqlite.prepare(
          "UPDATE ci_source_credential_outbox SET status='reconciled' "+
          "WHERE event_id=? AND status='pending' AND EXISTS("+
          "SELECT 1 FROM ci_source_credential_epoch "+
          "WHERE user_id=? AND epoch>=?)",
        ).run(e.event_id,e.user_id,e.source_epoch);
        if(update.changes!==1)
          throw new Error("ci_reconciliation_ack_conflict");
        sqlite.exec("COMMIT");sqliteOpen=false;
        reconciled++;
      } catch {
        if(sqliteOpen)try{sqlite.exec("ROLLBACK");}catch{/* fail closed */}
        throw new Error("ci_reconciliation_ack_unavailable");
      }
    }
    return {reconciled, pending:sqlite.prepare(
      "SELECT COUNT(*) AS n FROM ci_source_credential_outbox "+
      "WHERE status='pending'",
    ).get().n};
  }
  return Object.freeze({reconcilePending});
}
