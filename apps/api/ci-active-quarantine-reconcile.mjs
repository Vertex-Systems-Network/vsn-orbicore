import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readValidatedSyntheticActiveQuarantineSnapshot } from "./ci-active-job-quarantine.mjs";

// An optional, detached CI-only witness for already quarantined *metadata*.
// It cannot authorize execution or replace production-grade key custody.
const SCOPE = "ci_only_synthetic_active_quarantine_witness_v1";
const CONSENT = "ci_fixture_active_jobs_quarantine_no_replay";
const HEX64 = /^[a-f0-9]{64}$/;
const HEX32 = /^[a-f0-9]{32}$/;
const FIELDS = ["version", "scope", "nonce", "count", "digest", "mac"];
const fixed = (count, digest, nonce) => JSON.stringify([1, SCOPE, nonce, count, digest]);

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length < 32) {
    throw new TypeError("ci_quarantine_witness_key_32_bytes_required");
  }
}
function requireCiGate(consent) {
  if (process.env.GITHUB_ACTIONS !== "true" ||
      process.env.ORBICORE_CI_ACTIVE_QUARANTINE !== "1" ||
      consent !== CONSENT) {
    throw new Error("ci_active_quarantine_explicit_gate_required");
  }
}
function digestRows(rows) {
  // All rows come from the strict source validator; avoid arbitrary JSON or
  // copying result payloads, emails, error messages or provider credentials.
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 20 ||
      rows.some(row => typeof row?.id !== "string" || !HEX64.test(row?.digest))) {
    throw new Error("ci_quarantine_witness_rows_invalid");
  }
  const sorted = [...rows].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (sorted.some((row,i) => i > 0 && row.id === sorted[i-1].id)) {
    throw new Error("ci_quarantine_witness_rows_invalid");
  }
  return createHash("sha256").update(
    JSON.stringify(sorted.map(row => [row.id, row.digest])),
  ).digest("hex");
}

// Pure helper for deterministic unit tests; caller must supply already
// validated CI fixture records and keep the signer key out of artifacts.
export function signSyntheticQuarantineWitness(rows, key, nonce = randomBytes(16).toString("hex")) {
  assertKey(key);
  if (typeof nonce !== "string" || !HEX32.test(nonce)) {
    throw new Error("ci_quarantine_witness_nonce_invalid");
  }
  const digest = digestRows(rows);
  const count = rows.length;
  const mac = createHmac("sha256", key).update(fixed(count,digest,nonce)).digest("hex");
  return Object.freeze({version:1,scope:SCOPE,nonce,count,digest,mac});
}

export function assertSyntheticQuarantineWitness(witness, key) {
  assertKey(key);
  if (!witness || typeof witness !== "object" || Array.isArray(witness) ||
      Object.keys(witness).length !== FIELDS.length ||
      FIELDS.some(field => !Object.hasOwn(witness,field)) ||
      witness.version !== 1 || witness.scope !== SCOPE ||
      !Number.isInteger(witness.count) || witness.count < 1 || witness.count > 20 ||
      typeof witness.nonce !== "string" || !HEX32.test(witness.nonce) ||
      typeof witness.digest !== "string" || !HEX64.test(witness.digest) ||
      typeof witness.mac !== "string" || !HEX64.test(witness.mac)) {
    throw new Error("ci_quarantine_witness_invalid");
  }
  const expected = createHmac("sha256", key).update(
    fixed(witness.count,witness.digest,witness.nonce),
  ).digest();
  if (!timingSafeEqual(Buffer.from(witness.mac,"hex"),expected)) {
    throw new Error("ci_quarantine_witness_mac_mismatch");
  }
  return true;
}

function validateSqliteAndPg(sqlite, postgres) {
  if (!sqlite || typeof sqlite.exec !== "function" || typeof sqlite.prepare !== "function" ||
      !postgres || typeof postgres.connect !== "function") {
    throw new TypeError("sqlite_and_pg_clients_required");
  }
}
function sourceMatchesWitness(rows, witness) {
  if (rows.length !== witness.count || digestRows(rows) !== witness.digest) {
    throw new Error("ci_quarantine_source_checkpoint_mismatch");
  }
}

