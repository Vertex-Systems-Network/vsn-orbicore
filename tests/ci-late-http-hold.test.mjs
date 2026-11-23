import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../apps/api/server.mjs";

const marker = "CREATE TABLE orbicore_ci_active_recovery_hold (dummy TEXT)";
const token = "ci-late-source-http-bootstrap-token";
async function start(path) {
  const app = createApp({ dbPath: path, startWorker: false, bootstrapToken: token });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  return { app, base: "http://127.0.0.1:" + app.server.address().port };
}
function post(base, route, data, cookie) {
  return fetch(base + route, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(data),
  });
}
async function bootstrap(base) {
  const response = await post(base, "/api/auth/bootstrap", {
    token, email: "owner@example.test", password: "safe-ci-source-hold-password-32",
  });
  assert.equal(response.status, 201);
  return response.headers.get("set-cookie").split(";")[0];
}

test("ORB-004 existing HTTP process refuses later source hold for all unsafe API methods", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orb-http-hold-"));
  let app, external;
  try {
    const started = await start(join(dir, "source.sqlite"));
    app = started.app;
    const cookie = await bootstrap(started.base);
    const count = (table) => app.db.prepare("SELECT COUNT(*) AS n FROM " + table).get().n;
    const before = ["users", "accounts", "jobs", "sessions", "audit_events"].map(count);
    external = new DatabaseSync(join(dir, "source.sqlite"));
    external.exec(marker);
    for (const [route, body] of [
      ["/api/jobs/refresh", { accountId: "acct-northstar" }],
      ["/api/accounts/sandbox", { label: "Fake", username: "ci_user", host: "cp.example.org" }],
      ["/api/auth/login", { email: "owner@example.test", password: "safe-ci-source-hold-password-32" }],
      ["/api/auth/logout", {}],
      ["/api/system/demo-seed", {}],
    ]) {
      const denied = await post(started.base, route, body, cookie);
      assert.equal(denied.status, 503, route);
      assert.equal((await denied.json()).error, "ci_sqlite_source_recovery_hold_manual_review_required");
    }
    assert.equal((await fetch(started.base + "/api/health")).status, 200);
    assert.equal((await fetch(started.base + "/api/overview", { headers: { cookie } })).status, 200);
    assert.deepEqual(["users", "accounts", "jobs", "sessions", "audit_events"].map(count), before);
  } finally {
    external?.close();
    app?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ORB-004 active SQLite recovery hold prevents bootstrap even with correct one-time token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orb-bootstrap-hold-"));
  let app, external;
  try {
    const started = await start(join(dir, "source.sqlite"));
    app = started.app;
    external = new DatabaseSync(join(dir, "source.sqlite"));
    external.exec(marker);
    const response = await post(started.base, "/api/auth/bootstrap", {
      token, email: "owner@example.test", password: "safe-ci-source-hold-password-32",
    });
    assert.equal(response.status, 503);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 0);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM bootstrap_tokens").get().n, 1);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM audit_events").get().n, 0);
    const status = await fetch(started.base + "/api/auth/bootstrap-status");
    assert.equal((await status.json()).required, true);
  } finally {
    external?.close();
    app?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ORB-004 delayed HTTP request body rechecks source hold before enqueue", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orb-inflight-hold-"));
  let app, external;
  try {
    const started = await start(join(dir, "source.sqlite"));
    app = started.app;
    const cookie = await bootstrap(started.base);
    let req;
    const response = new Promise((resolve, reject) => {
      req = httpRequest(started.base + "/api/jobs/refresh", {
        method: "POST",
        headers: { cookie, "content-type": "application/json", "transfer-encoding": "chunked" },
      }, (res) => {
        const buffers = [];
        res.on("data", (chunk) => buffers.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(buffers).toString()) }));
      });
      req.on("error", reject);
      req.write('{"accountId":');
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    external = new DatabaseSync(join(dir, "source.sqlite"));
    external.exec(marker);
    req.end('"acct-northstar"}');
    const denied = await response;
    assert.equal(denied.status, 503);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM audit_events").get().n, 1);
  } finally {
    external?.close();
    app?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
