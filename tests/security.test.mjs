import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { isBlockedNetworkAddress, redactSecrets, resolveContainedPath, validateExternalEndpoint } from "../apps/api/security.mjs";
import { createApp } from "../apps/api/server.mjs";
import { runSupplyChainGate } from "../scripts/security-gate.mjs";

test("SSRF guard rejects loopback, private, metadata, and IPv4-mapped IPv6 addresses", () => {
  for (const host of [
    "localhost",
    "sub.localhost",
    "127.0.0.1",
    "10.0.0.5",
    "172.16.4.20",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
  ]) {
    assert.equal(isBlockedNetworkAddress(host), true, `expected ${host} to be blocked`);
  }
  assert.equal(isBlockedNetworkAddress("cpanel.example.org"), false);
  assert.equal(validateExternalEndpoint("https://169.254.169.254/latest/meta-data").valid, false);
  assert.equal(validateExternalEndpoint("http://s3.example.org", { requireHttps: true }).reason, "https_required");
  assert.equal(validateExternalEndpoint("https://user:pass@s3.example.org").reason, "embedded_credentials_forbidden");
  assert.equal(validateExternalEndpoint("https://evil.example.net", { allowedHosts: ["example.org"] }).reason, "host_not_in_allowlist");
  assert.equal(validateExternalEndpoint("https://s3.example.org", { allowedHosts: ["example.org"] }).valid, true);
});

test("path containment rejects traversal, prefix escapes, and null bytes", () => {
  const baseDir = resolve("/tmp/orbicore-safe-base");
  assert.equal(resolveContainedPath(baseDir, "backups/snap.sqlite"), resolve(baseDir, "backups/snap.sqlite"));
  assert.throws(() => resolveContainedPath(baseDir, "../../etc/passwd"), /escapes/);
  assert.throws(() => resolveContainedPath(baseDir, "../orbicore-safe-base2/file"), /escapes/);
  assert.throws(() => resolveContainedPath(baseDir, "file\0.txt"), /Invalid/);
});

test("secret redaction masks nested credential keys", () => {
  const redacted = redactSecrets({
    host: "cpanel.example.org",
    password: "secret-password",
    nested: { api_key: "abc", token: "xyz", safe: 42 },
  });
  assert.equal(redacted.host, "cpanel.example.org");
  assert.equal(redacted.password, "[REDACTED]");
  assert.equal(redacted.nested.api_key, "[REDACTED]");
  assert.equal(redacted.nested.token, "[REDACTED]");
  assert.equal(redacted.nested.safe, 42);
});

test("ORB-015: supply-chain gate verifies zero leaked secrets, allowed licenses, and CycloneDX SBOM", () => {
  const report = runSupplyChainGate();
  assert.equal(report.passed, true);
  assert.equal(report.secretFindings.length, 0);
  assert.equal(report.disallowedLicenses.length, 0);
  assert.equal(report.sbomSummary.bomFormat, "CycloneDX");
  assert.ok(report.sbomSummary.componentsCount >= 3);
});

test("SEC-INJECTION-001: SQL, shell, and HTML injection payloads cannot bypass auth or alter parameterized SQLite tables", async () => {
  const token = "injection-suite-bootstrap-token-32b";
  const app = createApp({ dbPath: ":memory:", startWorker: false, bootstrapToken: token });
  await new Promise((resolveListen, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolveListen);
  });
  try {
    const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
    const boot = await fetch(`${baseUrl}/api/auth/bootstrap`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, email: "owner@example.test", password: "owner-injection-test-99" }),
    });
    assert.equal(boot.status, 201);
    const cookie = boot.headers.get("set-cookie").split(";")[0];

    // SQLi attempt in login email fails cleanly without auth bypass
    const sqliLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "' OR 1=1 --", password: "' OR '1'='1" }),
    });
    assert.equal(sqliLogin.status, 401);

    // SQL/shell/XSS payload in automation rule name is bound safely as plain text without dropping tables
    const ruleName = "Ops $(id) '; DROP TABLE users; -- <script>alert(1)</script>";
    const ruleRes = await fetch(`${baseUrl}/api/automation/rules`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: ruleName, ruleType: "quota_threshold_alert", approvalMode: "manual_approval", dailyRunCap: 2 }),
    });
    assert.equal(ruleRes.status, 201);
    const { rule } = await ruleRes.json();
    assert.equal(rule.name, ruleName);

    // Confirm users & schema tables remain intact and parameter-safe
    const userCount = app.db.prepare("SELECT COUNT(*) AS cnt FROM users").get().cnt;
    assert.equal(userCount, 1);

    // Command/path injection username rejected on sandbox account creation
    const badUser = await fetch(`${baseUrl}/api/accounts/sandbox`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "Test", host: "cp.example.org", username: "bad;id", quotaGb: 20 }),
    });
    assert.equal(badUser.status, 400);
  } finally {
    app.close();
  }
});

