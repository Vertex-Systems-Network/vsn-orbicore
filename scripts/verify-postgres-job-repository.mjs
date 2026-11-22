import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPostgresJobRepository } from "../apps/api/postgres-jobs.mjs";

// A test-only node-postgres driver is installed by GitHub Actions and is not
// bundled by the current API package. Do not claim production runtime wiring.
const { default: postgres } = await import("pg");
const connect = () => new postgres.Pool({
  host: process.env.PGHOST ?? "127.0.0.1",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "orbicore",
  database: process.env.PGDATABASE ?? "orbicore",
  password: process.env.PGPASSWORD,
  max: 2,
  connectionTimeoutMillis: 5_000,
});
const prefix = "job-store-" + randomUUID().slice(0, 8);
const tenantA = prefix + "-a";
const tenantB = prefix + "-b";
const accountA = prefix + "-account-a";
const accountB = prefix + "-account-b";

let pool = connect();
try {
  await pool.query(
    "INSERT INTO organizations (id, name) VALUES ($1, 'Synthetic A'), ($2, 'Synthetic B')",
    [tenantA, tenantB],
  );
  await pool.query(
    "INSERT INTO accounts (id, organization_id, label, provider, host, username, health, used_bytes, quota_bytes, source) " +
    "VALUES ($1, $2, 'Fixture A', 'mock', 'test-a.invalid', 'ci', 'healthy', 0, 1, 'mock_fixture'), " +
    "($3, $4, 'Fixture B', 'mock', 'test-b.invalid', 'ci', 'healthy', 0, 1, 'mock_fixture')",
    [accountA, tenantA, accountB, tenantB],
  );
  const repo = createPostgresJobRepository(pool);
  const a = await repo.enqueue({
    organizationId: tenantA, accountId: accountA, idempotencyKey: "same-user-key",
  });
  assert.equal(a.created, true);
  assert.equal(a.job.status, "queued");
  assert.equal(a.job.organizationId, tenantA);
  const replay = await repo.enqueue({
    organizationId: tenantA, accountId: accountA, idempotencyKey: "same-user-key",
  });
  assert.equal(replay.created, false);
  assert.equal(replay.job.id, a.job.id);
  await assert.rejects(() => repo.enqueue({
    organizationId: tenantA, accountId: accountB, idempotencyKey: "same-user-key",
  }), /payload_conflict/);
  const b = await repo.enqueue({
    organizationId: tenantB, accountId: accountB, idempotencyKey: "same-user-key",
  });
  assert.equal(b.created, true, "same client-supplied key in a separate tenant must not collide");
  assert.notEqual(b.job.id, a.job.id);
  assert.equal(await repo.getJob({ organizationId: tenantB, id: a.job.id }), null);
  assert.equal(await repo.getJob({ organizationId: tenantA, id: b.job.id }), null);
  await assert.rejects(() => repo.getJob({ organizationId: "' OR 1=1 --", id: a.job.id }), /organizationId/);
  await assert.rejects(() => repo.enqueue({
    organizationId: tenantA, accountId: accountB, idempotencyKey: "cross-account",
  }), /foreign key/i);

  const original = await repo.claimNext({ organizationId: tenantA, workerId: "test-worker-1", leaseSeconds: 30 });
  assert.equal(original.jobId, a.job.id);
  assert.equal(original.attempt, 1);
  assert.equal(await repo.claimNext({ organizationId: tenantA, workerId: "test-worker-1" }), null);
  assert.equal(await repo.complete({
    organizationId: tenantB, jobId: a.job.id, claimToken: original.claimToken,
  }), false);

  // Simulate a terminated worker by closing its connection pool; reattach from
  // a completely new pool. A test update advances expiry without real waiting.
  await pool.end();
  pool = connect();
  const replacementRepo = createPostgresJobRepository(pool);
  await pool.query(
    "UPDATE jobs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
    [a.job.id],
  );
  const recovered = await replacementRepo.claimNext({
    organizationId: tenantA, workerId: "test-worker-after-reconnect", leaseSeconds: 30,
  });
  assert.equal(recovered.jobId, a.job.id);
  assert.equal(recovered.attempt, 2);
  assert.notEqual(recovered.claimToken, original.claimToken);
  assert.equal(await replacementRepo.complete({
    organizationId: tenantA, jobId: a.job.id, claimToken: original.claimToken,
  }), false);
  assert.equal(await replacementRepo.complete({
    organizationId: tenantA, jobId: a.job.id, claimToken: recovered.claimToken,
    result: { source: "synthetic_pg_test", completed: true },
  }), true);
  const persisted = await replacementRepo.getJob({ organizationId: tenantA, id: a.job.id });
  assert.equal(persisted.status, "completed");
  assert.equal(persisted.attempts, 2);
  assert.deepEqual(persisted.result, { source: "synthetic_pg_test", completed: true });

  await pool.query("UPDATE jobs SET max_attempts = 1 WHERE id = $1", [b.job.id]);
  const claimB = await replacementRepo.claimNext({ organizationId: tenantB, workerId: "test-worker-b" });
  assert.equal(claimB.jobId, b.job.id);
  await pool.query(
    "UPDATE jobs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
    [b.job.id],
  );
  assert.equal(await replacementRepo.failExpired({ organizationId: tenantB }), 1);
  assert.equal((await replacementRepo.getJob({ organizationId: tenantB, id: b.job.id })).status, "failed");

  console.log(JSON.stringify({
    "task": "ORB-004", "testKind": "node-postgres-job-repository",
    "postgresRealQueries": "passed", "idempotencyScope": "passed",
    "crossTenantReads": "rejected", "compositeForeignKey": "rejected",
    "separateClientPoolRecovery": "passed", "staleLeaseToken": "rejected",
    "terminalRetryExhaustion": "passed", "postgresApiWired": false,
    "redisApplicationWorkerWired": false,
  }));
} finally {
  await pool.end();
}
