import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, isAllowedFetchSite } from "../apps/api/server.mjs";

test("ORB-005 Fetch Metadata rejects cross-site, same-site and malformed browser claims without weakening CLI", () => {
  for (const value of ["cross-site", "same-site", "", "same-origin, cross-site", "SAME-ORIGIN", "unknown", ["same-origin", "cross-site"]]) {
    assert.equal(isAllowedFetchSite({ headers: { "sec-fetch-site": value } }), false, String(value));
  }
  for (const value of ["same-origin", "none"]) {
    assert.equal(isAllowedFetchSite({ headers: { "sec-fetch-site": value } }), true, value);
  }
  assert.equal(isAllowedFetchSite({ headers: {} }), true, "non-browser API client missing metadata remains supported");
  assert.equal(isAllowedFetchSite({}), true, "undefined headers remain supported");
});

test("ORB-005 HTTP owner bootstrap refuses untrusted Fetch Metadata even without Origin before DB mutation", async () => {
  const token = "ci-fetch-metadata-owner-bootstrap-token";
  const app = createApp({ dbPath: ":memory:", startWorker: false, bootstrapToken: token });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const host = "127.0.0.1:" + app.server.address().port;
  const url = "http://" + host + "/api/auth/bootstrap";
  const body = JSON.stringify({
    token, email: "owner@example.test", password: "ci-fetch-metadata-owner-password-29",
  });
  async function submit(extraHeaders = {}) {
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...extraHeaders },
      body,
    });
  }
  try {
    for (const metadata of ["cross-site", "same-site", "nonsense", "same-origin, cross-site"]) {
      for (const origin of [undefined, "http://" + host]) {
        const headers = { "sec-fetch-site": metadata };
        if (origin) headers.origin = origin;
        const response = await submit(headers);
        assert.equal(response.status, 403, metadata);
        assert.equal((await response.json()).error, "fetch_metadata_denied");
        assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 0);
      }
    }
    const allowed = await submit({ "sec-fetch-site": "same-origin", origin: "http://" + host });
    assert.equal(allowed.status, 201);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 1);
  } finally {
    app.close();
  }
});

test("ORB-005 authenticated API writes reject same-site siblings and cross-site metadata even with a matching Origin", async () => {
  const token = "ci-fetch-metadata-authenticated-token";
  const app = createApp({ dbPath: ":memory:", startWorker: false, bootstrapToken: token });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const base = "http://127.0.0.1:" + app.server.address().port;
  try {
    const boot = await fetch(base + "/api/auth/bootstrap", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, email: "owner@example.test", password: "ci-fetch-metadata-auth-password-29" }),
    });
    assert.equal(boot.status, 201);
    const cookie = boot.headers.get("set-cookie").split(";")[0];
    const before = app.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n;
    const params = {
      method: "POST",
      body: JSON.stringify({ host: "cp.example.org", label: "Synthetic", username: "ci_user", quotaGb: 50 }),
    };
    for (const site of ["same-site", "cross-site"]) {
      const denied = await fetch(base + "/api/accounts/sandbox", {
        ...params,
        headers: { cookie, "content-type": "application/json", origin: base, "sec-fetch-site": site },
      });
      assert.equal(denied.status, 403, site);
      assert.equal((await denied.json()).error, "fetch_metadata_denied");
    }
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, before);
    const allowed = await fetch(base + "/api/accounts/sandbox", {
      ...params,
      headers: { cookie, "content-type": "application/json", "sec-fetch-site": "none" },
    });
    assert.equal(allowed.status, 201, "CLI-style request without Origin retains existing contract");
    assert.equal((await allowed.json()).live, false);
  } finally {
    app.close();
  }
});
