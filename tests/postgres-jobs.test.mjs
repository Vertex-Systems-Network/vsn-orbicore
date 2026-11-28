import assert from "node:assert/strict";
import { test } from "node:test";
import { createPostgresJobRepository } from "../apps/api/postgres-jobs.mjs";

test("ORB-004: parameterized PostgreSQL queue calls do not interpolate tenant, account or keys", async () => {
  const statements = [];
  const database = {
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql.startsWith("INSERT")) {
        return { rows: [{
          id: params[0], organization_id: params[1], account_id: params[2],
          requested_by: params[3], type: params[4], status: "queued",
          attempts: 0, max_attempts: 3, result_json: null, error: null,
          created_at: new Date(), completed_at: null,
        }] };
      }
      if (sql.includes("orbicore_claim_job")) return { rows: [] };
      if (sql.includes("orbicore_complete_job")) return { rows: [{ completed: false }] };
      if (sql.includes("orbicore_fail_exhausted_jobs")) return { rows: [{ failed_count: 0 }] };
      return { rows: [] };
    },
  };
  const repository = createPostgresJobRepository(database);
  const idempotencyKey = "client'key--should-be-hashed";
  const inserted = await repository.enqueue({
    organizationId: "org-ci", accountId: "acct-ci", idempotencyKey, requestedBy: "user-ci",
  });
  assert.equal(inserted.created, true);
  assert.equal(inserted.job.organizationId, "org-ci");
  const insert = statements[0];
  assert.match(insert.sql, /VALUES \(\$1, \$2, \$3, \$4, \$5/);
  assert.equal(insert.params[1], "org-ci");
  assert.equal(insert.params[2], "acct-ci");
  assert.equal(insert.params[5].length, 64);
  assert.equal(insert.sql.includes(idempotencyKey), false);
  assert.equal(insert.params[5].includes(idempotencyKey), false);
  assert.equal(await repository.claimNext({ organizationId: "org-ci", workerId: "worker-ci" }), null);
  assert.match(statements.at(-1).sql, /orbicore_claim_job\(\$1, \$2, \$3\)/);
  assert.equal(await repository.failExpired({ organizationId: "org-ci" }), 0);
  assert.equal(await repository.complete({
    organizationId: "org-ci", jobId: inserted.job.id,
    claimToken: "33efabcd-66e4-4da0-93bb-123456789abc", result: { source: "mock" },
  }), false);
  assert.ok(statements.at(-1).params[3] === JSON.stringify({ source: "mock" }));
});

test("ORB-004: fail invalid identifiers, lease bounds and unsupported driver before SQL", async () => {
  assert.throws(() => createPostgresJobRepository(null), /query/);
  const database = { async query() { throw new Error("unexpected_query"); } };
  const store = createPostgresJobRepository(database);
  await assert.rejects(() => store.enqueue({ organizationId: "ok", accountId: "", idempotencyKey: "key" }), /accountId/);
  await assert.rejects(() => store.enqueue({ organizationId: "ok", accountId: "acct", idempotencyKey: "" }), /idempotencyKey/);
  await assert.rejects(() => store.enqueue({ organizationId: "ok", accountId: "acct", idempotencyKey: "a".repeat(257) }), /idempotencyKey/);
  await assert.rejects(() => store.getJob({ organizationId: "' OR true --", id: "job1" }), /organizationId/);
  await assert.rejects(() => store.claimNext({ organizationId: "tenant", workerId: "worker", leaseSeconds: 0 }), /leaseSeconds/);
  await assert.rejects(() => store.complete({ organizationId: "tenant", jobId: "job1", claimToken: "not-a-uuid" }), /claimToken/);
});

test("ORB-004 PostgreSQL job replay binds the key to the original requester", async () => {
  for (const originalRequester of ["operator-a", null]) {
    const row = {
      id: "job-ci", organization_id: "org-ci", account_id: "acct-ci",
      requested_by: originalRequester, type: "inventory_refresh", status: "queued",
      attempts: 0, max_attempts: 3, result_json: null, error: null,
      created_at: new Date(), completed_at: null,
    };
    const repository = createPostgresJobRepository({
      async query(sql) {
        return { rows: sql.startsWith("INSERT") ? [] : [row] };
      },
    });
    const input = { organizationId: "org-ci", accountId: "acct-ci", idempotencyKey: "retry" };
    const replay = await repository.enqueue({ ...input, requestedBy: originalRequester });
    assert.equal(replay.created, false);
    assert.equal(replay.job.id, row.id);
    for (const other of ["operator-b", ...(originalRequester === null ? [] : [null])]) {
      await assert.rejects(() => repository.enqueue({ ...input, requestedBy: other }), /idempotency_key_payload_conflict/);
    }
  }
});
