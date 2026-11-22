import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { computeAuditEntryHash } from "../apps/api/audit.mjs";
import { createPostgresSyntheticSubmissionGateway } from "../apps/api/postgres-synthetic-gateway.mjs";

if (process.env.GITHUB_ACTIONS !== "true" ||
    process.env.ORBICORE_CI_SYNTHETIC_PG_WRITE !== "1") {
  throw new Error("synthetic_postgres_write_ci_only");
}

const pool = new Pool({
  host: process.env.PGHOST ?? "127.0.0.1",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "orbicore",
  database: process.env.PGDATABASE ?? "orbicore",
  password: process.env.PGPASSWORD,
  max: 10, connectionTimeoutMillis: 5000,
});
const gateway = createPostgresSyntheticSubmissionGateway(pool);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const orgA = "org-synthetic-gateway-a";
const orgB = "org-synthetic-gateway-b";
const acctA = "account-synthetic-a";
const acctB = "account-synthetic-b";
const acctA2 = "account-synthetic-a2";
const acctProvider = "account-synthetic-provider";
const ownerA = "owner-synthetic-a";
const ownerB = "owner-synthetic-b";
const owner2 = "owner-synthetic-a2";
const viewerA = "viewer-synthetic-a";
const disabledA = "disabled-synthetic-a";
const mfaA = "mfa-synthetic-a";
const expiredA = "expired-synthetic-a";
const TOKENS = Object.freeze({
  ownerA: hash("ci-session-owner-a"),
  ownerB: hash("ci-session-owner-b"),
  owner2: hash("ci-session-owner-2"),
  viewerA: hash("ci-session-viewer-a"),
  disabledA: hash("ci-session-disabled-a"),
  mfaA: hash("ci-session-mfa-a"),
  expiredA: hash("ci-session-expired-a"),
});
const readCount = async (table, predicate = "", params = []) =>
  Number((await pool.query(
    "SELECT COUNT(*)::int AS n FROM " + table + " " + predicate, params,
  )).rows[0].n);
const submit = (tokenHash, organizationId, accountId, idempotencyKey) =>
  gateway.enqueue({ tokenHash, organizationId, accountId, idempotencyKey });

