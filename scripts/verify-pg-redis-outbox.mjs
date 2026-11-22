import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createApp } from "../apps/api/server.mjs";
import { createTransactionalOutboxJobRepository } from "../apps/api/transactional-outbox.mjs";
import { createSyntheticRedisJobRunner } from "../apps/api/synthetic-redis-worker.mjs";
import { Pool } from "pg";
import { createClient } from "redis";

const pool = new Pool({
  host: process.env.PGHOST ?? "127.0.0.1",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "orbicore",
  database: process.env.PGDATABASE ?? "orbicore",
  password: process.env.PGPASSWORD,
  connectionTimeoutMillis: 5000,
});
const redis = createClient({
  url: process.env.ORBICORE_CI_REDIS_URL ?? "redis://127.0.0.1:6379",
  disableOfflineQueue: true,
});
redis.on("error", () => {});
const organizationId = "org-demo";
const bootstrapToken = "ci-outbox-bootstrap-token-32bytes";
const repository = createTransactionalOutboxJobRepository(pool);
const app = createApp({
  dbPath: ":memory:",
  startWorker: false,
  bootstrapToken,
  jobRepository: repository,
});
const runner = createSyntheticRedisJobRunner({
  pool, redis, organizationId, workerId: "ci-outbox-worker", leaseSeconds: 5,
});
let child = null;
let base = "";
let cookie = "";

