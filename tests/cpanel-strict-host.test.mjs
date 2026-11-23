import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../apps/api/server.mjs";
import { LiveCpanelAdapterBoundary } from "../apps/api/cpanel-adapter.mjs";
import { validateCpanelApiHost } from "../apps/api/security.mjs";

const ref = {
  host: "cp.example.org",
  authorized: true,
  username: "ci-reader",
  apiToken: "synthetic-no-network-credential",
};

test("ORB-010 cPanel host policy rejects URL components, credentials and nonstandard ports", () => {
  const unsafe = [
    "cp.example.org/path", "cp.example.org?target=other", "cp.example.org#fragment",
    "cp.example.org:443", "cp.example.org:2083", "https://cp.example.org",
    "ci-reader@cp.example.org", "cp.example.org\\subdir", "cp.example.org\n",
    " cp.example.org", "cp.example.org ", "cp.example.org%2Fother",
    "cp.example.org/../evil", "cp.example.org:443/execute", "",
    "http://127.0.0.1", "[2001:4860:4860::8888]:2083",
  ];
  for (const host of unsafe) {
    const result = validateCpanelApiHost(host);
    assert.equal(result.valid, false, JSON.stringify(host));
    assert.equal(result.reason, "invalid_cpanel_host", JSON.stringify(host));
  }
  for (const host of ["localhost", "localhost.", "127.0.0.1", "169.254.169.254", "[::1]", "[::ffff:a9fe:a9fe]"]) {
    assert.equal(validateCpanelApiHost(host).reason, "blocked_private_or_loopback_host", host);
  }
  for (const host of ["cp.example.org", "CP.EXAMPLE.ORG", "cp.example.org.", "[2001:4860:4860::8888]"]) {
    const validated = validateCpanelApiHost(host);
    assert.equal(validated.valid, true, host);
    assert.equal(new URL(validated.origin).port, "2083", host);
    assert.equal(new URL(validated.origin).pathname, "/", host);
  }
});

test("ORB-006 cPanel credentialed fetch remains on port 2083; malformed host never invokes transport", async () => {
  const seen = [];
  const adapter = new LiveCpanelAdapterBoundary({
    fetchImpl: async (url, init) => {
      seen.push({ url, method: init.method, redirect: init.redirect, authorization: init.headers.Authorization });
      return new Response(JSON.stringify({ status: 1, data: { main_domain: { domain: "example.org" } } }), { status: 200 });
    },
  });
  for (const host of [
    "cp.example.org/path", "cp.example.org?x=1", "cp.example.org#x",
    "cp.example.org:443", "https://cp.example.org", "localhost",
    "169.254.169.254", "[::1]",
  ]) {
    const result = await adapter.fetchInventory({ ...ref, host });
    assert.equal(result.ok, false, host);
    assert.deepEqual(result.sites, [], host);
  }
  assert.equal(seen.length, 0, "malformed or local host must fail before fetch and Authorization header");
  const ok = await adapter.fetchInventory({ ...ref, host: "CP.EXAMPLE.ORG" });
  assert.equal(ok.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://cp.example.org:2083/execute/DomainInfo/domains_data");
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].redirect, "manual");
  assert.equal(seen[0].authorization, `cpanel ${ref.username}:${ref.apiToken}`);
  assert.equal(JSON.stringify(ok).includes(ref.apiToken), false);
});

test("ORB-010 real local HTTP cPanel probe and synthetic account reject URL-shaped host inputs", async () => {
  const token = "strict-cpanel-host-local-bootstrap-token";
  const app = createApp({ dbPath: ":memory:", startWorker: false, bootstrapToken: token });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function post(route, body, cookie) {
    return fetch(`${base}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  }
  try {
    const boot = await post("/api/auth/bootstrap", {
      token, email: "owner@example.test", password: "strict-cpanel-host-password-24",
    });
    assert.equal(boot.status, 201);
    const cookie = boot.headers.get("set-cookie").split(";")[0];
    const before = app.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n;
    for (const host of ["cp.example.org/path", "cp.example.org?query=1", "https://cp.example.org", "cp.example.org:443"]) {
      const payload = { host, label: "Sandbox", username: "sandbox_ci", quotaGb: 50 };
      const sandbox = await post("/api/accounts/sandbox", payload, cookie);
      assert.equal(sandbox.status, 400, host);
      assert.equal((await sandbox.json()).error, "invalid_cpanel_host");
      const probe = await post("/api/accounts/cpanel/probe", { host }, cookie);
      assert.equal(probe.status, 400, host);
      assert.equal((await probe.json()).error, "invalid_cpanel_host");
    }
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, before);
    const accepted = await post("/api/accounts/sandbox", {
      host: "CP.EXAMPLE.ORG", label: "Fixture only", username: "sandbox_ci", quotaGb: 50,
    }, cookie);
    assert.equal(accepted.status, 201);
    const data = await accepted.json();
    assert.equal(data.account.host, "cp.example.org");
    assert.equal(data.live, false);
    const probe = await post("/api/accounts/cpanel/probe", { host: "CP.EXAMPLE.ORG" }, cookie);
    assert.equal(probe.status, 200);
    assert.equal((await probe.json()).liveConnections, 0);
  } finally {
    app.close();
  }
});
