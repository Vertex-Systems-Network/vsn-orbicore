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

test("ORB-005: JSON ingress enforces byte-size limits, not UTF-16 string length", async () => {
  const body = JSON.stringify({ accountId: "acct-northstar", note: "🧩".repeat(8500) });
  assert.ok(body.length < 32768);
  assert.ok(Buffer.byteLength(body, "utf8") > 32768);
  const response = await api("/api/jobs/refresh", {
    method: "POST", headers: { "content-type": "application/json" }, body,
  });
  assert.equal(response.status, 413);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count, 0);
});

test("ORB-005: malformed UTF-8 and non-object JSON fail closed with 400", async () => {
  const malformed = Buffer.concat([Buffer.from('{"accountId":"acct-'), Buffer.from([0xff]), Buffer.from('northstar"}')]);
  const invalidUtf8 = await api("/api/jobs/refresh", {
    method: "POST", headers: { "content-type": "application/json" }, body: malformed,
  });
  assert.equal(invalidUtf8.status, 400);
  for (const body of ["null", "[]", "42", '"hello"', "true"]) {
    const response = await api("/api/jobs/refresh", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    assert.equal(response.status, 400, `unexpected status for ${body}`);
  }
  assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count, 0);
});

test("ORB-005: UTF-8 split across HTTP chunks preserves a password exactly", async () => {
  const password = "secure-🧩-unicode-password-2026";
  const body = Buffer.from(JSON.stringify({ email: "utf8@example.test", password, role: "viewer" }));
  const splitAt = body.indexOf(Buffer.from("🧩")) + 1;
  assert.ok(splitAt > 0);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(body.subarray(0, splitAt));
      controller.enqueue(body.subarray(splitAt));
      controller.close();
    },
  });
  const created = await api("/api/team/members", {
    method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half",
  });
  assert.equal(created.status, 201);
  const login = await api("/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "utf8@example.test", password }),
  }, null);
  assert.equal(login.status, 200);
});

test("ORB-002 refresh idempotency rejects a different account without adding a job or audit event", async () => {
  const request = accountId => api("/api/jobs/refresh", {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "account-bound-retry" },
    body: JSON.stringify({ accountId }),
  });
  const first = await request("acct-northstar");
  assert.equal(first.status, 202);
  const queued = await first.json();
  const conflict = await request("acct-copperline");
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: "idempotency_conflict" });
  const replay = await request("acct-northstar");
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { jobId: queued.jobId, status: "existing", source: "mock_fixture", live: false });
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 1);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'inventory.refresh'").get().n, 1);
});

test("ORB-002 refresh idempotency denies malformed and overlong keys instead of truncating them", async () => {
  for (const key of ["", "a".repeat(121), "first, second"]) {
    const response = await api("/api/jobs/refresh", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ accountId: "acct-northstar" }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_idempotency_key" });
  }
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'inventory.refresh'").get().n, 0);
});

test("ORB-002 refresh idempotency does not alias a second authorized requester in the same tenant", async () => {
  const request = cookie => api("/api/jobs/refresh", {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "actor-bound-retry" },
    body: JSON.stringify({ accountId: "acct-northstar" }),
  }, cookie);
  const first = await request(sessionCookie);
  assert.equal(first.status, 202);
  const salt = randomBytes(16).toString("hex");
  const password = "fixture-operator-passphrase-92";
  const owner = app.db.prepare("SELECT organization_id FROM users WHERE email = ?").get("admin@example.test");
  app.db.prepare("INSERT INTO users (id, organization_id, email, password_salt, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("second-fixture-operator", owner.organization_id, "second-operator@example.test", salt,
      scryptSync(password, salt, 64).toString("hex"), "operator", new Date().toISOString());
  const login = await api("/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "second-operator@example.test", password }),
  }, null);
  assert.equal(login.status, 200);
  const otherCookie = login.headers.get("set-cookie").split(";")[0];
  const conflict = await request(otherCookie);
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: "idempotency_conflict" });
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 1);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'inventory.refresh'").get().n, 1);
});

