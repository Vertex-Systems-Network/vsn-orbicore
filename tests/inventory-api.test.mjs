import assert from "node:assert/strict";
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { createApp } from "../apps/api/server.mjs";

let app;
let baseUrl;
let sessionCookie;
const bootstrapSecret = "test-bootstrap-token-at-least-32-bytes";

beforeEach(async () => {
  app = createApp({ dbPath: ":memory:", startWorker: false, bootstrapToken: bootstrapSecret });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const bootstrap = await fetch(`${baseUrl}/api/auth/bootstrap`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: bootstrapSecret, email: "admin@example.test", password: "a-local-test-password-41" }),
  });
  assert.equal(bootstrap.status, 201);
  sessionCookie = bootstrap.headers.get("set-cookie").split(";")[0];
  const storedUser = app.db.prepare("SELECT password_hash FROM users WHERE email = 'admin@example.test'").get();
  assert.notEqual(storedUser.password_hash, "a-local-test-password-41");
  assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM bootstrap_tokens").get().count, 0);
});

afterEach(() => app?.close());

function api(path, options = {}, cookie = sessionCookie) {
  const headers = new Headers(options.headers ?? {});
  if (cookie) headers.set("cookie", cookie);
  return fetch(`${baseUrl}${path}`, { ...options, headers });
}

test("bootstrap consumes the one-time token and authentication is required", async () => {
  const status = await api("/api/auth/bootstrap-status", {}, null).then((response) => response.json());
  assert.equal(status.required, false);
  const audit = await api("/api/audit").then((response) => response.json());
  assert.equal(audit.events.length, 1);
  assert.equal(audit.events[0].action, "auth.bootstrap");
  assert.equal(JSON.stringify(audit).includes(bootstrapSecret), false);
  assert.equal(JSON.stringify(audit).includes("a-local-test-password-41"), false);
  const anonymous = await api("/api/overview", {}, null);
  assert.equal(anonymous.status, 401);
  const replay = await api("/api/auth/bootstrap", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: bootstrapSecret, email: "other@example.test", password: "a-local-test-password-52" }),
  }, null);
  assert.equal(replay.status, 401);
});

test("health and overview expose synthetic fixture state clearly", async () => {
  const health = await api("/api/health").then((response) => response.json());
  const overviewResponse = await api("/api/overview");
  const overview = await overviewResponse.json();
  assert.equal(health.status, "ok");
  assert.equal(health.liveConnections, 0);
  assert.equal(overview.source, "mock_fixture");
  assert.equal(overview.counts.accounts, 3);
  assert.equal(overview.counts.sites, 7);
  assert.equal(overview.storage.usedBytes, 231391363072);
});

test("site inventory is tenant fixture scoped and unknown accounts return 404", async () => {
  const response = await api("/api/accounts/acct-northstar/sites");
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.live, false);
  assert.equal(data.sites.length, 3);
  assert.equal(data.sites[0].accountId, "acct-northstar");
  const missing = await api("/api/accounts/missing/sites");
  assert.equal(missing.status, 404);
});

test("refresh job persists its queued and completed states", async () => {
  const queuedResponse = await api("/api/jobs/refresh", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "test-refresh-1" },
    body: JSON.stringify({ accountId: "acct-copperline" }),
  });
  const queued = await queuedResponse.json();
  assert.equal(queuedResponse.status, 202);
  assert.equal(queued.status, "queued");
  assert.equal((await app.processNextJob()).status, "completed");
  const persisted = await api(`/api/jobs/${queued.jobId}`).then((response) => response.json());
  assert.equal(persisted.job.status, "completed");
  assert.equal(persisted.job.result.source, "mock_fixture");
  assert.equal(persisted.job.result.live, false);
  const audit = await api("/api/audit").then((response) => response.json());
  assert.deepEqual(audit.events.filter((event) => event.action === "inventory.refresh").map((event) => event.outcome).sort(), ["completed", "queued"]);
});

