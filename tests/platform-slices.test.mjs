import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { LiveCpanelAdapterBoundary } from "../apps/api/cpanel-adapter.mjs";
import { totpAt } from "../apps/api/mfa.mjs";
import { verifyBackupFile } from "../apps/api/preflight.mjs";
import { createApp } from "../apps/api/server.mjs";

const cleanups = [];
afterEach(() => {
  while (cleanups.length) {
    try { cleanups.pop()(); } catch { /* ignore cleanup errors */ }
  }
});

async function startBootstrappedApp(options = {}) {
  const bootstrapToken = "platform-slice-bootstrap-token-32b";
  const app = createApp({ dbPath: ":memory:", startWorker: false, bootstrapToken, ...options });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(() => app.close());
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const res = await fetch(`${baseUrl}/api/auth/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: bootstrapToken, email: "owner@example.test", password: "owner-test-passphrase-99" }),
  });
  assert.equal(res.status, 201);
  const cookie = res.headers.get("set-cookie").split(";")[0];
  return { app, baseUrl, cookie };
}

test("ORB-007 & ORB-014: preflight diagnostics, SQLite backup verification, and MFA key rotation preserve auth", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "orbicore-backup-"));
  cleanups.push(() => rmSync(workDir, { recursive: true, force: true }));
  const key1 = randomBytes(32).toString("base64");
  const key2 = randomBytes(32).toString("base64");
  let clockMs = 1_700_000_000_000;
  const dbPath = join(workDir, "orbicore.sqlite");

  const { baseUrl, cookie } = await startBootstrappedApp({
    dbPath,
    mfaKey: key1,
    mfaKeyId: "k1",
    mfaClock: () => clockMs,
  });

  // Override the in-memory app created by helper? Helper used ":memory:", so test file-backed app directly
  const fileToken = "file-bootstrap-token-at-least-32-chars";
  const fileApp = createApp({ dbPath: join(workDir, "live.sqlite"), startWorker: false, bootstrapToken: fileToken, mfaKey: key1, mfaKeyId: "k1", mfaClock: () => clockMs });
  await new Promise((resolve, reject) => { fileApp.server.once("error", reject); fileApp.server.listen(0, "127.0.0.1", resolve); });
  cleanups.push(() => fileApp.close());
  const fileBase = `http://127.0.0.1:${fileApp.server.address().port}`;
  const boot = await fetch(`${fileBase}/api/auth/bootstrap`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: fileToken, email: "owner@example.test", password: "owner-test-passphrase-99" }),
  });
  const fileCookie = boot.headers.get("set-cookie").split(";")[0];

  const preflight = await fetch(`${fileBase}/api/system/preflight`, { headers: { cookie: fileCookie } }).then((r) => r.json());
  assert.equal(preflight.ready, true);
  assert.equal(preflight.liveConnections, 0);
  assert.equal(JSON.stringify(preflight).includes(key1), false);
  assert.equal(JSON.stringify(preflight).includes(fileToken), false);

  // Enroll MFA with k1
  const enroll = await fetch(`${fileBase}/api/auth/mfa/enroll`, {
    method: "POST", headers: { cookie: fileCookie, "content-type": "application/json" },
    body: JSON.stringify({ password: "owner-test-passphrase-99" }),
  }).then((r) => r.json());
  const code1 = totpAt(enroll.secret, Math.floor(clockMs / 30_000) * 30);
  const confirm = await fetch(`${fileBase}/api/auth/mfa/confirm`, {
    method: "POST", headers: { cookie: fileCookie, "content-type": "application/json" },
    body: JSON.stringify({ code: code1 }),
  });
  const mfaCookie = confirm.headers.get("set-cookie").split(";")[0];

  // Rotate to k2
  const rotate = await fetch(`${fileBase}/api/system/mfa/rotate-keys`, {
    method: "POST", headers: { cookie: mfaCookie, "content-type": "application/json" },
    body: JSON.stringify({ password: "owner-test-passphrase-99", newKey: key2, newKeyId: "k2" }),
  });
  assert.equal(rotate.status, 200);
  const rotatedBody = await rotate.json();
  assert.equal(rotatedBody.rotated, 1);
  assert.equal(rotatedBody.activeKeyId, "k2");

  // Verify TOTP login still works after rotation
  clockMs += 30_000;
  const loginRes = await fetch(`${fileBase}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@example.test", password: "owner-test-passphrase-99" }),
  });
  const { challenge } = await loginRes.json();
  const code2 = totpAt(enroll.secret, Math.floor(clockMs / 30_000) * 30);
  const verifiedLogin = await fetch(`${fileBase}/api/auth/mfa/challenge`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge, code: code2 }),
  });
  assert.equal(verifiedLogin.status, 200);

  // Backup and verify SQLite snapshot integrity
  const backupRes = await fetch(`${fileBase}/api/system/backup`, { method: "POST", headers: { cookie: mfaCookie } });
  assert.equal(backupRes.status, 201);
  const backupData = await backupRes.json();
  assert.equal(backupData.verified, true);
  const check = verifyBackupFile(join(workDir, "backups", backupData.fileName), backupData.sha256);
  assert.equal(check.valid, true);
  assert.equal(check.usersCount, 1);
  assert.equal(check.accountsCount, 3);

  // Avoid unused warning for initial memory app
  assert.ok(baseUrl && cookie);
});

test("ORB-013: verified recovery contact activates local simulated notification adapter with failure retry tracking", async () => {
  const key = randomBytes(32).toString("base64");
  let clockMs = 1_700_000_000_000;
  const { app, baseUrl, cookie } = await startBootstrappedApp({ mfaKey: key, mfaClock: () => clockMs });

  const contactRes = await fetch(`${baseUrl}/api/auth/recovery-contacts`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ address: "recovery-ops@example.org", password: "owner-test-passphrase-99" }),
  });
  assert.equal(contactRes.status, 201);
  const issued = await contactRes.json();
  assert.equal(issued.liveDelivery, false);

  const verifiedRes = await fetch(`${baseUrl}/api/auth/recovery-contacts/verify`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ token: issued.localVerificationToken }),
  });
  assert.equal(verifiedRes.status, 200);

  // Enable MFA and test recovery code dispatch via local adapter
  const enroll = await fetch(`${baseUrl}/api/auth/mfa/enroll`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ password: "owner-test-passphrase-99" }),
  }).then((r) => r.json());
  const confirm = await fetch(`${baseUrl}/api/auth/mfa/confirm`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ code: totpAt(enroll.secret, Math.floor(clockMs / 30_000) * 30) }),
  }).then((r) => r.json());

  const challenge1 = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@example.test", password: "owner-test-passphrase-99" }),
  }).then((r) => r.json());
  const rec1 = await fetch(`${baseUrl}/api/auth/mfa/challenge`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge: challenge1.challenge, code: confirm.recoveryCodes[0] }),
  }).then((r) => r.json());
  assert.equal(rec1.notification, "simulated_local_delivery");
  assert.equal(app.notificationAdapter.deliveries.length, 1);

  // Simulate transient transport failure -> retry_pending
  app.notificationAdapter.setFailNext(true);
  const challenge2 = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@example.test", password: "owner-test-passphrase-99" }),
  }).then((r) => r.json());
  const rec2 = await fetch(`${baseUrl}/api/auth/mfa/challenge`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge: challenge2.challenge, code: confirm.recoveryCodes[1] }),
  }).then((r) => r.json());
  assert.equal(rec2.notification, "retry_pending");
});

test("sandbox accounts, capability snapshots, migration state machine, and storage policies enforce safety gates", async () => {
  const { baseUrl, cookie } = await startBootstrappedApp();

  // Reject SSRF host on sandbox creation
  const badHost = await fetch(`${baseUrl}/api/accounts/sandbox`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ label: "Evil", host: "127.0.0.1", username: "eviluser", quotaGb: 50 }),
  });
  assert.equal(badHost.status, 400);

  // Create valid sandbox account
  const createdAcc = await fetch(`${baseUrl}/api/accounts/sandbox`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ label: "Sandbox WHM", host: "whm.example.org", username: "sandboxwhm", quotaGb: 200, capabilityProfile: "whm_reseller" }),
  });
  assert.equal(createdAcc.status, 201);
  const { account } = await createdAcc.json();

  const caps = await fetch(`${baseUrl}/api/accounts/${account.id}/capabilities`, { headers: { cookie } }).then((r) => r.json());
  assert.equal(caps.profileName, "whm_reseller");
  assert.equal(caps.live, false);

  const sitesRes = await fetch(`${baseUrl}/api/sites`, { headers: { cookie } }).then((r) => r.json());
  assert.equal(sitesRes.sites.length, 8);

  // Migration state machine & cutover authorization gate
  const sourceSite = sitesRes.sites.find((s) => s.accountId === "acct-northstar");
  const planRes = await fetch(`${baseUrl}/api/migrations`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ siteId: sourceSite.id, targetAccountId: account.id, strategy: "wordpress_optimized" }),
  });
  assert.equal(planRes.status, 201);
  const plan = await planRes.json();
  assert.equal(plan.state, "planned");

  for (const expected of ["preflight", "snapshot", "transfer", "restore", "verify", "ready_for_cutover"]) {
    const step = await fetch(`${baseUrl}/api/migrations/${plan.id}/advance`, {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}",
    }).then((r) => r.json());
    assert.equal(step.state, expected);
  }

  // Cutover requires explicit confirmCutover: true
  const blockedCutover = await fetch(`${baseUrl}/api/migrations/${plan.id}/advance`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}",
  });
  assert.equal(blockedCutover.status, 409);

  // Rollback works prior to completion
  const rolled = await fetch(`${baseUrl}/api/migrations/${plan.id}/rollback`, {
    method: "POST", headers: { cookie },
  }).then((r) => r.json());
  assert.equal(rolled.state, "rolled_back");

  // Storage policy rejects metadata IP and accepts HTTPS S3 endpoint
  const badStorage = await fetch(`${baseUrl}/api/storage/policies`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ accountId: "acct-northstar", mode: "backup_archival", targetEndpoint: "https://169.254.169.254", targetBucket: "valid-bucket", thresholdPercent: 80 }),
  });
  assert.equal(badStorage.status, 400);

  const okStorage = await fetch(`${baseUrl}/api/storage/policies`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ accountId: "acct-northstar", mode: "backup_archival", targetEndpoint: "https://s3.example.org", targetBucket: "orbicore-backups", thresholdPercent: 80 }),
  });
  assert.equal(okStorage.status, 201);
});

test("ORB-014 & ORB-015: restore drill verifies backup integrity and MFA decryptability while rejecting traversal; diagnostics stay redacted", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "orbicore-drill-"));
  cleanups.push(() => rmSync(workDir, { recursive: true, force: true }));
  const key1 = randomBytes(32).toString("base64");
  const key2 = randomBytes(32).toString("base64");
  let clockMs = 1_700_000_000_000;
  const token = "drill-bootstrap-token-32-chars-minimum";
  const app = createApp({ dbPath: join(workDir, "drill.sqlite"), startWorker: false, bootstrapToken: token, mfaKey: key1, mfaKeyId: "k1", mfaClock: () => clockMs });
  await new Promise((resolve, reject) => { app.server.once("error", reject); app.server.listen(0, "127.0.0.1", resolve); });
  cleanups.push(() => app.close());
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

  const boot = await fetch(`${baseUrl}/api/auth/bootstrap`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, email: "owner@example.test", password: "owner-test-passphrase-99" }),
  });
  assert.equal(boot.status, 201);
  const cookie = boot.headers.get("set-cookie").split(";")[0];

  const enroll = await fetch(`${baseUrl}/api/auth/mfa/enroll`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ password: "owner-test-passphrase-99" }),
  }).then((r) => r.json());
  const confirm = await fetch(`${baseUrl}/api/auth/mfa/confirm`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ code: totpAt(enroll.secret, Math.floor(clockMs / 30_000) * 30) }),
  });
  const mfaCookie = confirm.headers.get("set-cookie").split(";")[0];

  await fetch(`${baseUrl}/api/system/mfa/rotate-keys`, {
    method: "POST", headers: { cookie: mfaCookie, "content-type": "application/json" },
    body: JSON.stringify({ password: "owner-test-passphrase-99", newKey: key2, newKeyId: "k2" }),
  });

  const backup = await fetch(`${baseUrl}/api/system/backup`, { method: "POST", headers: { cookie: mfaCookie } }).then((r) => r.json());
  const list = await fetch(`${baseUrl}/api/system/backups`, { headers: { cookie: mfaCookie } }).then((r) => r.json());
  assert.equal(list.backups.length, 1);
  assert.equal(list.backups[0].fileName, backup.fileName);

  const drill = await fetch(`${baseUrl}/api/system/restore-drill`, {
    method: "POST", headers: { cookie: mfaCookie, "content-type": "application/json" },
    body: JSON.stringify({ fileName: backup.fileName }),
  }).then((r) => r.json());
  assert.equal(drill.passed, true);
  assert.equal(drill.mfaAuthenticatorsChecked, 1);
  assert.equal(drill.mfaSecretsVerified, 1);
  assert.equal(drill.mfaSecretsFailed, 0);

  const traversal = await fetch(`${baseUrl}/api/system/restore-drill`, {
    method: "POST", headers: { cookie: mfaCookie, "content-type": "application/json" },
    body: JSON.stringify({ fileName: "../../etc/passwd" }),
  });
  assert.equal(traversal.status, 400);

  const bundle = await fetch(`${baseUrl}/api/system/diagnostics/bundle`, { headers: { cookie: mfaCookie } }).then((r) => r.json());
  assert.equal(bundle.redactionApplied, true);
  assert.equal(bundle.secretsIncluded, false);
  assert.equal(bundle.adapterBoundary.liveConnections, 0);
  const rawBundle = JSON.stringify(bundle);
  assert.equal(rawBundle.includes(key1), false);
  assert.equal(rawBundle.includes(key2), false);
  assert.equal(rawBundle.includes(token), false);
});

test("Team RBAC management, capability-gated site snapshots, and outbox retry enforce policy boundaries", async () => {
  const { app, baseUrl, cookie } = await startBootstrappedApp();

  // Create operator & viewer team members
  const opRes = await fetch(`${baseUrl}/api/team/members`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ email: "op@example.test", password: "operator-passphrase-2026", role: "operator" }),
  });
  assert.equal(opRes.status, 201);
  const { member: operator } = await opRes.json();

  const viewRes = await fetch(`${baseUrl}/api/team/members`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ email: "viewer@example.test", password: "viewer-passphrase-2026", role: "viewer" }),
  });
  assert.equal(viewRes.status, 201);

  const viewerLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "viewer@example.test", password: "viewer-passphrase-2026" }),
  });
  const viewerCookie = viewerLogin.headers.get("set-cookie").split(";")[0];

  // Viewer can inspect site posture but cannot execute mutating actions or view team list
  const inspectRes = await fetch(`${baseUrl}/api/sites/site-northstar-main/inspection`, { headers: { cookie: viewerCookie } });
  assert.equal(inspectRes.status, 200);
  const inspection = await inspectRes.json();
  assert.equal(inspection.live, false);
  assert.equal(inspection.wordpress.adminCredentialAssumption, "never_inferred_from_cpanel");

  const viewerAction = await fetch(`${baseUrl}/api/sites/site-northstar-main/actions`, {
    method: "POST", headers: { cookie: viewerCookie, "content-type": "application/json" },
    body: JSON.stringify({ action: "backup_dry_run" }),
  });
  assert.equal(viewerAction.status, 403);

  const viewerTeam = await fetch(`${baseUrl}/api/team/members`, { headers: { cookie: viewerCookie } });
  assert.equal(viewerTeam.status, 403);

  // Operator login & capability-gated site actions
  const opLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "op@example.test", password: "operator-passphrase-2026" }),
  });
  const opCookie = opLogin.headers.get("set-cookie").split(";")[0];

  const okDryRun = await fetch(`${baseUrl}/api/sites/site-northstar-main/actions`, {
    method: "POST", headers: { cookie: opCookie, "content-type": "application/json" },
    body: JSON.stringify({ action: "backup_dry_run" }),
  });
  assert.equal(okDryRun.status, 201);

  // Restricted account acct-copperline blocks user archive dry-run with 403 capability_restricted
  const blockedDryRun = await fetch(`${baseUrl}/api/sites/site-copperline-main/actions`, {
    method: "POST", headers: { cookie: opCookie, "content-type": "application/json" },
    body: JSON.stringify({ action: "backup_dry_run" }),
  });
  assert.equal(blockedDryRun.status, 403);
  const blockedBody = await blockedDryRun.json();
  assert.equal(blockedBody.error, "capability_restricted");

  // Disabling operator immediately revokes active operator session
  const disableOp = await fetch(`${baseUrl}/api/team/members/${operator.id}`, {
    method: "PATCH", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ disabled: true }),
  });
  assert.equal(disableOp.status, 200);
  const opAfterDisable = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: opCookie } });
  assert.equal(opAfterDisable.status, 401);

  // Outbox retry route after verified contact + transient failure
  const issued = await fetch(`${baseUrl}/api/auth/recovery-contacts`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ address: "retry-test@example.org", password: "owner-test-passphrase-99" }),
  }).then((r) => r.json());
  await fetch(`${baseUrl}/api/auth/recovery-contacts/verify`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ token: issued.localVerificationToken }),
  });
  app.notificationAdapter.setFailNext(true);
  await app.notificationAdapter.send({ recipient: "retry-test@example.org", event: "test", body: "fail" }).catch(() => {});
  app.db.prepare(`INSERT INTO notification_outbox (id, user_id, event, recipient, status, attempts, last_error, created_at)
    SELECT 'outbox-retry-1', id, 'auth.mfa_recovery_code_used', 'retry-test@example.org', 'retry_pending', 1, 'transient_failure', datetime('now') FROM users WHERE email = 'owner@example.test'`).run();
  const retried = await fetch(`${baseUrl}/api/auth/recovery-contacts/outbox/retry`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ outboxId: "outbox-retry-1" }),
  }).then((r) => r.json());
  assert.equal(retried.status, "simulated_local_delivery");
});

test("Migration 30% partial-failure checkpoint & resume plus storage outage/rehydration drills enforce safety boundaries", async () => {
  const { baseUrl, cookie } = await startBootstrappedApp();
  const { account: targetAccount } = await fetch(`${baseUrl}/api/accounts/sandbox`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ label: "Target Node", host: "target.example.org", username: "targetnode", quotaGb: 200, capabilityProfile: "cpanel_uapi_standard" }),
  }).then((r) => r.json());
  const sitesRes = await fetch(`${baseUrl}/api/sites`, { headers: { cookie } }).then((r) => r.json());
  const sourceSite = sitesRes.sites.find((s) => s.accountId === "acct-northstar");

  const plan = await fetch(`${baseUrl}/api/migrations`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ siteId: sourceSite.id, targetAccountId: targetAccount.id, strategy: "wordpress_optimized" }),
  }).then((r) => r.json());

  for (const state of ["preflight", "snapshot", "transfer"]) {
    const res = await fetch(`${baseUrl}/api/migrations/${plan.id}/advance`, {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}",
    }).then((r) => r.json());
    assert.equal(res.state, state);
  }

  // Simulate partial failure at 30% transfer checkpoint
  const failed = await fetch(`${baseUrl}/api/migrations/${plan.id}/advance`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ simulatePartialFailure: true }),
  }).then((r) => r.json());
  assert.equal(failed.state, "failed");
  assert.equal(failed.checkpointPercent, 30);
  assert.equal(failed.failedAtStage, "transfer");

  // Idempotent checkpoint resume picks up at restore with 100% transfer checkpoint
  const resumed = await fetch(`${baseUrl}/api/migrations/${plan.id}/advance`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}",
  }).then((r) => r.json());
  assert.equal(resumed.state, "restore");
  assert.equal(resumed.checkpointPercent, 100);

  // Storage policy drills: outage fails closed (paused), rehydration verifies checksum
  const policy = await fetch(`${baseUrl}/api/storage/policies`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ accountId: "acct-northstar", mode: "media_offload", targetEndpoint: "https://s3.example.org", targetBucket: "orbicore-media", thresholdPercent: 80 }),
  }).then((r) => r.json());

  const outage = await fetch(`${baseUrl}/api/storage/policies/${policy.id}/drill`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ drillType: "simulate_outage" }),
  }).then((r) => r.json());
  assert.equal(outage.status, "paused");
  assert.equal(outage.lastDrillStatus, "remote_outage_fail_closed");
  assert.equal(outage.sourceFilesUntouched, true);

  const rehydrate = await fetch(`${baseUrl}/api/storage/policies/${policy.id}/drill`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ drillType: "rehydrate_verify" }),
  }).then((r) => r.json());
  assert.equal(rehydrate.status, "dry_run_only");
  assert.equal(rehydrate.lastDrillStatus, "rehydration_checksum_verified");
});

test("Deterministic telemetry advisor, policy-gated automation daily caps, and agency readiness report", async () => {
  const { baseUrl, cookie } = await startBootstrappedApp();

  // Create viewer user to verify RBAC enforcement on rule creation & runs
  await fetch(`${baseUrl}/api/team/members`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ email: "auditor@example.test", password: "auditor-passphrase-2026", role: "viewer" }),
  });
  const viewerLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "auditor@example.test", password: "auditor-passphrase-2026" }),
  });
  const viewerCookie = viewerLogin.headers.get("set-cookie").split(";")[0];

  const insights = await fetch(`${baseUrl}/api/automation/insights`, { headers: { cookie } }).then((r) => r.json());
  assert.equal(insights.readOnly, true);
  assert.equal(insights.liveProviderConnections, 0);
  assert.ok(insights.insights.length >= 1);

  const viewerCreate = await fetch(`${baseUrl}/api/automation/rules`, {
    method: "POST", headers: { cookie: viewerCookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Unauthorized rule", ruleType: "quota_threshold_alert", approvalMode: "manual_approval", dailyRunCap: 1 }),
  });
  assert.equal(viewerCreate.status, 403);

  const ruleRes = await fetch(`${baseUrl}/api/automation/rules`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Quota watch dry-run", ruleType: "quota_threshold_alert", approvalMode: "manual_approval", dailyRunCap: 1 }),
  });
  assert.equal(ruleRes.status, 201);
  const { rule } = await ruleRes.json();

  const run1 = await fetch(`${baseUrl}/api/automation/rules/${rule.id}/run`, {
    method: "POST", headers: { cookie },
  });
  assert.equal(run1.status, 201);
  const run1Body = await run1.json();
  assert.equal(run1Body.executed, true);
  assert.equal(run1Body.summary.dryRun, true);

  // Second run same day hits dailyRunCap: 1 and returns 429 budget_capped
  const run2 = await fetch(`${baseUrl}/api/automation/rules/${rule.id}/run`, {
    method: "POST", headers: { cookie },
  });
  assert.equal(run2.status, 429);
  const run2Body = await run2.json();
  assert.equal(run2Body.status, "budget_capped");

  const report = await fetch(`${baseUrl}/api/agency/report`, { headers: { cookie } }).then((r) => r.json());
  assert.equal(report.reportVersion, 1);
  assert.equal(report.measurementBoundary.liveProviderConnections, 0);
  assert.equal(report.portfolio.accountsCount, 3);
  assert.equal(report.portfolio.sitesTotal, 7);
});

test("Phase 6 WordPress lifecycle: staging clone, restore-point update, and rollback enforce workload & RBAC boundaries", async () => {
  const { baseUrl, cookie } = await startBootstrappedApp();

  // Static site rejects WordPress staging mutation
  const staticRes = await fetch(`${baseUrl}/api/sites/site-fieldwork-labs/wordpress/staging`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ action: "create" }),
  });
  assert.equal(staticRes.status, 400);

  // Provision dry-run staging clone for attention WordPress site
  const staging = await fetch(`${baseUrl}/api/sites/site-northstar-preview/wordpress/staging`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ action: "create" }),
  }).then((r) => r.json());
  assert.equal(staging.stagingUrl, "https://staging.preview.northstar-studio.example");
  assert.equal(staging.dryRun, true);

  // Apply dry-run update (saves pre-update version 6.7.2 & pending 3)
  const updated = await fetch(`${baseUrl}/api/sites/site-northstar-preview/wordpress/update`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ action: "apply_updates" }),
  }).then((r) => r.json());
  assert.equal(updated.coreVersion, "6.8.1");
  assert.equal(updated.pendingUpdates, 0);
  assert.equal(updated.canRollback, true);
  assert.ok(updated.restorePointSha256);

  // Roll back to pre-update restore point
  const rolledBack = await fetch(`${baseUrl}/api/sites/site-northstar-preview/wordpress/update`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ action: "rollback" }),
  }).then((r) => r.json());
  assert.equal(rolledBack.coreVersion, "6.7.2");
  assert.equal(rolledBack.pendingUpdates, 3);
  assert.equal(rolledBack.canRollback, false);

  // Inspection reflects persisted rollback state and active staging clone
  const inspected = await fetch(`${baseUrl}/api/sites/site-northstar-preview/inspection`, { headers: { cookie } }).then((r) => r.json());
  assert.equal(inspected.wordpress.simulatedCoreVersion, "6.7.2");
  assert.equal(inspected.wordpress.pendingUpdates, 3);
  assert.equal(inspected.wordpress.stagingUrl, "https://staging.preview.northstar-studio.example");
});

test("ORB-006 / ORB-019 boundary: LiveCpanelAdapterBoundary enforces authorization, SSRF guard, revoked tokens, and UAPI parsing without token leaks", async () => {
  const secretToken = "super-secret-cpanel-uapi-token-999";
  const boundary = new LiveCpanelAdapterBoundary({
    fetchImpl: async (url) => {
      if (String(url).includes("revoked.example.org")) {
        return new Response(JSON.stringify({ status: 0, errors: ["Access denied"] }), { status: 401 });
      }
      return new Response(JSON.stringify({
        status: 1,
        data: {
          main_domain: { domain: "agency.example.org", documentroot: "/home/agency/public_html", phpversion: "8.3", type: "main_domain" },
          addon_domains: [{ domain: "shop.agency.example.org", documentroot: "/home/agency/shop", phpversion: "8.2", type: "addon_domain" }],
          sub_domains: [],
        },
      }), { status: 200 });
    },
  });

  // Un-authorized call refuses cleanly
  const unauth = await boundary.discoverCapabilities({ host: "cp.example.org" });
  assert.equal(unauth.ok, false);
  assert.equal(unauth.error, "live_credentials_not_authorized");

  // Private/metadata host blocked even if authorized flag is passed
  const ssrf = await boundary.fetchInventory({ host: "169.254.169.254", username: "u", apiToken: secretToken, authorized: true });
  assert.equal(ssrf.ok, false);
  assert.equal(ssrf.error, "blocked_private_or_loopback_host");

  // Revoked token 401 returns redacted error without token leak
  const revoked = await boundary.fetchInventory({ host: "revoked.example.org", username: "u", apiToken: secretToken, authorized: true });
  assert.equal(revoked.ok, false);
  assert.equal(revoked.error, "revoked_or_denied_token");
  assert.equal(JSON.stringify(revoked).includes(secretToken), false);

  // Authorized read-only UAPI normalization succeeds without returning secretToken
  const inv = await boundary.fetchInventory({ host: "cp.example.org", username: "agency", apiToken: secretToken, authorized: true });
  assert.equal(inv.ok, true);
  assert.equal(inv.sites.length, 2);
  assert.equal(inv.sites[0].domain, "agency.example.org");
  assert.equal(JSON.stringify(inv).includes(secretToken), false);

  // HTTP API probe rejects SSRF hosts and returns fail-closed status for valid hosts
  const { baseUrl, cookie } = await startBootstrappedApp();
  const badProbe = await fetch(`${baseUrl}/api/accounts/cpanel/probe`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ host: "127.0.0.1" }),
  });
  assert.equal(badProbe.status, 400);

  const validProbe = await fetch(`${baseUrl}/api/accounts/cpanel/probe`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ host: "cpanel.example.org" }),
  }).then((r) => r.json());
  assert.equal(validProbe.ssrfPolicyPassed, true);
  assert.equal(validProbe.liveConnections, 0);
  assert.equal(validProbe.probe.error, "live_credentials_not_authorized");
});

test("SQLite schema migrations v1-v7 apply idempotently across restarts without duplicating rows", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "orbicore-mig-"));
  cleanups.push(() => rmSync(workDir, { recursive: true, force: true }));
  const dbPath = join(workDir, "persist.sqlite");
  const token = "migration-idempotency-bootstrap-token";

  const first = createApp({ dbPath, startWorker: false, bootstrapToken: token });
  const vFirst = first.db.prepare("SELECT MAX(version) AS v, COUNT(*) AS cnt FROM schema_migrations").get();
  assert.equal(vFirst.v, 7);
  assert.equal(vFirst.cnt, 7);
  first.close();

  const second = createApp({ dbPath, startWorker: false, bootstrapToken: token });
  cleanups.push(() => second.close());
  const vSecond = second.db.prepare("SELECT MAX(version) AS v, COUNT(*) AS cnt FROM schema_migrations").get();
  const accCount = second.db.prepare("SELECT COUNT(*) AS cnt FROM accounts").get().cnt;
  assert.equal(vSecond.v, 7);
  assert.equal(vSecond.cnt, 7);
  assert.equal(accCount, 3);
});

test("INSTALL-UPGRADE-001: legacy DB schema upgrades safely to v6 while corrupted backups fail closed during restore drills", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "orbicore-upgrade-"));
  cleanups.push(() => rmSync(workDir, { recursive: true, force: true }));
  const dbPath = join(workDir, "upgrade.sqlite");
  const token = "upgrade-recovery-bootstrap-token-32";

  const first = createApp({ dbPath, startWorker: false, bootstrapToken: token });
  await new Promise((resolveListen, reject) => { first.server.once("error", reject); first.server.listen(0, "127.0.0.1", resolveListen); });
  const base1 = `http://127.0.0.1:${first.server.address().port}`;
  const boot = await fetch(`${base1}/api/auth/bootstrap`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, email: "owner@example.test", password: "owner-upgrade-pass-99" }),
  });
  assert.equal(boot.status, 201);
  first.close();

  // Simulate older database state prior to v5 by removing wp_site_state and schema_migrations entry >= 5
  const rawDb = new DatabaseSync(dbPath);
  rawDb.exec("DROP TABLE IF EXISTS wp_site_state; DELETE FROM schema_migrations WHERE version >= 5;");
  rawDb.close();

  // Re-opening upgrades cleanly to v7 and preserves bootstrap owner account
  const upgraded = createApp({ dbPath, startWorker: false, bootstrapToken: token });
  await new Promise((resolveListen, reject) => { upgraded.server.once("error", reject); upgraded.server.listen(0, "127.0.0.1", resolveListen); });
  cleanups.push(() => upgraded.close());
  assert.equal(upgraded.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v, 7);
  assert.equal(upgraded.db.prepare("SELECT email FROM users").get().email, "owner@example.test");

  const base2 = `http://127.0.0.1:${upgraded.server.address().port}`;
  const login = await fetch(`${base2}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@example.test", password: "owner-upgrade-pass-99" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];

  // Create valid backup then write a corrupted backup file; restore drill must fail closed
  await fetch(`${base2}/api/system/backup`, { method: "POST", headers: { cookie } });
  writeFileSync(join(workDir, "backups", "corrupted.sqlite"), "not-a-valid-sqlite-database");
  const badDrill = await fetch(`${base2}/api/system/restore-drill`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ fileName: "corrupted.sqlite" }),
  });
  const badBody = await badDrill.json();
  assert.equal(badDrill.status, 200);
  assert.equal(badBody.passed, false);
  assert.equal(badBody.reason, "corrupt_sqlite_database");
});

test("Pre-seeded demo workflows, idempotent extended demo dataset, and interrupted job crash recovery", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "orbicore-demo-"));
  cleanups.push(() => rmSync(workDir, { recursive: true, force: true }));
  const dbPath = join(workDir, "demo.sqlite");
  const token = "demo-recovery-bootstrap-token-32";

  const first = createApp({ dbPath, startWorker: false, bootstrapToken: token });
  cleanups.push(() => { try { first.close(); } catch { /* already closed */ } });
  await new Promise((resolveListen, reject) => { first.server.once("error", reject); first.server.listen(0, "127.0.0.1", resolveListen); });
  const base1 = `http://127.0.0.1:${first.server.address().port}`;
  const boot = await fetch(`${base1}/api/auth/bootstrap`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, email: "owner@example.test", password: "owner-demo-passphrase-99" }),
  });
  const cookie = boot.headers.get("set-cookie").split(";")[0];
  const ownerId = first.db.prepare("SELECT id FROM users").get().id;

  // Pre-seeded realistic workflows are populated out-of-the-box
  const migrations = await fetch(`${base1}/api/migrations`, { headers: { cookie } }).then((r) => r.json());
  const storage = await fetch(`${base1}/api/storage/summary`, { headers: { cookie } }).then((r) => r.json());
  const rules = await fetch(`${base1}/api/automation/rules`, { headers: { cookie } }).then((r) => r.json());
  assert.ok(migrations.migrations.length >= 2);
  assert.ok(storage.policies.length >= 2);
  assert.ok(rules.rules.length >= 2);

  // Extended demo-seed adds dummy accounts/sites/team members idempotently
  const seed1 = await fetch(`${base1}/api/system/demo-seed`, { method: "POST", headers: { cookie } }).then((r) => r.json());
  assert.equal(seed1.seeded, true);
  assert.equal(seed1.accountsAdded, 2);
  assert.equal(seed1.sitesAdded, 3);
  assert.equal(seed1.teamAdded, 2);
  const seed2 = await fetch(`${base1}/api/system/demo-seed`, { method: "POST", headers: { cookie } }).then((r) => r.json());
  assert.equal(seed2.accountsAdded, 0);

  // Simulate an orphaned job interrupted mid-run before restart
  first.db.prepare(`INSERT INTO jobs (id, type, organization_id, account_id, requested_by, status, created_at, started_at)
    VALUES ('orphaned-job-1', 'inventory_refresh', 'org-demo', 'acct-northstar', ?, 'running', ?, ?)`)
    .run(ownerId, new Date().toISOString(), new Date().toISOString());
  first.close();

  const recovered = createApp({ dbPath, startWorker: false, bootstrapToken: token });
  cleanups.push(() => recovered.close());
  const requeued = recovered.db.prepare("SELECT status, error FROM jobs WHERE id = 'orphaned-job-1'").get();
  assert.equal(requeued.status, "queued");
  assert.equal(requeued.error, "recovered_after_restart");

  const processed = await recovered.processNextJob();
  assert.equal(processed.status, "completed");
});

test("ORB-017: GET /api/system/deployment-readiness truthfully distinguishes local SQLite prototype from production readiness", async () => {
  const token = "readiness-bootstrap-token-32bytes";
  const app = createApp({ dbPath: ":memory:", startWorker: false, bootstrapToken: token });
  cleanups.push(() => app.close());
  await new Promise((resolveListen, reject) => { app.server.once("error", reject); app.server.listen(0, "127.0.0.1", resolveListen); });
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const boot = await fetch(`${baseUrl}/api/auth/bootstrap`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, email: "owner@example.test", password: "owner-readiness-pass-99" }),
  });
  const cookie = boot.headers.get("set-cookie").split(";")[0];

  const report = await fetch(`${baseUrl}/api/system/deployment-readiness`, { headers: { cookie } }).then((r) => r.json());
  assert.equal(report.profile, "local_sqlite_prototype");
  assert.equal(report.productionReady, false);
  assert.ok(report.missingRequiredServices.some((s) => s.includes("PostgreSQL")));
  assert.ok(report.gates.some((g) => g.id === "queue.redis" && g.status === "missing"));
});