async function api(path, { method = "GET", body, key, auth = true } = {}) {
  const headers = {
    ...(auth && cookie ? { cookie } : {}),
    ...(body ? { "content-type": "application/json" } : {}),
    ...(key ? { "idempotency-key": key } : {}),
  };
  const response = await fetch(base + path, {
    method, headers, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json(), session: response.headers.get("set-cookie")?.split(";")[0] };
}

async function enqueue(key = randomUUID()) {
  const response = await api("/api/jobs/refresh", {
    method: "POST", body: { accountId: "acct-copperline" }, key,
  });
  assert.equal(response.status, 202);
  return response.data.jobId;
}

async function expectOnePending() {
  const result = await redis.sendCommand(["XPENDING", runner.stream, runner.group]);
  assert.equal(Number(result[0]), 1);
}
try {
  await redis.connect();
  await pool.query(
    "INSERT INTO organizations(id, name) VALUES ($1, 'Synthetic CI organization') ON CONFLICT(id) DO NOTHING",
    [organizationId],
  );
  const row = app.db.prepare("SELECT * FROM accounts WHERE id = 'acct-copperline'").get();
  await pool.query(
    "INSERT INTO accounts (id, organization_id, label, provider, host, username, health, used_bytes, quota_bytes, source) " +
    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'mock_fixture') ON CONFLICT(id) DO NOTHING",
    [row.id, row.organization_id, row.label, row.provider, row.host, row.username, row.health,
      row.used_bytes, row.quota_bytes],
  );
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  base = "http://127.0.0.1:" + app.server.address().port;
  const boot = await api("/api/auth/bootstrap", {
    method: "POST", auth: false,
    body: { token: bootstrapToken, email: "outbox-owner@example.test", password: "ci-only-owner-password-456" },
  });
  assert.equal(boot.status, 201);
  cookie = boot.session;
  const actor = app.db.prepare("SELECT * FROM users WHERE email = 'outbox-owner@example.test'").get();
  await pool.query(
    "INSERT INTO users(id, organization_id, email, password_salt, password_hash, role, disabled, mfa_enabled) " +
    "VALUES ($1,$2,$3,$4,$5,'owner',false,false)",
    [actor.id, actor.organization_id, actor.email, actor.password_salt, actor.password_hash],
  );

  // SQL failure during outbox creation must roll back its new job.
  await pool.query(
    "ALTER TABLE job_outbox ADD CONSTRAINT ci_forbid_one_job CHECK (job_id <> 'job-atomic-rollback')",
  );
  try {
    await assert.rejects(repository.enqueue({
      id: "job-atomic-rollback", organizationId, accountId: row.id, requestedBy: actor.id,
      idempotencyKey: "ci-atomic-rollback",
    }), /check constraint/i);
    assert.equal((await pool.query("SELECT id FROM jobs WHERE id = 'job-atomic-rollback'")).rowCount, 0);
  } finally {
    await pool.query("ALTER TABLE job_outbox DROP CONSTRAINT ci_forbid_one_job");
  }

  const fixedKey = "outbox-" + randomUUID();
  const jobA = await enqueue(fixedKey);
  const duplicate = await api("/api/jobs/refresh", {
    method: "POST", body: { accountId: "acct-copperline" }, key: fixedKey,
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data.status, "existing");
  assert.equal(duplicate.data.jobId, jobA);
  const jobB = await enqueue("outbox-second-" + randomUUID());
  const outboxCount = await pool.query(
    "SELECT COUNT(*)::int AS n FROM job_outbox WHERE job_id = ANY($1::text[])",
    [[jobA, jobB]],
  );
  assert.equal(outboxCount.rows[0].n, 2);

  // Force the first Redis publication to fail: the intent must remain durable.
  const noRedis = createSyntheticRedisJobRunner({
    pool,
    redis: { async sendCommand(cmd) {
      if (cmd[0] === "XADD") throw new Error("synthetic_redis_down");
      return redis.sendCommand(cmd);
    } },
    organizationId, workerId: "ci-redis-outage",
  });
  await assert.rejects(noRedis.publishOne(), /synthetic_redis_down/);
  assert.equal((await pool.query(
    "SELECT COUNT(*)::int AS n FROM job_outbox WHERE job_id = $1 AND published_at IS NULL", [jobA],
  )).rows[0].n, 1);
  await runner.ensureGroup();
  const publishedA = await runner.publishOne();
  assert.equal(publishedA.jobId, jobA);
  assert.equal((await runner.consumeOne()).status, "completed");
  assert.equal((await repository.getJob({ organizationId, id: jobA })).status, "completed");

  // Duplicate Redis signal after completion is ACKed but not re-executed.
  await pool.query("UPDATE job_outbox SET published_at = NULL WHERE job_id = $1", [jobA]);
  assert.equal((await runner.publishOne()).jobId, jobA);
  assert.equal((await runner.consumeOne()).status, "already_terminal");
  assert.equal((await repository.getJob({ organizationId, id: jobA })).attempts, 1);

  // Process the other pending event before crash/reclaim.
  assert.equal((await runner.publishOne()).jobId, jobB);
  assert.equal((await runner.consumeOne()).status, "completed");

  // Child process claims a real Redis event and PostgreSQL job, then is killed.
  const crashJob = await enqueue("crash-" + randomUUID());
  assert.equal((await runner.publishOne()).jobId, crashJob);
  child = spawn(process.execPath, ["scripts/fixtures/hold-synthetic-worker.mjs"], {
    env: {
      ...process.env, ORBICORE_CI_CRASH_FIXTURE: "1", ORBICORE_CI_ORG: organizationId,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let childError = "";
  child.stderr.on("data", (chunk) => { childError += chunk.toString().slice(0, 2000); });
  const claimed = await Promise.race([
    new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("exit", (code) => reject(new Error("crash_fixture_exited:" + code + ":" + childError)));
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("crash_fixture_claim_timeout")), 15_000)),
  ]);
  assert.equal(claimed.stage, "claimed");
  assert.equal(claimed.jobId, crashJob);
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  child = null;
  const crashed = await repository.getJob({ organizationId, id: crashJob });
  assert.equal(crashed.status, "running");
  assert.equal(crashed.attempts, 1);
  await expectOnePending();
  // Accelerate lease expiry only; the process was genuinely terminated.
  await pool.query("UPDATE jobs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [crashJob]);
  const resumed = await runner.consumeOne({ reclaim: true, minIdleMs: 0 });
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.jobId, crashJob);
  assert.equal((await repository.getJob({ organizationId, id: crashJob })).attempts, 2);

  // Fresh policy check rejects an actor revoked in the PostgreSQL store.
  const deniedJob = await enqueue("deny-" + randomUUID());
  assert.equal((await runner.publishOne()).jobId, deniedJob);
  await pool.query("UPDATE users SET disabled = TRUE WHERE id = $1", [actor.id]);
  const denied = await runner.consumeOne();
  assert.equal(denied.status, "policy_denied");
  assert.equal((await repository.getJob({ organizationId, id: deniedJob })).status, "failed");
  await pool.query("UPDATE users SET disabled = FALSE WHERE id = $1", [actor.id]);

  // Reconcile a missing Redis signal by scanning *unfinished* PostgreSQL jobs.
  const missingJob = await enqueue("missing-" + randomUUID());
  const missingSignal = await runner.publishOne();
  assert.equal(missingSignal.jobId, missingJob);
  assert.equal(await redis.sendCommand(["XDEL", runner.stream, missingSignal.redisId]), 1);
  await pool.query(
    "UPDATE job_outbox SET published_at = NOW() - INTERVAL '120 seconds' WHERE job_id = $1",
    [missingJob],
  );
  assert.deepEqual(await runner.reconcileUnfinished({ olderThanSeconds: 1 }), [missingJob]);
  assert.equal((await runner.publishOne()).jobId, missingJob);
  assert.equal((await runner.consumeOne()).status, "completed");

  // A separate opt-in service process must also publish and complete a
  // queued synthetic job, not just the in-process library test harness.
  const cliJob = await enqueue("standalone-cli-" + randomUUID());
  const cliWorker = spawn(process.execPath, ["apps/api/synthetic-worker-runner.mjs"], {
    env: {
      ...process.env,
      ORBICORE_ENABLE_SYNTHETIC_REDIS_WORKER: "1",
      ORBICORE_WORKER_ORGANIZATION_ID: organizationId,
      ORBICORE_WORKER_ID: "ci-standalone",
      ORBICORE_WORKER_ONCE: "1",
      ORBICORE_REDIS_URL: "redis://127.0.0.1:6379",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let cliStdout = "";
  let cliStderr = "";
  cliWorker.stdout.on("data", (chunk) => { cliStdout += String(chunk); });
  cliWorker.stderr.on("data", (chunk) => { cliStderr += String(chunk).slice(0, 400); });
  const cliExit = await Promise.race([
    new Promise((resolve, reject) => {
      cliWorker.once("error", reject);
      cliWorker.once("exit", resolve);
    }),
    new Promise((_, reject) => setTimeout(() => {
      cliWorker.kill("SIGKILL");
      reject(new Error("standalone_worker_timeout"));
    }, 15000)),
  ]);
  assert.equal(cliExit, 0, "standalone synthetic worker: " + cliStderr);
  assert.equal(JSON.parse(cliStdout).mode, "synthetic_only");
  assert.equal((await repository.getJob({ organizationId, id: cliJob })).status, "completed");

  const httpJob = await api("/api/jobs/" + crashJob);
  assert.equal(httpJob.status, 200);
  assert.equal(httpJob.data.job.status, "completed");
  assert.equal(httpJob.data.job.result.live, false);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0);

  console.log(JSON.stringify({
    task: "ORB-004", kind: "http-postgres-outbox-redis-synthetic-worker",
    node: process.version,
    atomicJobOutboxRollback: "passed",
    failedRedisPublishNoJobLoss: "passed",
    duplicateDeliveryFenced: "passed",
    workerProcessSigkillThenReclaim: "passed",
    optInStandaloneWorkerProcess: "passed",
    postgresActorRevocationDenied: "passed",
    missingRedisSignalReconciliation: "passed",
    authenticatedHttpJobState: "passed",
    productionApiWorkerEnabled: false,
    liveProviderActions: false,
    postgresIdentityMigrationComplete: false,
    dockerComposeVolumePersistenceTested: false,
  }));
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  app.close();
  if (redis.isOpen) await redis.close().catch(() => redis.destroy());
  await pool.end();
}
