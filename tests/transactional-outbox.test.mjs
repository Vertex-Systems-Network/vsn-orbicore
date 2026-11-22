import assert from "node:assert/strict";
import { test } from "node:test";
import { createTransactionalOutboxJobRepository } from "../apps/api/transactional-outbox.mjs";
import { createSyntheticRedisJobRunner } from "../apps/api/synthetic-redis-worker.mjs";

const request = {
  id: "test-outbox-job",
  organizationId: "org-test",
  accountId: "acct-test",
  idempotencyKey: "client-request",
  requestedBy: "user-test",
};

function fakePool({ failOutbox = false } = {}) {
  const queries = [];
  let releases = 0;
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.startsWith("INSERT INTO jobs")) {
        return { rows: [{
          id: params[0], organization_id: params[1], account_id: params[2],
          requested_by: params[3], type: params[4], status: "queued",
          attempts: 0, max_attempts: 3, result_json: null, error: null,
          created_at: new Date(), completed_at: null,
        }] };
      }
      if (sql.startsWith("INSERT INTO job_outbox") && failOutbox) throw new Error("outbox_insert_rejected");
      return { rows: [] };
    },
    release() { releases += 1; },
  };
  const pool = { query: client.query, async connect() { return client; } };
  return { pool, queries, released: () => releases };
}

test("ORB-004: a job and its notification intent commit as one transaction", async () => {
  const db = fakePool();
  const adapter = createTransactionalOutboxJobRepository(db.pool);
  const result = await adapter.enqueue(request);
  assert.equal(result.created, true);
  const commands = db.queries.map((item) => item.sql.split(" ")[0]);
  assert.deepEqual(commands, ["BEGIN", "INSERT", "INSERT", "COMMIT"]);
  assert.deepEqual(db.queries[2].params, ["test-outbox-job", "org-test"]);
  assert.equal(db.released(), 1);
});

test("ORB-004: outbox insertion failure rolls back job and releases connection", async () => {
  const db = fakePool({ failOutbox: true });
  const adapter = createTransactionalOutboxJobRepository(db.pool);
  await assert.rejects(() => adapter.enqueue(request), /outbox_insert_rejected/);
  assert.equal(db.queries.at(-1).sql, "ROLLBACK");
  assert.equal(db.released(), 1);
});

test("ORB-004: malformed PostgreSQL/Redis worker parameters fail before I/O", () => {
  assert.throws(() => createTransactionalOutboxJobRepository({ query() {} }), /connection pool/);
  const pool = { connect() {}, query() {} };
  const redis = { sendCommand() {} };
  assert.throws(() => createSyntheticRedisJobRunner({
    pool, redis, organizationId: "x\ny", workerId: "worker",
  }), /organizationId/);
  assert.throws(() => createSyntheticRedisJobRunner({
    pool, redis, organizationId: "org", workerId: "worker", leaseSeconds: 0,
  }), /leaseSeconds/);
  assert.throws(() => createSyntheticRedisJobRunner({
    pool, redis: {}, organizationId: "org", workerId: "worker",
  }), /Redis/);
});
