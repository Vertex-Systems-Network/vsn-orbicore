import { createHash } from "node:crypto";
import { assertSupportedSqliteV7Manifest } from "./sqlite-v7-manifest.mjs";

// Synthetic-only safety checkpoint. This NEVER enqueues, claims, executes or
// restores SQLite active jobs. PostgreSQL storage is a CI-only private schema.
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CI_KEY = /^ci-queue-[A-Za-z0-9._:-]{1,100}$/;
const TEST_EMAIL = /@[^\s@]+\.(test|invalid)$/i;
const iso = value => typeof value === "string" &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function validateSyntheticActiveJobQuarantine(source) {
  if (!source || !Array.isArray(source.accounts) || !Array.isArray(source.users) ||
      !Array.isArray(source.jobs) || !Array.isArray(source.secretReferences)) {
    throw new TypeError("complete_active_source_snapshot_required");
  }
  if (source.secretReferences.length || source.accounts.some(account => account.source !== "mock_fixture") ||
      source.users.some(user => !TEST_EMAIL.test(user.email))) {
    throw new Error("nonfixture_active_source_refused");
  }
  if (source.jobs.length < 1 || source.jobs.length > 20) {
    throw new Error("active_fixture_job_count_refused");
  }
  const accounts = new Map(source.accounts.map(row => [row.id, row.organization_id]));
  const users = new Map(source.users.map(row => [row.id, row]));
  const seen = new Set();
  return source.jobs.map(row => {
    if (!row || !ID.test(row.id) || !ID.test(row.organization_id) ||
        !ID.test(row.account_id) || !ID.test(row.requested_by) ||
        row.type !== "inventory_refresh" ||
        !["queued", "running"].includes(row.status) ||
        !iso(row.created_at) || (row.started_at !== null && !iso(row.started_at)) ||
        row.completed_at !== null || row.result_json !== null || row.error !== null ||
        (row.status === "queued" && row.started_at !== null) ||
        (row.status === "running" &&
          (row.started_at === null || row.started_at < row.created_at)) ||
        typeof row.idempotency_key !== "string") {
      throw new Error("unsafe_active_job_shape_refused");
    }
    const prefix = row.organization_id + ":";
    const key = row.idempotency_key.startsWith(prefix)
      ? row.idempotency_key.slice(prefix.length) : row.idempotency_key;
    if (!CI_KEY.test(key) ||
        (row.idempotency_key !== key && row.idempotency_key !== prefix + key)) {
      throw new Error("unsafe_active_job_idempotency_key");
    }
    const user = users.get(row.requested_by);
    if (accounts.get(row.account_id) !== row.organization_id ||
        user?.organization_id !== row.organization_id ||
        user.disabled !== 0 || !["owner", "admin", "operator"].includes(user.role)) {
      throw new Error("active_job_tenant_or_actor_refused");
    }
    const scopedKey = row.organization_id + "\0" + row.idempotency_key;
    if (seen.has(row.id) || seen.has(scopedKey)) throw new Error("duplicate_active_job_refused");
    seen.add(row.id);
    seen.add(scopedKey);
    const record = Object.freeze({
      id:row.id, organizationId:row.organization_id,
      accountId:row.account_id, requestedBy:row.requested_by,
      status:row.status, idempotencyKey:row.idempotency_key,
      createdAt:row.created_at, startedAt:row.started_at,
    });
    const digest = createHash("sha256").update(JSON.stringify(record)).digest("hex");
    return Object.freeze({...record, digest});
  });
}