test("ORB-002 provider-tagged account cannot enqueue a mock inventory refresh even with a known fixture ID", async () => {
  app.db.prepare("UPDATE accounts SET source = 'provider' WHERE id = ?").run("acct-northstar");
  const before = app.db.prepare("SELECT source, last_synced_at FROM accounts WHERE id = ?").get("acct-northstar");
  const response = await api("/api/jobs/refresh", {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "provider-source-refused" },
    body: JSON.stringify({ accountId: "acct-northstar" }),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "provider_refresh_not_enabled" });
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'inventory.refresh'").get().n, 0);
  assert.deepEqual(app.db.prepare("SELECT source, last_synced_at FROM accounts WHERE id = ?").get("acct-northstar"), before);
});

test("ORB-002 worker refuses a queued mock refresh after account provenance changes", async () => {
  const response = await api("/api/jobs/refresh", {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "provider-source-changed" },
    body: JSON.stringify({ accountId: "acct-northstar" }),
  });
  assert.equal(response.status, 202);
  const { jobId } = await response.json();
  app.db.prepare("UPDATE accounts SET source = 'provider' WHERE id = ?").run("acct-northstar");
  const before = app.db.prepare("SELECT source, last_synced_at FROM accounts WHERE id = ?").get("acct-northstar");
  const result = await app.processNextJob();
  assert.equal(result.status, "failed");
  assert.equal(result.error, "Provider inventory refresh is not enabled.");
  const stored = app.db.prepare("SELECT status, result_json FROM jobs WHERE id = ?").get(jobId);
  assert.equal(stored.status, "failed");
  assert.equal(stored.result_json, null);
  assert.deepEqual(app.db.prepare("SELECT source, last_synced_at FROM accounts WHERE id = ?").get("acct-northstar"), before);
  assert.deepEqual(app.db.prepare("SELECT outcome FROM audit_events WHERE action = 'inventory.refresh' ORDER BY outcome").all().map(row => row.outcome), ["failed", "queued"]);
});

test("ORB-002 provider account cannot inherit a persisted mock capability snapshot", async () => {
  const path = "/api/accounts/acct-northstar/capabilities";
  const before = await api(path);
  assert.equal(before.status, 200);
  const mock = await before.json();
  assert.equal(mock.source, "mock_fixture");
  assert.ok(mock.capabilities.some((entry) => entry.level === "supported"));
  app.db.prepare("UPDATE accounts SET source = 'provider' WHERE id = ?").run("acct-northstar");
  const response = await api(path);
  assert.equal(response.status, 200);
  const unknown = await response.json();
  assert.equal(unknown.accountId, "acct-northstar");
  assert.equal(unknown.source, "unverified_provider");
  assert.equal(unknown.profileName, "unverified_provider");
  assert.equal(unknown.live, false);
  assert.equal(unknown.fetchedAt, null);
  assert.deepEqual(unknown.capabilities.map((entry) => entry.capability), mock.capabilities.map((entry) => entry.capability));
  assert.ok(unknown.capabilities.every((entry) => entry.level === "unknown"));
  app.db.prepare("UPDATE accounts SET source = 'mock_fixture' WHERE id = ?").run("acct-northstar");
  assert.deepEqual(await (await api(path)).json(), mock);
});

test("ORB-002 provider-tagged sites deny synthetic inspection, snapshots and WordPress lifecycle writes", async () => {
  const siteId = "site-northstar-main";
  const path = "/api/sites/" + siteId;
  const original = await api(path + "/inspection");
  assert.equal(original.status, 200);
  assert.equal((await original.json()).source, "mock_fixture");
  app.db.prepare("UPDATE accounts SET source = 'provider' WHERE id = ?").run("acct-northstar");
  const before = {
    snapshots: app.db.prepare("SELECT * FROM site_snapshots WHERE site_id = ? ORDER BY id").all(siteId),
    wordpress: app.db.prepare("SELECT * FROM wp_site_state WHERE site_id = ?").all(siteId),
    audit: app.db.prepare("SELECT * FROM audit_events ORDER BY rowid").all(),
  };
  const denied = await api(path + "/inspection");
  assert.equal(denied.status, 409);
  assert.deepEqual(await denied.json(), { error: "provider_site_operations_not_enabled" });
  for (const [suffix, action] of [
    ["/actions", "backup_dry_run"], ["/actions", "wp_preflight"], ["/actions", "dns_ssl_check"],
    ["/wordpress/staging", "create"], ["/wordpress/staging", "destroy"],
    ["/wordpress/update", "apply_updates"], ["/wordpress/update", "rollback"],
  ]) {
    const response = await api(path + suffix, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }),
    });
    assert.equal(response.status, 409, suffix + " " + action);
    assert.deepEqual(await response.json(), { error: "provider_site_operations_not_enabled" });
  }
  assert.deepEqual(app.db.prepare("SELECT * FROM site_snapshots WHERE site_id = ? ORDER BY id").all(siteId), before.snapshots);
  assert.deepEqual(app.db.prepare("SELECT * FROM wp_site_state WHERE site_id = ?").all(siteId), before.wordpress);
  assert.deepEqual(app.db.prepare("SELECT * FROM audit_events ORDER BY rowid").all(), before.audit);
  app.db.prepare("UPDATE accounts SET source = 'mock_fixture' WHERE id = ?").run("acct-northstar");
  assert.equal((await api(path + "/inspection")).status, 200);
});

