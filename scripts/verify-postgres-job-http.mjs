import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import { createApp } from "../apps/api/server.mjs";
import { createPostgresJobRepository } from "../apps/api/postgres-jobs.mjs";

// Injected, synthetic HTTP integration proof. No production job runner enabled.
const { default: pg } = await import("pg");
const pool = new pg.Pool({
  host: process.env.PGHOST ?? "127.0.0.1",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "orbicore",
  database: process.env.PGDATABASE ?? "orbicore",
  password: process.env.PGPASSWORD,
  connectionTimeoutMillis: 5_000,
  max: 3,
});
const repository = createPostgresJobRepository(pool);
const bootstrapToken = "http-postgres-bridge-bootstrap-token-32bytes";
const app = createApp({
  dbPath: ":memory:",
  startWorker: false,
  bootstrapToken,
  jobRepository: repository,
});
let base = "";
const call = async (path, { method = "GET", cookie = "", body, key } = {}) => {
  const headers = { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}),
    ...(key ? { "idempotency-key": key } : {}) };
  const response = await fetch(base + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { code: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
};
try {
  // Account data is still synthetic SQLite; seed just the matching fixtures
  // into this disposable Postgres instance. This is not production sync.
  await pool.query(
    "INSERT INTO organizations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
    ["org-demo", "Synthetic integration organization"],
  );
  for (const id of ["acct-copperline", "acct-northstar"]) {
    const row = app.db.prepare("SELECT * FROM accounts WHERE id = ? AND organization_id = ?").get(id, "org-demo");
    assert.ok(row, "fixture account exists in SQLite");
    await pool.query(
      "INSERT INTO accounts (id, organization_id, label, provider, host, username, health, used_bytes, quota_bytes, source) " +
      "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING",
      [row.id, row.organization_id, row.label, row.provider, row.host, row.username, row.health,
        row.used_bytes, row.quota_bytes, "mock_fixture"],
    );
  }

  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  base = "http://127.0.0.1:" + app.server.address().port;
  const boot = await call("/api/auth/bootstrap", {
    method: "POST",
    body: { token: bootstrapToken, email: "owner@example.test", password: "synthetic-owner-password-12345" },
  });
  assert.equal(boot.code, 201);
  const owner = boot.cookie;
  assert.ok(owner);
  assert.equal((await call("/api/jobs")).code, 401);
  assert.equal((await call("/api/jobs/refresh", {
    method: "POST", body: { accountId: "acct-copperline" },
  })).code, 401);

  const first = await call("/api/jobs/refresh", {
    method: "POST", cookie: owner, body: { accountId: "acct-copperline" }, key: "pg-http-one",
  });
  assert.equal(first.code, 202);
  assert.equal(first.body.jobStorage, "postgres_test_only");
  const jobId = first.body.jobId;
  assert.ok(jobId);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count, 0,
    "test-only PostgreSQL mode must not enqueue SQLite jobs");
  const row = await pool.query("SELECT status, organization_id, account_id FROM jobs WHERE id = $1", [jobId]);
  assert.equal(row.rows[0].status, "queued");
  assert.equal(row.rows[0].organization_id, "org-demo");
  assert.equal(row.rows[0].account_id, "acct-copperline");

  const duplicate = await call("/api/jobs/refresh", {
    method: "POST", cookie: owner, body: { accountId: "acct-copperline" }, key: "pg-http-one",
  });
  assert.equal(duplicate.code, 200);
  assert.equal(duplicate.body.status, "existing");
  assert.equal(duplicate.body.jobId, jobId);

  const conflict = await call("/api/jobs/refresh", {
    method: "POST", cookie: owner, body: { accountId: "acct-northstar" }, key: "pg-http-one",
  });
  assert.equal(conflict.code, 409);
  assert.equal(conflict.body.error, "idempotency_conflict");

  const list = await call("/api/jobs", { cookie: owner });
  assert.equal(list.code, 200);
  assert.equal(list.body.jobs.length, 1);
  assert.equal(list.body.jobs[0].accountLabel, "Copperline Commerce");
  assert.equal(list.body.jobs[0].status, "queued");
  const detail = await call("/api/jobs/" + encodeURIComponent(jobId), { cookie: owner });
  assert.equal(detail.code, 200);
  assert.equal(detail.body.job.id, jobId);
  assert.equal(detail.body.job.status, "queued");
  const overview = await call("/api/overview", { cookie: owner });
  assert.equal(overview.code, 200);
  assert.equal(overview.body.jobs[0].id, jobId);

  const salt = randomBytes(16).toString("hex");
  const viewerPassword = "synthetic-viewer-password-12345";
  app.db.prepare(
    "INSERT INTO users (id, organization_id, email, password_salt, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, 'viewer', ?)",
  ).run("viewer-ci", "org-demo", "viewer@example.test", salt,
    scryptSync(viewerPassword, salt, 64).toString("hex"), new Date().toISOString());
  // A second authorized operator may not replay another requester's key.
  const operatorSalt = randomBytes(16).toString("hex");
  const operatorPassword = "synthetic-operator-password-12345";
  app.db.prepare(
    "INSERT INTO users (id, organization_id, email, password_salt, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, 'operator', ?)",
  ).run("operator-ci", "org-demo", "operator@example.test", operatorSalt,
    scryptSync(operatorPassword, operatorSalt, 64).toString("hex"), new Date().toISOString());
  const operatorLogin = await call("/api/auth/login", {
    method: "POST", body: { email: "operator@example.test", password: operatorPassword },
  });
  assert.equal(operatorLogin.code, 200);
  const actorConflict = await call("/api/jobs/refresh", {
    method: "POST", cookie: operatorLogin.cookie, body: { accountId: "acct-copperline" }, key: "pg-http-one",
  });
  assert.equal(actorConflict.code, 409);
  assert.equal(actorConflict.body.error, "idempotency_conflict");
  assert.equal(Number((await pool.query("SELECT COUNT(*) AS count FROM jobs WHERE organization_id = $1", ["org-demo"])).rows[0].count), 1);

  const viewerLogin = await call("/api/auth/login", {
    method: "POST", body: { email: "viewer@example.test", password: viewerPassword },
  });
  assert.equal(viewerLogin.code, 200);
  const viewer = viewerLogin.cookie;
  assert.equal((await call("/api/jobs", { cookie: viewer })).body.jobs.length, 1);
  assert.equal((await call("/api/jobs/refresh", {
    method: "POST", cookie: viewer, body: { accountId: "acct-copperline" }, key: "viewer",
  })).code, 403);

  app.db.prepare("INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)").run(
    "org-other", "Unrelated tenant", new Date().toISOString());
  const otherSalt = randomBytes(16).toString("hex");
  const otherPassword = "synthetic-other-password-12345";
  app.db.prepare(
    "INSERT INTO users (id, organization_id, email, password_salt, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, 'owner', ?)",
  ).run("other-ci", "org-other", "other@example.test", otherSalt,
    scryptSync(otherPassword, otherSalt, 64).toString("hex"), new Date().toISOString());
  const otherLogin = await call("/api/auth/login", {
    method: "POST", body: { email: "other@example.test", password: otherPassword },
  });
  assert.equal(otherLogin.code, 200);
  const other = otherLogin.cookie;
  assert.equal((await call("/api/jobs", { cookie: other })).body.jobs.length, 0);
  assert.equal((await call("/api/jobs/" + jobId, { cookie: other })).code, 404);
  assert.equal((await call("/api/overview", { cookie: other })).body.jobs.length, 0);

  // A test harness claims/completes directly through the repository;
  // the running ORBICORE API does NOT yet execute PostgreSQL jobs.
  const claimed = await repository.claimNext({
    organizationId: "org-demo", workerId: "synthetic-http-test-worker",
  });
  assert.equal(claimed.jobId, jobId);
  assert.equal(await repository.complete({
    organizationId: "org-demo", jobId, claimToken: claimed.claimToken,
    result: { source: "mock_fixture", live: false, completedBy: "synthetic_test" },
  }), true);
  const finished = await call("/api/jobs/" + jobId, { cookie: owner });
  assert.equal(finished.code, 200);
  assert.equal(finished.body.job.status, "completed");
  assert.equal(finished.body.job.result.live, false);

  const audit = await call("/api/audit/verify", { cookie: owner });
  assert.equal(audit.code, 200);
  assert.equal(audit.body.valid, true);
  console.log(JSON.stringify({
    task: "ORB-004", kind: "authenticated-postgres-job-http",
    authAndRoleControls: "passed", tenantIsolation: "passed",
    postgresEnqueueViaHttp: "passed", idempotency: "passed",
    readAndOverviewViaHttp: "passed", auditChainVerification: "passed",
    simulationOnly: true, actualApplicationWorkerWired: false,
    postgresqlIdentityDatabase: false, redisNotificationConsumerWired: false,
    transactionalOutboxVerified: false,
  }));
} finally {
  app.close();
  await pool.end();
}