export async function stageSyntheticActiveJobQuarantine({
  sqlite, postgres, consent = null,
}) {
  // Both the runner environment and a distinct consent value are essential.
  if (process.env.GITHUB_ACTIONS !== "true" ||
      process.env.ORBICORE_CI_ACTIVE_QUARANTINE !== "1" ||
      consent !== "ci_fixture_active_jobs_quarantine_no_replay") {
    throw new Error("ci_active_quarantine_explicit_gate_required");
  }
  if (!sqlite || typeof sqlite.prepare !== "function" || typeof sqlite.exec !== "function" ||
      !postgres || typeof postgres.connect !== "function") {
    throw new TypeError("sqlite_and_pg_clients_required");
  }
  sqlite.exec("BEGIN IMMEDIATE");
  let client, open = false;
  try {
    assertSupportedSqliteV7Manifest(sqlite);
    const source = {
      accounts:sqlite.prepare("SELECT id, organization_id, source FROM accounts").all(),
      users:sqlite.prepare("SELECT id, organization_id, email, role, disabled FROM users").all(),
      jobs:sqlite.prepare(
        "SELECT id, organization_id, account_id, requested_by, type, status, " +
        "idempotency_key, created_at, started_at, completed_at, result_json, error " +
        "FROM jobs WHERE status IN ('queued','running') ORDER BY id",
      ).all(),
      secretReferences:sqlite.prepare("SELECT id FROM secret_references LIMIT 1").all(),
    };
    const rows = validateSyntheticActiveJobQuarantine(source);
    client = await postgres.connect();
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    open = true;
    await client.query("SELECT pg_advisory_xact_lock(564221, 6)");
    const occupied = await client.query(
      "SELECT (SELECT COUNT(*) FROM public.organizations) AS organizations, " +
      "(SELECT COUNT(*) FROM public.users) AS users, " +
      "(SELECT COUNT(*) FROM public.accounts) AS accounts, " +
      "(SELECT COUNT(*) FROM public.jobs) AS jobs, " +
      "(SELECT COUNT(*) FROM public.job_outbox) AS job_outbox, " +
      "(SELECT COUNT(*) FROM orbicore_ci_quarantine.active_jobs) AS quarantined",
    );
    if (Object.values(occupied.rows[0]).some(count => Number(count) !== 0)) {
      throw new Error("nonempty_quarantine_target_refused");
    }
    for (const row of rows) {
      await client.query(
        "INSERT INTO orbicore_ci_quarantine.active_jobs (" +
        "source_job_id, organization_id, account_id, requested_by, source_status, " +
        "idempotency_key, created_at, started_at, metadata_sha256) " +
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [row.id,row.organizationId,row.accountId,row.requestedBy,row.status,
         row.idempotencyKey,row.createdAt,row.startedAt,row.digest],
      );
    }
    const saved = await client.query(
      "SELECT source_job_id, organization_id, account_id, requested_by, source_status, " +
      "idempotency_key, created_at, started_at, metadata_sha256 " +
      "FROM orbicore_ci_quarantine.active_jobs ORDER BY source_job_id",
    );
    if (saved.rows.length !== rows.length) throw new Error("active_quarantine_parity_failed");
    const expected = [...rows].sort((a,b)=>a.id.localeCompare(b.id));
    for (let i=0;i<expected.length;i++) {
      const x=saved.rows[i], y=expected[i];
      if (x.source_job_id!==y.id || x.organization_id!==y.organizationId ||
          x.account_id!==y.accountId || x.requested_by!==y.requestedBy ||
          x.source_status!==y.status || x.idempotency_key!==y.idempotencyKey ||
          x.created_at?.toISOString()!==y.createdAt ||
          (x.started_at===null?null:x.started_at?.toISOString())!==y.startedAt ||
          x.metadata_sha256!==y.digest) {
        throw new Error("active_quarantine_parity_failed");
      }
    }
    const untouched = await client.query(
      "SELECT (SELECT COUNT(*) FROM public.jobs) AS jobs, " +
      "(SELECT COUNT(*) FROM public.job_outbox) AS outbox",
    );
    if (Number(untouched.rows[0].jobs) !== 0 || Number(untouched.rows[0].outbox) !== 0) {
      throw new Error("active_quarantine_runtime_job_mutation");
    }
    await client.query("COMMIT");
    open=false;
    return Object.freeze({
      scope:"ci_only_active_job_quarantine_metadata",
      count:rows.length, executable:false, replayed:false, sourceUnmodified:true,
    });
  } catch (error) {
    if (client && open) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original failure */ }
    }
    throw error;
  } finally {
    if (client) client.release();
    sqlite.exec("ROLLBACK");
  }
}