test("ORB-005 migration planning and advance reject provider source or destination without writes", async () => {
  const sourceId = "acct-northstar";
  const targetId = "acct-copperline";
  app.db.prepare("UPDATE accounts SET quota_bytes = 1099511627776 WHERE id = ?").run(targetId);
  const input = { siteId: "site-northstar-main", targetAccountId: targetId, strategy: "generic_php" };
  const post = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const snapshot = () => ({
    plans: app.db.prepare("SELECT * FROM migration_plans ORDER BY id").all(),
    audit: app.db.prepare("SELECT * FROM audit_events ORDER BY rowid").all(),
  });
  const setSource = app.db.prepare("UPDATE accounts SET source = ? WHERE id = ?");
  for (const accountId of [sourceId, targetId]) {
    setSource.run("provider", accountId);
    const before = snapshot();
    const denied = await post("/api/migrations", input);
    assert.equal(denied.status, 409);
    assert.deepEqual(await denied.json(), { error: "provider_migration_not_enabled" });
    assert.deepEqual(snapshot(), before);
    setSource.run("mock_fixture", accountId);
  }
  const created = await post("/api/migrations", input);
  assert.equal(created.status, 201);
  const plan = await created.json();
  assert.equal(plan.state, "planned");
  const advancePath = "/api/migrations/" + plan.id + "/advance";
  for (const expected of ["preflight", "snapshot", "transfer"]) {
    const response = await post(advancePath, {});
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, expected);
  }
  for (const accountId of [sourceId, targetId]) {
    setSource.run("provider", accountId);
    const before = snapshot();
    for (const body of [{}, { simulatePartialFailure: true }]) {
      const denied = await post(advancePath, body);
      assert.equal(denied.status, 409);
      assert.deepEqual(await denied.json(), { error: "provider_migration_not_enabled" });
      assert.deepEqual(snapshot(), before);
    }
    setSource.run("mock_fixture", accountId);
  }
  setSource.run("provider", targetId);
  const rolledBack = await post("/api/migrations/" + plan.id + "/rollback", {});
  assert.equal(rolledBack.status, 200);
  assert.equal((await rolledBack.json()).state, "rolled_back");
  assert.equal(app.db.prepare("SELECT source FROM accounts WHERE id = ?").get(targetId).source, "provider");
});

test("ORB-005 provider storage policy creation and drills are denied without fabricated estimates or writes", async () => {
  const accountId = "acct-northstar";
  const post = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const input = { accountId, mode: "backup_archival", targetEndpoint: "https://s3.example.org", targetBucket: "test-storage-source", thresholdPercent: 80 };
  const created = await post("/api/storage/policies", input);
  assert.equal(created.status, 201);
  const { id } = await created.json();
  const drillPath = "/api/storage/policies/" + id + "/drill";
  app.db.prepare("UPDATE accounts SET source = 'provider' WHERE id = ?").run(accountId);
  const beforePolicies = app.db.prepare("SELECT * FROM storage_policies ORDER BY id").all();
  const beforeAudit = app.db.prepare("SELECT * FROM audit_events ORDER BY rowid").all();
  const denied = await post("/api/storage/policies", input);
  assert.equal(denied.status, 409);
  assert.deepEqual(await denied.json(), { error: "provider_storage_not_enabled" });
  for (const drillType of ["dry_run_offload", "simulate_outage", "rehydrate_verify"]) {
    const response = await post(drillPath, { drillType });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "provider_storage_not_enabled" });
  }
  const summary = await (await api("/api/storage/summary")).json();
  assert.equal(summary.accounts.find((account) => account.id === accountId).estimatedOffloadableBytes, null);
  const policy = summary.policies.find((entry) => entry.id === id);
  assert.equal(policy.estimatedReclaimBytes, null);
  assert.equal(policy.drillEligible, false);
  assert.deepEqual(app.db.prepare("SELECT * FROM storage_policies ORDER BY id").all(), beforePolicies);
  assert.deepEqual(app.db.prepare("SELECT * FROM audit_events ORDER BY rowid").all(), beforeAudit);
  app.db.prepare("UPDATE accounts SET source = 'mock_fixture' WHERE id = ?").run(accountId);
  const restored = await post(drillPath, { drillType: "dry_run_offload" });
  assert.equal(restored.status, 200);
});