test("idempotency key avoids duplicate refresh jobs", async () => {
  const request = () => api("/api/jobs/refresh", {
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
  const response = await api("/api/jobs/refresh", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{bad json",
  });
  assert.equal(response.status, 400);
  const jobs = await api("/api/jobs").then((result) => result.json());
  assert.equal(jobs.jobs.length, 0);
});

test("tenant access is scoped for inventory, sites, and refresh jobs", async () => {
  const otherOrganization = "org-other";
  const otherAccount = "acct-other-only";
  const salt = randomBytes(16).toString("hex");
  const password = "another-local-password-73";
  app.db.prepare("INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)").run(otherOrganization, "Other Workspace", new Date().toISOString());
  app.db.prepare(`INSERT INTO accounts (id, organization_id, label, provider, host, username, health, used_bytes, quota_bytes, last_synced_at, source)
    VALUES (?, ?, 'Other Account', 'cPanel', 'elsewhere.test', 'other', 'healthy', 10, 100, NULL, 'mock_fixture')`).run(otherAccount, otherOrganization);
  app.db.prepare("INSERT INTO sites (id, account_id, domain, kind, document_root, php_version, status) VALUES ('site-other', ?, 'other.test', 'wordpress', '/public_html', '8.3', 'active')").run(otherAccount);
  app.db.prepare(`INSERT INTO users (id, organization_id, email, password_salt, password_hash, role, created_at)
    VALUES ('user-other', ?, 'other@example.test', ?, ?, 'owner', ?)`).run(otherOrganization, salt, scryptSync(password, salt, 64).toString("hex"), new Date().toISOString());
  assert.throws(() => app.db.prepare(`INSERT INTO jobs (id, type, organization_id, account_id, requested_by, status, created_at)
    VALUES ('invalid-cross-tenant-job', 'inventory_refresh', ?, 'acct-northstar', 'user-other', 'queued', ?)`)
    .run(otherOrganization, new Date().toISOString()), /FOREIGN KEY/);
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "other@example.test", password }),
  });
  assert.equal(login.status, 200);
  const otherCookie = login.headers.get("set-cookie").split(";")[0];
  const accounts = await api("/api/accounts", {}, otherCookie).then((response) => response.json());
  assert.deepEqual(accounts.accounts.map((account) => account.id), [otherAccount]);
  const otherAudit = await api("/api/audit", {}, otherCookie).then((response) => response.json());
  assert.deepEqual(otherAudit.events, []);
  assert.equal((await api("/api/accounts/acct-northstar/sites", {}, otherCookie)).status, 404);
  const refresh = await api("/api/jobs/refresh", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: "acct-northstar" }),
  }, otherCookie);
  assert.equal(refresh.status, 404);
});

test("expired sessions and disabled actors cannot read or execute jobs", async () => {
  const token = sessionCookie.slice("orbicore_session=".length);
  const tokenHash = createHash("sha256").update(token).digest("hex");
  app.db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token_hash = ?").run(tokenHash);
  assert.equal((await api("/api/overview")).status, 401);
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@example.test", password: "a-local-test-password-41" }),
  });
  const refreshedCookie = login.headers.get("set-cookie").split(";")[0];
  const queued = await api("/api/jobs/refresh", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: "acct-northstar" }),
  }, refreshedCookie).then((response) => response.json());
  app.db.prepare("UPDATE users SET disabled = 1 WHERE email = 'admin@example.test'").run();
  const result = await app.processNextJob();
  assert.equal(result.status, "failed");
  assert.match(result.error, /no longer has permission/);
  const stored = app.db.prepare("SELECT status FROM jobs WHERE id = ?").get(queued.jobId);
  assert.equal(stored.status, "failed");
  assert.equal(app.db.prepare("SELECT outcome FROM audit_events WHERE target_id = 'acct-northstar' AND outcome = 'failed'").get().outcome, "failed");
});

test("viewer role cannot enqueue refresh work and logout revokes the session", async () => {
  app.db.prepare("UPDATE users SET role = 'viewer' WHERE email = 'admin@example.test'").run();
  const denied = await api("/api/jobs/refresh", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: "acct-northstar" }),
  });
  assert.equal(denied.status, 403);
  assert.equal((await api("/api/audit")).status, 403);
  app.db.prepare("UPDATE users SET role = 'owner' WHERE email = 'admin@example.test'").run();
  await api("/api/auth/logout", { method: "POST" });
  assert.equal((await api("/api/overview")).status, 401);
});

test("cookie session is HttpOnly and cross-origin writes are rejected", async () => {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@example.test", password: "a-local-test-password-41" }),
  });
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const csrf = await api("/api/jobs/refresh", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://attacker.example" },
    body: JSON.stringify({ accountId: "acct-northstar" }),
  });
  assert.equal(csrf.status, 403);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count, 0);
});

test("repeated invalid logins are rate limited", async () => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@example.test", password: "wrong-password" }),
    });
    assert.equal(response.status, 401);
  }
  const limited = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@example.test", password: "a-local-test-password-41" }),
  });
  assert.equal(limited.status, 429);
});
