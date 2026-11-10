import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, test } from "node:test";
import { createApp } from "../apps/api/server.mjs";
import { decryptMfaSecret, encodeBase32, encryptMfaSecret, mfaEncryptionKey, recoveryCodeHash, totpAt, verifyTotp } from "../apps/api/mfa.mjs";

const keyString = randomBytes(32).toString("base64");
const key = mfaEncryptionKey(keyString);
const bootstrapToken = "mfa-test-bootstrap-token-long-enough";
let app;
let baseUrl;
let cookie;
let clockMs;

async function setup() {
  clockMs = 1_700_000_000_000;
  app = createApp({ dbPath: ":memory:", startWorker: false, bootstrapToken, mfaKey: keyString, mfaClock: () => clockMs });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(`${baseUrl}/api/auth/bootstrap`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: bootstrapToken, email: "owner@example.test", password: "unique-test-password-123" }),
  });
  assert.equal(response.status, 201);
  cookie = response.headers.get("set-cookie").split(";")[0];
}

afterEach(() => app?.close());

test("TOTP follows RFC 6238 and rejects a previously accepted time step", () => {
  const secret = encodeBase32(Buffer.from("12345678901234567890"));
  assert.equal(totpAt(secret, 59), "287082");
  const accepted = verifyTotp(secret, "287082", 59_000);
  assert.equal(accepted, 1);
  assert.equal(verifyTotp(secret, "287082", 59_000, accepted), null);
});

test("MFA seed is authenticated encrypted data and requires a 32-byte external key", () => {
  const secret = encodeBase32(randomBytes(20));
  const encrypted = encryptMfaSecret(secret, key);
  assert.notEqual(encrypted, secret);
  assert.equal(decryptMfaSecret(encrypted, key), secret);
  assert.throws(() => decryptMfaSecret(encrypted, randomBytes(32)));
  assert.equal(mfaEncryptionKey("not-a-key"), null);
});

test("owner enrollment requires a valid TOTP and stores only recovery-code hashes", async () => {
  await setup();
  const denied = await fetch(`${baseUrl}/api/auth/mfa/enroll`, { method: "POST" });
  assert.equal(denied.status, 401);
  const wrongPassword = await fetch(`${baseUrl}/api/auth/mfa/enroll`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ password: "wrong-password" }) });
  assert.equal(wrongPassword.status, 401);
  const enrolled = await fetch(`${baseUrl}/api/auth/mfa/enroll`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ password: "unique-test-password-123" }) });
  assert.equal(enrolled.status, 201);
  const enrollment = await enrolled.json();
  assert.match(enrollment.otpauthUri, /^otpauth:\/\/totp\//);
  assert.equal(enrollment.assurance, "totp_fallback_not_phishing_resistant");
  const badCode = String((Number(totpAt(enrollment.secret, Math.floor(clockMs / 30_000) * 30)) + 1) % 1_000_000).padStart(6, "0");
  const bad = await fetch(`${baseUrl}/api/auth/mfa/confirm`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ code: badCode }) });
  assert.equal(bad.status, 401);
  const goodCode = totpAt(enrollment.secret, Math.floor(clockMs / 30_000) * 30);
  const confirmed = await fetch(`${baseUrl}/api/auth/mfa/confirm`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ code: goodCode }) });
  assert.equal(confirmed.status, 200);
  const result = await confirmed.json();
  assert.equal(result.recoveryCodes.length, 10);
  assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } })).status, 401);
  const verifiedCookie = confirmed.headers.get("set-cookie").split(";")[0];
  const verifiedSession = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: verifiedCookie } }).then((response) => response.json());
  assert.equal(verifiedSession.user.mfaEnabled, 1);
  const storedSeed = app.db.prepare("SELECT encrypted_secret FROM authenticators WHERE user_id = (SELECT id FROM users WHERE email = 'owner@example.test')").get().encrypted_secret;
  assert.equal(storedSeed.includes(enrollment.secret), false);
  assert.equal(decryptMfaSecret(storedSeed, key), enrollment.secret);
  const stored = app.db.prepare("SELECT code_hash, used_at FROM recovery_codes").all();
  assert.equal(stored.length, 10);
  assert.equal(stored.some((row) => result.recoveryCodes.some((code) => row.code_hash === code)), false);
  assert.equal(stored[0].used_at, null);
  assert.equal(app.db.prepare("SELECT mfa_enabled FROM users").get().mfa_enabled, 1);
});