test("ORB-005 automation excludes provider records, stale candidates only, and disabled rules cannot execute", async () => {
  const post = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const sourceId = "acct-northstar";
  app.db.prepare("UPDATE accounts SET source = 'provider', used_bytes = quota_bytes, last_synced_at = NULL WHERE id = ?").run(sourceId);
  app.db.prepare("UPDATE accounts SET last_synced_at = ? WHERE id = ?").run(new Date().toISOString(), "acct-copperline");
  app.db.prepare("UPDATE accounts SET last_synced_at = NULL WHERE id = ?").run("acct-fieldwork");
  const providerLabel = app.db.prepare("SELECT label FROM accounts WHERE id = ?").get(sourceId).label;
  const insights = await (await api("/api/automation/insights")).json();
  assert.equal(insights.excludedProviderAccounts, 1);
  assert.ok(insights.insights.some((item) => item.id === "insight-provider-unverified"));
  assert.ok(insights.insights.every((item) => !item.id.includes(sourceId) && !item.title.includes(providerLabel)));
  const expectedSnapshots = app.db.prepare("SELECT COUNT(*) AS count FROM site_snapshots ss JOIN sites s ON s.id = ss.site_id JOIN accounts a ON a.id = s.account_id WHERE a.source = 'mock_fixture'").get().count;
  const ids = [];
  for (const ruleType of ["inventory_stale_refresh", "quota_threshold_alert", "backup_snapshot_schedule"]) {
    const created = await post("/api/automation/rules", { name: ruleType, ruleType, approvalMode: "dry_run_bounded", dailyRunCap: 3 });
    assert.equal(created.status, 201);
    const { rule } = await created.json();
    ids.push(rule.id);
    const run = await post("/api/automation/rules/" + rule.id + "/run", {});
    assert.equal(run.status, 201);
    const { summary } = await run.json();
    assert.equal(summary.source, "mock_fixture");
    assert.equal(summary.excludedProviderAccounts, 1);
    if (ruleType === "inventory_stale_refresh") assert.deepEqual(summary.candidateRefreshIds, ["acct-fieldwork"]);
    if (ruleType === "quota_threshold_alert") assert.ok(!summary.accountsOverThreshold.includes(providerLabel));
    if (ruleType === "backup_snapshot_schedule") assert.equal(summary.recordedSiteSnapshots, expectedSnapshots);
  }
  app.db.prepare("UPDATE automation_rules SET enabled = 0 WHERE id = ?").run(ids[0]);
  const snapshot = () => ({
    runs: app.db.prepare("SELECT * FROM automation_runs ORDER BY id").all(),
    rules: app.db.prepare("SELECT * FROM automation_rules ORDER BY id").all(),
    audit: app.db.prepare("SELECT * FROM audit_events ORDER BY rowid").all(),
  });
  const before = snapshot();
  const disabled = await post("/api/automation/rules/" + ids[0] + "/run", {});
  assert.equal(disabled.status, 409);
  assert.equal((await disabled.json()).status, "disabled_by_policy");
  assert.deepEqual(snapshot(), before);
  app.db.exec("UPDATE accounts SET source = 'provider'");
  const empty = await post("/api/automation/rules/" + ids[1] + "/run", {});
  assert.equal(empty.status, 409);
  assert.equal((await empty.json()).status, "no_synthetic_accounts");
  assert.deepEqual(snapshot(), before);
});

