import { createHmac, randomBytes } from "node:crypto";

// ORB-005 CI-only login-failure telemetry fixture. Never import from default
// HTTP login. Keys are supplied only in memory by an external custodian; no
// password, submitted account name, tenant, user ID or IP may be persisted.
const KEY_ID = /^[a-z][a-z0-9_-]{1,31}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const EMAIL_ASCII = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

export const GENERIC_BAD_CREDENTIALS = Object.freeze({
  status: 401, error: "invalid_credentials",
});
export const GENERIC_AUTH_LIMITED = Object.freeze({
  status: 429, error: "auth_rate_limited",
});

export function requireCiFailureAudit() {
  if (process.env.GITHUB_ACTIONS !== "true" ||
      process.env.ORBICORE_CI_SYNTHETIC_FAILURE_AUDIT !== "1") {
    throw new Error("ci_keyed_auth_failure_gate_required");
  }
}

export function initializeCiAuthFailureAudit(sqlite) {
  requireCiFailureAudit();
  if (!sqlite || typeof sqlite.exec !== "function")
    throw new TypeError("ci_auth_failure_sqlite_required");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ci_auth_failure_events(
      event_id TEXT PRIMARY KEY CHECK(length(event_id)=32),
      identity_key_id TEXT NOT NULL,
      identity_digest TEXT NOT NULL CHECK(length(identity_digest)=64),
      occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms>=0),
      outcome TEXT NOT NULL
        CHECK(outcome IN ('invalid_credentials','auth_rate_limited'))
    );
    CREATE INDEX IF NOT EXISTS ci_auth_failure_window
      ON ci_auth_failure_events(identity_key_id,identity_digest,occurred_at_ms);
    CREATE INDEX IF NOT EXISTS ci_auth_failure_active
      ON ci_auth_failure_events(occurred_at_ms,identity_key_id);
  `);
}

// Deliberately conservative. An invalid/oversized identifier uses the same
// "malformed" keyed bucket without copying untrusted text to log or SQL.
export function canonicalCiAuthIdentifier(identifier) {
  if(typeof identifier!=="string" || identifier.length>254)
    return "malformed";
  const normalized=identifier.trim().toLowerCase();
  if(!EMAIL_ASCII.test(normalized) || normalized.includes("..") ||
     normalized.includes("@.") || normalized.includes(".@"))
    return "malformed";
  return normalized;
}

function checkedKeys({ activeKey, previousKeys = [] } = {}) {
  if(!activeKey || !Array.isArray(previousKeys) || previousKeys.length>2)
    throw new TypeError("ci_failure_audit_keyring_invalid");
  const supplied=[activeKey,...previousKeys];
  const found=new Set();
  const keys=supplied.map(k=>{
    if (!k || typeof k.id!=="string" || !KEY_ID.test(k.id) ||
        !Buffer.isBuffer(k.bytes) || k.bytes.length<32 ||
        found.has(k.id)) throw new TypeError("ci_failure_audit_keyring_invalid");
    found.add(k.id);
    // Freeze a private copy. The caller's buffer cannot mutate the key.
    return {id:k.id,bytes:Buffer.from(k.bytes)};
  });
  return keys;
}

export function createCiKeyedAuthFailureAudit({
  sqlite,activeKey,previousKeys=[],maxFailures=3,
  windowMs=5*60*1000,now=()=>Date.now(),
}={}){
  requireCiFailureAudit();
  if(!sqlite || typeof sqlite.prepare!=="function" ||
     typeof sqlite.exec!=="function")
    throw new TypeError("ci_failure_audit_sqlite_required");
  if(!Number.isSafeInteger(maxFailures)||maxFailures<1||maxFailures>100 ||
     !Number.isSafeInteger(windowMs)||windowMs<1000||
     windowMs>24*60*60*1000 || typeof now!=="function")
    throw new TypeError("ci_failure_audit_limits_invalid");
  const keys=checkedKeys({activeKey,previousKeys});

  function pseudonym(key,canonical) {
    return createHmac("sha256",key.bytes)
      .update("orbicore:ci:login-failure:v1\0","utf8")
      .update(canonical,"utf8").digest("hex");
  }

  function recordRejected({identifier}={}){
    const at=now();
    if(!Number.isSafeInteger(at)||at<windowMs)
      throw new Error("ci_failure_audit_clock_invalid");
    const canonical=canonicalCiAuthIdentifier(identifier);
    const aliases=keys.map(key=>({id:key.id,digest:pseudonym(key,canonical)}));
    const cutoff=at-windowMs;
    let open=false;
    try{
      sqlite.exec("BEGIN IMMEDIATE");
      open=true;
      // If a key disappeared while its events are still in the live window,
      // never silently reset the quota. Custody failure denies all attempts.
      const recentKeys=sqlite.prepare(
        "SELECT DISTINCT identity_key_id FROM ci_auth_failure_events "+
        "WHERE occurred_at_ms>?",
      ).all(cutoff);
      if(recentKeys.some(r=>!keys.some(k=>k.id===r.identity_key_id)))
        throw new Error("ci_failure_audit_rotation_key_missing");
      const clauses=aliases.map(()=>
        "(identity_key_id=? AND identity_digest=?)").join(" OR ");
      const bindings=aliases.flatMap(a=>[a.id,a.digest]);
      const attempts=sqlite.prepare(
        "SELECT COUNT(*) AS n FROM ci_auth_failure_events "+
        "WHERE occurred_at_ms>? AND ("+clauses+")",
      ).get(cutoff,...bindings).n;
      const rejected=attempts>=maxFailures
        ?GENERIC_AUTH_LIMITED:GENERIC_BAD_CREDENTIALS;
      sqlite.prepare(
        "INSERT INTO ci_auth_failure_events "+
        "(event_id,identity_key_id,identity_digest,occurred_at_ms,outcome) "+
        "VALUES(?,?,?,?,?)",
      ).run(
        randomBytes(16).toString("hex"),aliases[0].id,aliases[0].digest,
        at,rejected.error,
      );
      sqlite.exec("COMMIT");
      open=false;
      return rejected;
    }catch{
      if(open)try{sqlite.exec("ROLLBACK");}catch{/* deny on failure */}
      // No private identifiers, SQL error, key ID or row contents returned.
      throw new Error("ci_auth_failure_audit_unavailable");
    }
  }
  return Object.freeze({recordRejected});
}