test("MFA login with TOTP is one-time and recovery login consumes code, revokes prior sessions and records undelivered notification", async () => {
  await setup();
  const enrollment = await fetch(`${baseUrl}/api/auth/mfa/enroll`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ password: "unique-test-password-123" }) }).then((response) => response.json());
  const firstCode = totpAt(enrollment.secret, Math.floor(clockMs / 30_000) * 30);
  const confirmation = await fetch(`${baseUrl}/api/auth/mfa/confirm`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ code: firstCode }) }).then((response) => response.json());
  const passwordLogin = () => fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@example.test", password: "unique-test-password-123" }),
  });
  const pending = await passwordLogin();
  assert.equal(pending.status, 202);
  const { challenge } = await pending.json();
  clockMs += 30_000;
  const loginCode = totpAt(enrollment.secret, Math.floor(clockMs / 30_000) * 30);
  const finished = await fetch(`${baseUrl}/api/auth/mfa/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge, code: loginCode }) });
  assert.equal(finished.status, 200);
  const authenticatedCookie = finished.headers.get("set-cookie").split(";")[0];
  const replayChallenge = await passwordLogin().then((response) => response.json());
  const replay = await fetch(`${baseUrl}/api/auth/mfa/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge: replayChallenge.challenge, code: loginCode }) });
  assert.equal(replay.status, 401);

  const recoveryChallenge = await passwordLogin().then((response) => response.json());
  const recoveryCode = confirmation.recoveryCodes[0];
  const recovery = await fetch(`${baseUrl}/api/auth/mfa/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge: recoveryChallenge.challenge, code: recoveryCode }) });
  assert.equal(recovery.status, 200);
  assert.equal((await recovery.json()).notification, "queued_contact_unverified");
  const afterRecoveryCookie = recovery.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: authenticatedCookie } })).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: afterRecoveryCookie } })).status, 200);
  assert.equal(app.db.prepare("SELECT used_at FROM recovery_codes WHERE code_hash = ?").get(recoveryCodeHash(recoveryCode)).used_at !== null, true);
  assert.equal(app.db.prepare("SELECT status FROM notification_outbox").get().status, "blocked_unverified_contact");
  assert.equal(app.db.prepare("SELECT action FROM audit_events WHERE action = 'auth.mfa_recovery_code_used'").get().action, "auth.mfa_recovery_code_used");
  clockMs += 30_000;
  const disableCode = totpAt(enrollment.secret, Math.floor(clockMs / 30_000) * 30);
  const disabled = await fetch(`${baseUrl}/api/auth/mfa/disable`, {
    method: "POST", headers: { cookie: afterRecoveryCookie, "content-type": "application/json" },
    body: JSON.stringify({ password: "unique-test-password-123", code: disableCode }),
  });
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json()).sessionsRevoked, true);
  assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: afterRecoveryCookie } })).status, 401);
  assert.equal(app.db.prepare("SELECT mfa_enabled FROM users WHERE email = 'owner@example.test'").get().mfa_enabled, 0);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM recovery_codes").get().count, 0);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM authenticators").get().count, 0);
});

test("MFA challenge expiry and bad-code lockout fail closed", async () => {
  await setup();
  const enrollment = await fetch(`${baseUrl}/api/auth/mfa/enroll`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ password: "unique-test-password-123" }) }).then((response) => response.json());
  const enrollCode = totpAt(enrollment.secret, Math.floor(clockMs / 30_000) * 30);
  await fetch(`${baseUrl}/api/auth/mfa/confirm`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ code: enrollCode }) });
  clockMs += 30_000;
  const login = async () => fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@example.test", password: "unique-test-password-123" }) }).then((response) => response.json());
  const expired = await login();
  const expiredHash = createHash("sha256").update(expired.challenge).digest("hex");
  app.db.prepare("UPDATE login_challenges SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token_hash = ?").run(expiredHash);
  const stale = await fetch(`${baseUrl}/api/auth/mfa/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge: expired.challenge, code: totpAt(enrollment.secret, Math.floor(clockMs / 30_000) * 30) }) });
  assert.equal(stale.status, 401);
  const current = await login();
  const validCode = totpAt(enrollment.secret, Math.floor(clockMs / 30_000) * 30);
  const invalidCode = String((Number(validCode) + 1) % 1_000_000).padStart(6, "0");
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/auth/mfa/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge: current.challenge, code: invalidCode }) });
    assert.equal(response.status, 401);
  }
  const locked = await fetch(`${baseUrl}/api/auth/mfa/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge: current.challenge, code: validCode }) });
  assert.equal(locked.status, 429);
});

test("MFA enrollment refuses when the external encryption key is unavailable", async () => {
  app = createApp({ dbPath: ":memory:", startWorker: false, bootstrapToken });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(`${baseUrl}/api/auth/bootstrap`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: bootstrapToken, email: "owner@example.test", password: "unique-test-password-123" }),
  });
  const noKeyCookie = response.headers.get("set-cookie").split(";")[0];
  const enrollment = await fetch(`${baseUrl}/api/auth/mfa/enroll`, { method: "POST", headers: { cookie: noKeyCookie } });
  assert.equal(enrollment.status, 503);
  assert.equal((await enrollment.json()).error, "mfa_key_unavailable");
  app.db.prepare("UPDATE users SET mfa_enabled = 1 WHERE email = 'owner@example.test'").run();
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@example.test", password: "unique-test-password-123" }),
  });
  assert.equal(login.status, 503);
  assert.equal(login.headers.get("set-cookie"), null);
});


test("passkey registration binds one-time challenges to origin and expires them", async () => {
  await setup();
  const optionsResponse = await fetch(`${baseUrl}/api/auth/passkeys/register/options`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ password: "unique-test-password-123" }),
  });
  assert.equal(optionsResponse.status, 200);
  const { challengeHandle, options } = await optionsResponse.json();
  const evilClientData = Buffer.from(JSON.stringify({
    type: "webauthn.create",
    challenge: options.challenge,
    origin: "https://evil.example",
    crossOrigin: false,
  })).toString("base64url");
  const rejected = await fetch(`${baseUrl}/api/auth/passkeys/register/verify`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ challengeHandle, response: {
      id: "credential", rawId: Buffer.from("credential").toString("base64url"), type: "public-key",
      response: { clientDataJSON: evilClientData, attestationObject: "oA" },
    } }),
  });
  assert.equal(rejected.status, 401);
  const replay = await fetch(`${baseUrl}/api/auth/passkeys/register/verify`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ challengeHandle, response: {} }),
  });
  assert.equal(replay.status, 410);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM passkeys").get().count, 0);

  const nextOptions = await fetch(`${baseUrl}/api/auth/passkeys/register/options`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ password: "unique-test-password-123" }),
  }).then((response) => response.json());
  app.db.prepare("UPDATE webauthn_challenges SET expires_at = '2000-01-01T00:00:00.000Z' WHERE handle_hash = ?")
    .run(createHash("sha256").update(nextOptions.challengeHandle).digest("hex"));
  const expired = await fetch(`${baseUrl}/api/auth/passkeys/register/verify`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ challengeHandle: nextOptions.challengeHandle, response: {} }),
  });
  assert.equal(expired.status, 410);
});

test("passkey login options require an enrolled credential without revealing account state", async () => {
  await setup();
  const response = await fetch(`${baseUrl}/api/auth/passkeys/login/options`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@example.test" }),
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "passkey_unavailable" });
});