test("ORB-005 agency report separates synthetic hosting evidence from unverified providers and local readiness", async () => {
  const report = async () => {
    const response = await api("/api/agency/report");
    assert.equal(response.status, 200);
    return response.json();
  };
  const before = await report();
  assert.equal(before.reportVersion, 2);
  assert.equal(before.excludedProviderInventory.accountsCount, 0);
  const id = "acct-northstar";
  const excluded = before.accounts.find((account) => account.id === id);
  const excludedSites = app.db.prepare("SELECT COUNT(*) AS count FROM sites WHERE account_id = ?").get(id).count;
  app.db.prepare("UPDATE accounts SET source = 'provider' WHERE id = ?").run(id);
  const mixed = await report();
  assert.equal(mixed.measurementBoundary.hostingScope, "synthetic_accounts_only");
  assert.equal(mixed.measurementBoundary.localSystemScope, "organization");
  assert.equal(mixed.excludedProviderInventory.accountsCount, 1);
  assert.equal(mixed.excludedProviderInventory.sitesTotal, excludedSites);
  assert.ok(mixed.accounts.every((account) => account.source === "mock_fixture"));
  assert.equal(mixed.portfolio.accountsCount, before.portfolio.accountsCount - 1);
  assert.equal(mixed.portfolio.sitesTotal, before.portfolio.sitesTotal - excludedSites);
  assert.equal(mixed.portfolio.usedBytes, before.portfolio.usedBytes - excluded.usedBytes);
  assert.equal(mixed.portfolio.quotaBytes, before.portfolio.quotaBytes - excluded.quotaBytes);
  assert.equal(mixed.portfolio.sitesActive + mixed.portfolio.sitesAttention, mixed.portfolio.sitesTotal);
  assert.equal(mixed.readiness.verifiedSiteSnapshots, app.db.prepare("SELECT COUNT(*) AS count FROM site_snapshots ss JOIN sites s ON s.id = ss.site_id WHERE s.account_id <> ? AND ss.status = 'completed'").get(id).count);
  const policies = app.db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(estimated_reclaim_bytes), 0) AS bytes FROM storage_policies WHERE account_id <> ?").get(id);
  assert.equal(mixed.readiness.storageOffloadPolicies, policies.count);
  assert.equal(mixed.readiness.estimatedOffloadReclaimBytes, policies.bytes);
  const migrations = app.db.prepare("SELECT state, COUNT(*) AS count FROM migration_plans WHERE source_account_id <> ? AND target_account_id <> ? GROUP BY state").all(id, id);
  assert.deepEqual(mixed.readiness.migrationCountsByState, Object.fromEntries(migrations.map((entry) => [entry.state, entry.count])));
  app.db.exec("UPDATE accounts SET source = 'provider'");
  const empty = await report();
  assert.equal(empty.excludedProviderInventory.accountsCount, before.portfolio.accountsCount);
  assert.equal(empty.excludedProviderInventory.sitesTotal, before.portfolio.sitesTotal);
  assert.deepEqual(empty.accounts, []);
  assert.equal(empty.portfolio.accountsCount, 0);
  assert.equal(empty.portfolio.sitesTotal, 0);
  assert.equal(empty.portfolio.utilizationPercent, null);
  assert.equal(empty.readiness.verifiedSiteSnapshots, 0);
  assert.equal(empty.readiness.storageOffloadPolicies, 0);
  assert.equal(empty.readiness.estimatedOffloadReclaimBytes, 0);
  assert.deepEqual(empty.readiness.migrationCountsByState, {});
  for (const field of ["completedSystemBackups", "completedRestoreDrills", "activeTeamByRole"]) {
    assert.deepEqual(mixed.readiness[field], before.readiness[field]);
    assert.deepEqual(empty.readiness[field], before.readiness[field]);
  }
});

test("ORB-002 sandbox creation rejects invalid explicit capability profiles without writes", async () => {
  const state = () => ["accounts", "sites", "capability_snapshots", "audit_events"].map((table) =>
    app.db.prepare("SELECT COUNT(*) AS count FROM " + table).get().count);
  const before = state();
  const create = (input) => api("/api/accounts/sandbox", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "Synthetic profile regression", username: "profile_ci", host: "cp.example.org", quotaGb: 10, ...input }),
  });
  for (const capabilityProfile of ["constructor", "__proto__", "toString", "unknown-profile", null, 42, {}]) {
    const response = await create({ capabilityProfile });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_capability_profile" });
    assert.deepEqual(state(), before);
  }
  const created = await create({ capabilityProfile: "cpanel_uapi_restricted" });
  assert.equal(created.status, 201);
  const account = app.db.prepare("SELECT capability_profile FROM accounts WHERE username = ?").get("profile_ci");
  assert.equal(account.capability_profile, "cpanel_uapi_restricted");
});