test("KI-001 audit integrity: SHA-256 hash chain verifies authentic logs and detects direct SQLite row tampering", async () => {
  const token = "audit-chain-bootstrap-token-32b";
  const app = createApp({ dbPath: ":memory:", startWorker: false, bootstrapToken: token });
  await new Promise((resolveListen, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolveListen);
  });
  try {
    const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
    const boot = await fetch(`${baseUrl}/api/auth/bootstrap`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, email: "owner@example.test", password: "owner-audit-passphrase-99" }),
    });
    assert.equal(boot.status, 201);
    const cookie = boot.headers.get("set-cookie").split(";")[0];

    const ruleRes = await fetch(`${baseUrl}/api/automation/rules`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Audit chain check rule", ruleType: "quota_threshold_alert", approvalMode: "manual_approval", dailyRunCap: 2 }),
    });
    assert.equal(ruleRes.status, 201);

    const verifiedRes = await fetch(`${baseUrl}/api/audit/verify`, { headers: { cookie } });
    assert.equal(verifiedRes.status, 200);
    const verified = await verifiedRes.json();
    assert.equal(verified.valid, true);
    assert.ok(verified.checkedCount >= 2);
    assert.equal(verified.brokenAtId, null);

    // Direct SQLite tampering must break chain verification
    const targetRow = app.db.prepare("SELECT id FROM audit_events WHERE action = 'automation.rule.create'").get();
    app.db.prepare("UPDATE audit_events SET outcome = 'tampered' WHERE id = ?").run(targetRow.id);

    const brokenRes = await fetch(`${baseUrl}/api/audit/verify`, { headers: { cookie } });
    assert.equal(brokenRes.status, 200);
    const broken = await brokenRes.json();
    assert.equal(broken.valid, false);
    assert.equal(broken.brokenAtId, targetRow.id);
    assert.equal(broken.reason, "entry_hash_mismatch");
  } finally {
    app.close();
  }
});

test("Encrypted secret references fail closed without MFA key, encrypt at rest with SSRF guard, and purge on owner revocation", async () => {
  const token = "secrets-registry-bootstrap-token-32";
  // 1. Fail closed when encryption key missing
  const noKeyApp = createApp({ dbPath: ":memory:", startWorker: false, bootstrapToken: token });
  await new Promise((resolveListen, reject) => { noKeyApp.server.once("error", reject); noKeyApp.server.listen(0, "127.0.0.1", resolveListen); });
  try {
    const baseUrl = `http://127.0.0.1:${noKeyApp.server.address().port}`;
    const boot = await fetch(`${baseUrl}/api/auth/bootstrap`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, email: "owner@example.test", password: "owner-secrets-passphrase-99" }),
    });
    const cookie = boot.headers.get("set-cookie").split(";")[0];
    const failRes = await fetch(`${baseUrl}/api/secrets`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "cPanel token", kind: "cpanel_uapi_token", referenceUri: "https://cp.example.org:2083", secretValue: "super-secret-value-1234" }),
    });
    assert.equal(failRes.status, 503);
  } finally {
    noKeyApp.close();
  }

  // 2. Encrypts at rest, blocks SSRF loopback URI, masks API output, and purges ciphertext on revocation
  const keyBase64 = Buffer.alloc(32, 7).toString("base64");
  const app = createApp({ dbPath: ":memory:", startWorker: false, bootstrapToken: token, mfaKey: keyBase64 });
  await new Promise((resolveListen, reject) => { app.server.once("error", reject); app.server.listen(0, "127.0.0.1", resolveListen); });
  try {
    const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
    const boot = await fetch(`${baseUrl}/api/auth/bootstrap`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, email: "owner@example.test", password: "owner-secrets-passphrase-99" }),
    });
    const cookie = boot.headers.get("set-cookie").split(";")[0];

    const ssrfRes = await fetch(`${baseUrl}/api/secrets`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "Bad SSRF", kind: "s3_access_key", referenceUri: "http://127.0.0.1:9000", secretValue: "secret-val-9999" }),
    });
    assert.equal(ssrfRes.status, 400);

    const rawSecret = "live-uapi-token-ABCD9876";
    const createRes = await fetch(`${baseUrl}/api/secrets`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "Northstar UAPI", kind: "cpanel_uapi_token", referenceUri: "https://cp.example.org:2083", secretValue: rawSecret }),
    });
    assert.equal(createRes.status, 201);
    const { secret } = await createRes.json();
    assert.equal(secret.maskedPreview, "••••9876");
    assert.equal(secret.encryptedPayload, undefined);

    const listRes = await fetch(`${baseUrl}/api/secrets`, { headers: { cookie } });
    const listText = await listRes.text();
    assert.equal(listRes.status, 200);
    assert.equal(listText.includes(rawSecret), false);

    const dbRow = app.db.prepare("SELECT encrypted_payload FROM secret_references WHERE id = ?").get(secret.id);
    assert.ok(dbRow.encrypted_payload.length > 20);
    assert.equal(dbRow.encrypted_payload.includes(rawSecret), false);

    const revokeRes = await fetch(`${baseUrl}/api/secrets/${secret.id}/revoke`, { method: "POST", headers: { cookie } });
    assert.equal(revokeRes.status, 200);
    const revokedRow = app.db.prepare("SELECT status, encrypted_payload FROM secret_references WHERE id = ?").get(secret.id);
    assert.equal(revokedRow.status, "revoked");
    assert.equal(revokedRow.encrypted_payload, "");
  } finally {
    app.close();
  }
});


