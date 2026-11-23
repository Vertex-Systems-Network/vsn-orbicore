import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, isSameOriginRequest } from "../apps/api/server.mjs";

test("ORB-005 Origin gate compares scheme, host, port and strict origin syntax", () => {
  const direct = {
    socket: { remoteAddress: "198.51.100.10", encrypted: false },
    headers: { host: "app.example.test:41751", origin: "http://app.example.test:41751" },
  };
  assert.equal(isSameOriginRequest(direct), true);
  for (const origin of [
    "https://app.example.test:41751",
    "http://app.example.test:41752",
    "http://attacker.example:41751",
    "http://app.example.test:41751/path",
    "http://app.example.test:41751/?q=1",
    "http://user@app.example.test:41751",
    "null",
    "",
  ]) {
    assert.equal(isSameOriginRequest({ ...direct, headers: { ...direct.headers, origin } }), false, origin);
  }
  assert.equal(isSameOriginRequest({ ...direct, headers: { host: "app.example.test:41751" } }), false);
  assert.equal(isSameOriginRequest({ ...direct, headers: { ...direct.headers, host: "user@app.example.test:41751" } }), false);

  const trustedHttps = {
    socket: { remoteAddress: "127.0.0.1" },
    headers: {
      host: "127.0.0.1:41751",
      "x-forwarded-host": "app.example.test",
      "x-forwarded-proto": "https",
      origin: "https://app.example.test",
    },
  };
  assert.equal(isSameOriginRequest(trustedHttps), true);
  assert.equal(isSameOriginRequest({
    ...trustedHttps, headers: { ...trustedHttps.headers, origin: "http://app.example.test" },
  }), false);
  const directTls = {
    socket: { remoteAddress: "198.51.100.10", encrypted: true },
    headers: { host: "app.example.test", origin: "https://app.example.test" },
  };
  assert.equal(isSameOriginRequest(directTls), true);
  assert.equal(isSameOriginRequest({ ...directTls, headers: { ...directTls.headers, origin: "http://app.example.test" } }), false);
  const untrustedForwarder = {
    ...direct,
    headers: { ...direct.headers, "x-forwarded-proto": "https", "x-forwarded-host": "app.example.test" },
  };
  assert.equal(isSameOriginRequest(untrustedForwarder), true);
  assert.equal(isSameOriginRequest({
    ...untrustedForwarder,
    headers: { ...untrustedForwarder.headers, origin: "https://app.example.test:41751" },
  }), false);
});

test("ORB-005 actual HTTP bootstrap rejects matching-host cross-scheme Origin before mutation", async () => {
  const app = createApp({
    dbPath: ":memory:",
    startWorker: false,
    bootstrapToken: "origin-regression-bootstrap-token-32b",
  });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const host = `127.0.0.1:${app.server.address().port}`;
    const url = `http://${host}/api/auth/bootstrap`;
    const body = JSON.stringify({
      token: "origin-regression-bootstrap-token-32b",
      email: "origin-test@example.test",
      password: "origin-test-password-32bytes",
    });
    const submit = (origin) => fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body,
    });
    const blocked = await submit(`https://${host}`);
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error, "origin_denied");
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 0);

    const valid = await submit(`http://${host}`);
    assert.equal(valid.status, 201);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 1);
  } finally {
    app.close();
  }
});