// Explicitly creates a witness before staging; no PG writes. The caller stores
// the signed witness independently and the HMAC key only in trusted CI memory.
export function createSyntheticActiveQuarantineWitness({sqlite, consent=null, key}) {
  requireCiGate(consent);
  assertKey(key);
  if (!sqlite || typeof sqlite.exec !== "function" || typeof sqlite.prepare !== "function") {
    throw new TypeError("sqlite_source_required");
  }
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    return signSyntheticQuarantineWitness(
      readValidatedSyntheticActiveQuarantineSnapshot(sqlite), key,
    );
  } finally {
    sqlite.exec("ROLLBACK");
  }
}

function assertPgMatchesSource(pgRows, source) {
  if (!Array.isArray(pgRows) || pgRows.length !== source.length) {
    throw new Error("ci_quarantine_postgres_parity_mismatch");
  }
  const sorted = [...source].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (let i=0;i<sorted.length;i++) {
    const row=pgRows[i], expected=sorted[i];
    if (!row ||
        row.source_job_id !== expected.id ||
        row.organization_id !== expected.organizationId ||
        row.account_id !== expected.accountId ||
        row.requested_by !== expected.requestedBy ||
        row.source_status !== expected.status ||
        row.idempotency_key !== expected.idempotencyKey ||
        row.created_at?.toISOString?.() !== expected.createdAt ||
        (row.started_at === null ? null : row.started_at?.toISOString?.()) !== expected.startedAt ||
        row.metadata_sha256 !== expected.digest) {
      throw new Error("ci_quarantine_postgres_parity_mismatch");
    }
  }
}

// Read-only reconciliation only. Active work remains *quarantined*, with no
// Redis/outbox event, no job execution and no privilege granted to workers.
export async function reconcileSyntheticActiveQuarantine({
  sqlite, postgres, witness, key, consent=null,
}) {
  requireCiGate(consent);
  // Authenticate the detached witness *before* reading either database.
  assertSyntheticQuarantineWitness(witness,key);
  validateSqliteAndPg(sqlite,postgres);
  sqlite.exec("BEGIN IMMEDIATE");
  let client, opened=false;
  try {
    const source = readValidatedSyntheticActiveQuarantineSnapshot(sqlite);
    sourceMatchesWitness(source,witness); // no PG access on source drift
    client = await postgres.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    opened = true;
    const result=await client.query(
      "SELECT source_job_id,organization_id,account_id,requested_by,source_status," +
      "idempotency_key,created_at,started_at,metadata_sha256 " +
      "FROM orbicore_ci_quarantine.active_jobs ORDER BY source_job_id",
    );
    assertPgMatchesSource(result.rows,source);
    const other=await client.query(
      "SELECT (SELECT COUNT(*) FROM public.organizations) AS organizations, " +
      "(SELECT COUNT(*) FROM public.users) AS users, " +
      "(SELECT COUNT(*) FROM public.accounts) AS accounts, " +
      "(SELECT COUNT(*) FROM public.jobs) AS jobs, " +
      "(SELECT COUNT(*) FROM public.job_outbox) AS outbox",
    );
    if (!other.rows?.[0] || Object.values(other.rows[0]).some(v=>Number(v)!==0)) {
      throw new Error("ci_quarantine_public_tables_not_empty");
    }
    return Object.freeze({
      scope:"ci_only_signed_active_quarantine_readonly_reconciliation",
      matched:source.length,sourceDigest:witness.digest,
      executable:false,replayed:false,postgresWrites:0,
    });
  } finally {
    if (client) {
      if (opened) {
        try { await client.query("ROLLBACK"); } catch { /* close read-only transaction */ }
      }
      client.release();
    }
    sqlite.exec("ROLLBACK");
  }
}
