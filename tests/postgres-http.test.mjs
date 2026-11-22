import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../apps/api/server.mjs";

test("ORB-004: injected PostgreSQL job mode cannot start the legacy SQLite worker", () => {
  const adapter = { enqueue() {}, getJob() {}, listJobs() {} };
  assert.throws(() => createApp({ dbPath: ":memory:", jobRepository: adapter }), /startWorker:false/);
  assert.throws(() => createApp({ dbPath: ":memory:", startWorker: false, jobRepository: {} }), /enqueue\/getJob\/listJobs/);
});

test("ORB-004: missing PostgreSQL service returns sanitized HTTP failure without leaking SQL diagnostics", async () => {
  const secretMessage = "pg test diagnostic should never be sent to an HTTP caller";
  const broken = {
    async enqueue() { throw new Error(secretMessage); },
    async getJob() { throw new Error(secretMessage); },
    async listJobs() { throw new Error(secretMessage); },
  };
  const app = createApp({
    dbPath: ":memory:", startWorker: false, jobRepository: broken,
    bootstrapToken: "pg-http-test-bootstrap-token-32bytes",
  });
  try {
    await new Promise((resolve, reject) => {
      app.server.once("error", reject);
      app.server.listen(0, "127.0.0.1", resolve);
    });
    const base = "http://127.0.0.1:" + app.server.address().port;
    const boot = await fetch(base + "/api/auth/bootstrap", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "pg-http-test-bootstrap-token-32bytes",
        email: "owner@example.test", password: "test-only-owner-password-12345",
      }),
    });
    assert.equal(boot.status, 201);
    const cookie = boot.headers.get("set-cookie").split(";")[0];
    const anon = await fetch(base + "/api/jobs");
    assert.equal(anon.status, 401);
    for (const url of ["/api/jobs", "/api/jobs/test-job", "/api/overview"]) {
      const response = await fetch(base + url, { headers: { cookie } });
      const body = await response.json();
      assert.equal(response.status, 503);
      assert.equal(body.error, "job_store_unavailable");
      assert.equal(JSON.stringify(body).includes(secretMessage), false);
    }
    const response = await fetch(base + "/api/jobs/refresh", {
      method: "POST", headers: { cookie, "content-type": "application/json", "idempotency-key": "safe-key" },
      body: JSON.stringify({ accountId: "acct-copperline" }),
    });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error, "job_store_unavailable");
    assert.equal(JSON.stringify(body).includes(secretMessage), false);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count, 0);
  } finally {
    app.close();
  }
});
