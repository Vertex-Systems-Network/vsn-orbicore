import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../apps/api/server.mjs";

async function createFixture() {
  const app = createApp({
    dbPath: ":memory:",
    startWorker: false,
    bootstrapToken: "ci-cookie-proxy-bootstrap-token-32b",
  });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  return app;
}

test("ORB-005 HTTPS-proxied bootstrap and logout keep SameSite Strict while using Secure", async () => {
  const app = await createFixture();
  try {
    const host = `127.0.0.1:${app.server.address().port}`;
    const target = `http://${host}`;
    // Synthetic local, loopback-only TLS termination metadata. No external
    // HTTP service or production reverse proxy is contacted.
    const headers = {
      origin: `https://${host}`,
      "x-forwarded-host": host,
      "x-forwarded-proto": "https",
      "content-type": "application/json",
    };
    const boot = await fetch(`${target}/api/auth/bootstrap`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        token: "ci-cookie-proxy-bootstrap-token-32b",
        email: "proxied-cookie@example.test",
        password: "proxied-cookie-password-32-bytes",
      }),
    });
    assert.equal(boot.status, 201);
    const setCookie = boot.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /; Secure/);
    assert.doesNotMatch(setCookie, /SameSite=None/);
    const session = setCookie.split(";")[0];
    const logout = await fetch(`${target}/api/auth/logout`, {
      method: "POST",
      headers: { ...headers, cookie: session },
    });
    assert.equal(logout.status, 200);
    const expiredCookie = logout.headers.get("set-cookie");
    assert.match(expiredCookie, /SameSite=Strict/);
    assert.match(expiredCookie, /Max-Age=0/);
    assert.match(expiredCookie, /; Secure/);
    assert.doesNotMatch(expiredCookie, /SameSite=None/);
  } finally {
    app.close();
  }
});

test("ORB-005 direct local HTTP session remains Strict without claiming TLS", async () => {
  const app = await createFixture();
  try {
    const host = `127.0.0.1:${app.server.address().port}`;
    const boot = await fetch(`http://${host}/api/auth/bootstrap`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `http://${host}`,
      },
      body: JSON.stringify({
        token: "ci-cookie-proxy-bootstrap-token-32b",
        email: "plain-cookie@example.test",
        password: "plain-cookie-password-32-bytes",
      }),
    });
    assert.equal(boot.status, 201);
    const cookie = boot.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.doesNotMatch(cookie, /; Secure/);
    assert.doesNotMatch(cookie, /SameSite=None/);
  } finally {
    app.close();
  }
});