async function restricted(role, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE " + role); // only two fixed test roles
    return await operation(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
async function expectDenied(operation, code = "42501") {
  await assert.rejects(operation, (error) =>
    error?.code === code,
  );
}

try {
  for (const [id, name] of [
    [orgA, "CI synthetic tenant A"], [orgB, "CI synthetic tenant B"],
  ]) await pool.query(
    "INSERT INTO organizations(id,name) VALUES($1,$2)", [id, name],
  );
  for (const row of [
    [ownerA, orgA, "owner-a@example.test", "owner", false, false],
    [ownerB, orgB, "owner-b@example.test", "owner", false, false],
    [owner2, orgA, "second-owner-a@example.test", "admin", false, false],
    [viewerA, orgA, "viewer-a@example.test", "viewer", false, false],
    [disabledA, orgA, "disabled-a@example.test", "admin", true, false],
    [mfaA, orgA, "mfa-a@example.test", "operator", false, true],
    [expiredA, orgA, "expired-a@example.test", "admin", false, false],
  ]) {
    const [id, tenant, email, role, disabled, mfa] = row;
    await pool.query(
      "INSERT INTO users(id,organization_id,email,password_salt,password_hash," +
      "role,disabled,mfa_enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [id, tenant, email, "ci-dummy-not-salt", "ci-dummy-not-a-password", role,
        disabled, mfa],
    );
  }
  for (const [id, org, source] of [
    [acctA, orgA, "mock_fixture"],
    [acctA2, orgA, "mock_fixture"],
    [acctB, orgB, "mock_fixture"],
    [acctProvider, orgA, "provider"],
  ]) await pool.query(
    "INSERT INTO accounts(id,organization_id,label,provider,host,username," +
    "health,used_bytes,quota_bytes,source) " +
    "VALUES ($1,$2,'CI only','mock','none.example.invalid','synthetic'," +
    "'healthy',0,1,$3)",
    [id, org, source],
  );
  for (const [id, token, org, expires] of [
    [ownerA, TOKENS.ownerA, orgA, "1 day"],
    [ownerB, TOKENS.ownerB, orgB, "1 day"],
    [owner2, TOKENS.owner2, orgA, "1 day"],
    [viewerA, TOKENS.viewerA, orgA, "1 day"],
    [disabledA, TOKENS.disabledA, orgA, "1 day"],
    [mfaA, TOKENS.mfaA, orgA, "1 day"],
    [expiredA, TOKENS.expiredA, orgA, "-1 day"],
  ]) await pool.query(
    "INSERT INTO sessions(token_hash,organization_id,user_id,expires_at," +
    "mfa_verified) VALUES($1,$2,$3,clock_timestamp()+$4::interval,FALSE)",
    [token, org, id, expires],
  );

  // Seed a real legacy-compatible audit head in a different transaction.
  // The new PostgreSQL gateway must link against it with the same Node SHA.
  const seedAt = "2026-11-22T00:00:00.000Z";
  const seedDetails = '{"fixture":true,"type":"setup"}';
  const seedHead = computeAuditEntryHash({
    prevHash: "GENESIS", organizationId: orgA, actor: ownerA,
    action: "auth.bootstrap", targetId: ownerA, outcome: "completed",
    detailsJson: seedDetails, createdAt: seedAt,
  });
  await pool.query(
    "INSERT INTO audit_events (id,organization_id,actor,action,target_id," +
    "outcome,created_at,details_json,details_raw_json,prev_hash,entry_hash) " +
    "VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)",
    [randomUUID(), orgA, ownerA, "auth.bootstrap", ownerA, "completed",
      seedAt, seedDetails, seedDetails, "GENESIS", seedHead],
  );

  // The restricted submitter can execute only the guarded function; the
  // read-only tenant role cannot call it. Neither role can directly DML.
  for (const sql of [
    "SELECT id FROM jobs",
    "SELECT token_hash FROM sessions",
    "SELECT password_hash FROM users",
    "SELECT encrypted_payload FROM secret_references",
    "INSERT INTO job_outbox(organization_id,job_id) VALUES('x','y')",
    "DELETE FROM jobs WHERE organization_id='org-synthetic-gateway-a'",
    "UPDATE users SET disabled = TRUE WHERE id='owner-synthetic-a'",
    "INSERT INTO audit_events(id,organization_id,actor,action,target_id,outcome,details_json)" +
      " VALUES('unauthorized','x','x','x','x','x','{}'::jsonb)",
  ]) await expectDenied(restricted("orbicore_synthetic_submitter",
    (client) => client.query(sql)));
  await expectDenied(restricted("orbicore_tenant_readonly", (client) =>
    client.query(
      "SELECT * FROM public.orbicore_submit_synthetic_inventory($1,$2,$3,$4)",
      [TOKENS.ownerA, orgA, acctA, "should-not-create"],
    )));

  // User- and tenant-controlled GUC values must never be treated as
  // authority. SQL function checks PG session/tenant/account itself.
  await expectDenied(restricted("orbicore_synthetic_submitter", async (client) => {
    await client.query("SELECT set_config('orbicore.tenant_id',$1,true)", [orgB]);
    return client.query(
      "SELECT * FROM public.orbicore_submit_synthetic_inventory($1,$2,$3,$4)",
      [TOKENS.ownerA, orgB, acctB, "spoof-cross-tenant"],
    );
  }));
  await expectDenied(submit(TOKENS.ownerA, orgA, acctB, "foreign-account"));
  await expectDenied(submit(TOKENS.ownerA, orgA, acctProvider, "provider-account"));
  await expectDenied(submit(TOKENS.viewerA, orgA, acctA, "viewer"));
  await expectDenied(submit(TOKENS.disabledA, orgA, acctA, "disabled"));
  await expectDenied(submit(TOKENS.mfaA, orgA, acctA, "unverified-mfa"));
  await expectDenied(submit(TOKENS.expiredA, orgA, acctA, "expired"));
  await expectDenied(submit(hash("no-such-session"), orgA, acctA, "unknown"));
  assert.equal(await readCount("jobs"), 0);
  assert.equal(await readCount("job_outbox"), 0);

  // A real PG MFA verification state is required, not a client boolean.
  await pool.query(
    "UPDATE sessions SET mfa_verified=TRUE WHERE token_hash=$1", [TOKENS.mfaA],
  );
  const mfaResult = await submit(TOKENS.mfaA, orgA, acctA, "mfa-verified");
  assert.equal(mfaResult.created, true);
  assert.equal(mfaResult.live, false);
  assert.equal(mfaResult.source, "mock_fixture");

  const first = await submit(TOKENS.ownerA, orgA, acctA, "idempotent-A");
  assert.equal(first.created, true);
  assert.ok(first.jobId);
  const duplicate = await submit(TOKENS.ownerA, orgA, acctA, "idempotent-A");
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.jobId, first.jobId);
  await expectDenied(submit(TOKENS.ownerA, orgA, acctA2, "idempotent-A"), "23505");
  await expectDenied(submit(TOKENS.owner2, orgA, acctA, "idempotent-A"), "23505");

  // Concurrent duplicates serialize via PostgreSQL uniqueness, not Redis or
  // the original SQLite store; only one audit and outbox record is generated.
  const sameKey = await Promise.all([
    submit(TOKENS.ownerA, orgA, acctA, "concurrent-A"),
    submit(TOKENS.ownerA, orgA, acctA, "concurrent-A"),
  ]);
  assert.equal(sameKey.filter(x=>x.created).length, 1);
  assert.equal(sameKey.filter(x=>!x.created).length, 1);
  assert.equal(sameKey[0].jobId, sameKey[1].jobId);
  const other = await submit(TOKENS.ownerB, orgB, acctB, "idempotent-A");
  assert.equal(other.created, true);
  assert.notEqual(other.jobId, first.jobId);

  const tenantJobs = await pool.query(
    "SELECT id,organization_id,account_id,requested_by,type,status," +
    "idempotency_key FROM jobs ORDER BY organization_id,id",
  );
  assert.equal(tenantJobs.rows.length, 4);
  assert.ok(tenantJobs.rows.every(row=>row.type==="inventory_refresh"
    && row.status==="queued" && /^[a-f0-9]{64}$/.test(row.idempotency_key)));
  assert.equal(await readCount("job_outbox"), 4);
  assert.equal(await readCount("audit_events", "WHERE action='job.enqueue'"), 4);
  assert.equal(await readCount("job_outbox", "WHERE organization_id=$1", [orgB]), 1);
  assert.equal(await readCount("jobs", "WHERE organization_id=$1", [orgB]), 1);
  assert.equal(await readCount("jobs", "WHERE account_id=$1", [acctProvider]), 0);
  const idempotencyJS = createHash("sha256")
    .update(orgA).update("\0").update("idempotent-A").digest("hex");
  assert.equal(tenantJobs.rows.find(x=>x.id===first.jobId).idempotency_key,
    idempotencyJS);

  // This SQL audit hash must round-trip with Node's existing SQLite canonical
  // array algorithm, including exact raw details text and UTC milliseconds.
  const audits = (await pool.query(
    "SELECT organization_id,actor,action,target_id,outcome,created_at," +
    "details_raw_json,prev_hash,entry_hash FROM audit_events " +
    "WHERE action='job.enqueue' ORDER BY created_at,id",
  )).rows;
  for (const event of audits) {
    assert.equal(event.details_raw_json,
      '{"source":"mock_fixture","live":false,"type":"inventory_refresh"}');
    const expected = computeAuditEntryHash({
      prevHash:event.prev_hash, organizationId:event.organization_id,
      actor:event.actor, action:event.action, targetId:event.target_id,
      outcome:event.outcome, detailsJson:event.details_raw_json,
      createdAt:event.created_at.toISOString(),
    });
    assert.equal(event.entry_hash, expected, "PG/SQLite hash mismatch");
  }
  assert.equal(audits.filter(x=>x.organization_id===orgA
    && x.prev_hash===seedHead).length, 1);

  // Fresh session revocation and user disabling must revoke the *function*
  // itself, including a previously-created idempotency key.
  await pool.query("DELETE FROM sessions WHERE token_hash=$1", [TOKENS.ownerA]);
  await expectDenied(submit(TOKENS.ownerA, orgA, acctA, "idempotent-A"));
  await pool.query("UPDATE users SET disabled=TRUE WHERE id=$1", [ownerB]);
  await expectDenied(submit(TOKENS.ownerB, orgB, acctB, "new-after-disable"));
  assert.equal(await readCount("jobs"), 4);

  // Insert failure in the LAST (audit) statement must roll back the new job
  // and outbox, not leave a partially queued work unit or unmapped audit.
  await pool.query(
    "ALTER TABLE audit_events ADD CONSTRAINT ci_reject_new_submission " +
    "CHECK (action <> 'job.enqueue')",
  ).catch(async(error)=>{
    // Existing rows already have this action; use NOT VALID constraint so it
    // applies to new rows only while preserving existing fixture history.
    if(error.code!=="23514")throw error;
    await pool.query(
      "ALTER TABLE audit_events ADD CONSTRAINT ci_reject_new_submission " +
      "CHECK (action <> 'job.enqueue') NOT VALID",
    );
  });
  const beforeJobs = await readCount("jobs");
  const beforeOutbox = await readCount("job_outbox");
  const beforeAudit = await readCount("audit_events");
  await expectDenied(submit(TOKENS.owner2, orgA, acctA2, "audit-rollback"), "23514");
  assert.equal(await readCount("jobs"), beforeJobs);
  assert.equal(await readCount("job_outbox"), beforeOutbox);
  assert.equal(await readCount("audit_events"), beforeAudit);
  await pool.query("ALTER TABLE audit_events DROP CONSTRAINT ci_reject_new_submission");

  // Idempotent migration rerun must not accidentally grant direct table DML.
  console.log(JSON.stringify({
    task:"ORB-005",type:"postgres-synthetic-session-authenticated-submission",
    source:"disposable-ci",live:false,
    authorizedActorsFromPostgresSessions:true,
    validatedMfaRoleTenantAccountAndMockSource:true,
    callerControlledTenantContextIgnored:true,
    restrictedNoLoginRoleHasNoTableAccess:true,
    rawProviderCredentials:false,
    pgJobs:await readCount("jobs"),
    pgOutbox:await readCount("job_outbox"),
    pgNewAuditEvents:await readCount("audit_events","WHERE action='job.enqueue'"),
    nodeCompatibleAuditHash:true,
    concurrentIdempotency:true,
    revokedSessionCannotReplay:true,
    disabledAccountDenied:true,
    lastStatementFailureRollsBackTransaction:true,
    productionDatabaseLoginVerified:false,
    httpRouteCutover:false,
    fullSQLiteV7Cutover:false,
    liveProviderActions:false,
  }));
} finally {
  await pool.end();
}
