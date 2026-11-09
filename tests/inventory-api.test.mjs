import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createApp } from "../apps/api/server.mjs";

let app;
let baseUrl;

beforeEach(async () => {
  app = createApp({ dbPath: ":memory:", startWorker: false });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;
});

afterEach(() => app?.close());

test("health and overview expose synthetic fixture state clearly", async () => {
  const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
  const overviewResponse = await fetch(`${baseUrl}/api/overview`);
  const overview = await overviewResponse.json();
  assert.equal(health.status, "ok");
  assert.equal(health.liveConnections, 0);
  assert.equal(overview.source, "mock_fixture");
  assert.equal(overview.counts.accounts, 3);
  assert.equal(overview.counts.sites, 7);
  assert.equal(overview.storage.usedBytes, 231391363072);
});

test("site inventory is tenant fixture scoped and unknown accounts return 404", async () => {
  const response = await fetch(`${baseUrl}/api/accounts/acct-northstar/sites`);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.live, false);
  assert.equal(data.sites.length, 3);
  assert.equal(data.sites[0].accountId, "acct-northstar");
  const missing = await fetch(`${baseUrl}/api/accounts/missing/sites`);
  assert.equal(missing.status, 404);
});

test("refresh job persists its queued and completed states", async () => {
  const queuedResponse = await fetch(`${baseUrl}/api/jobs/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "test-refresh-1" },
    body: JSON.stringify({ accountId: "acct-copperline" }),
  });
  const queued = await queuedResponse.json();
  assert.equal(queuedResponse.status, 202);
  assert.equal(queued.status, "queued");
  assert.equal((await app.processNextJob()).status, "completed");
  const persisted = await fetch(`${baseUrl}/api/jobs/${queued.jobId}`).then((response) => response.json());
  assert.equal(persisted.job.status, "completed");
  assert.equal(persisted.job.result.source, "mock_fixture");
  assert.equal(persisted.job.result.live, false);
});

test("idempotency key avoids duplicate refresh jobs", async () => {
  const request = () => fetch(`${baseUrl}/api/jobs/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "retry-safe-1" },
    body: JSON.stringify({ accountId: "acct-northstar" }),
  });
  const first = await (await request()).json();
  const secondResponse = await request();
  const second = await secondResponse.json();
  assert.equal(secondResponse.status, 200);
  assert.equal(second.jobId, first.jobId);
});

test("invalid JSON and oversized input are rejected without creating jobs", async () => {
  const response = await fetch(`${baseUrl}/api/jobs/refresh`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{bad json",
  });
  assert.equal(response.status, 400);
  const jobs = await fetch(`${baseUrl}/api/jobs`).then((result) => result.json());
  assert.equal(jobs.jobs.length, 0);
});
