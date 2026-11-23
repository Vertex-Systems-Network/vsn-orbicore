import assert from "node:assert/strict";
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createApp } from "../apps/api/server.mjs";
import { totpAt } from "../apps/api/mfa.mjs";

const { chromium } = await import("playwright");

const bootstrapToken = process.env.ORBICORE_BOOTSTRAP_TOKEN || "browser-verify-bootstrap-token-32b";
const mfaKey = process.env.ORBICORE_MFA_ENCRYPTION_KEY || "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
// A stable localhost origin is required: WebAuthn RP ID and expected origin must match the browser URL.
const port = Number(process.env.ORBICORE_BROWSER_PORT ?? 41753);
const baseUrl = "http://localhost:" + port;
// Deterministic fixture-only clock for TOTP confirmation near real-time window boundaries.
const mfaTestClockMs = 1_700_000_000_000;
const app = createApp({ dbPath: ":memory:", startWorker: true, bootstrapToken, mfaKey, mfaClock: () => mfaTestClockMs, webauthnRPID: "localhost", webauthnOrigin: baseUrl });

await new Promise((resolveListen, reject) => {
  app.server.once("error", reject);
  app.server.listen(port, resolveListen);
});

const browser = await chromium.launch();

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

  // Accessibility check on AuthGate landmark & labeled controls (ORB-018)
  const mainCount = await page.locator("main").count();
  assert.equal(mainCount, 1);

  const inputs = page.locator("form.auth-card input");
  await inputs.nth(0).fill("wrong-bootstrap-token-trigger-error");
  await inputs.nth(1).fill("owner@example.test");
  await inputs.nth(2).fill("owner-browser-passphrase-99");
  await page.getByRole("button", { name: /create workspace|sign in|complete/i }).click();
  await page.locator("[role='alert'], .error-banner").first().waitFor({ timeout: 5_000 });
  assert.equal(await inputs.nth(0).getAttribute("aria-invalid"), "true",
    "incorrect bootstrap token must mark the specifically invalid input");
  assert.equal(await inputs.nth(0).getAttribute("aria-describedby"), "auth-error",
    "incorrect bootstrap token must be programmatically linked to its error");
  assert.match(await page.locator("#auth-error").textContent(), /setup token is incorrect/i);
  assert.equal(await inputs.nth(1).getAttribute("aria-invalid"), "false",
    "unrelated email must not be marked invalid for a bootstrap-token failure");

  await inputs.nth(0).fill(bootstrapToken);
  await page.getByRole("button", { name: /create workspace|sign in|complete/i }).click();
  await page.getByRole("button", { name: "Overview", exact: true }).waitFor({ timeout: 10_000 });

  // Verify accessible landmarks, zero duplicate DOM IDs, and primary keyboard/button navigation
  const domAudit = await page.evaluate(() => {
    const ids = Array.from(document.querySelectorAll("[id]")).map((el) => el.id);
    const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
    const unnamedButtons = Array.from(document.querySelectorAll("button")).filter(
      (btn) => !btn.textContent?.trim() && !btn.getAttribute("aria-label"),
    ).length;
    return {
      navCount: document.querySelectorAll("nav").length,
      mainCount: document.querySelectorAll("main").length,
      duplicateIds,
      unnamedButtons,
    };
  });
  assert.ok(domAudit.navCount >= 1);
  assert.ok(domAudit.mainCount >= 1);
  assert.deepEqual(domAudit.duplicateIds, []);
  assert.equal(domAudit.unnamedButtons, 0);

  // A filtered-empty inventory must be visibly different from an API failure.
  const globalSearch = page.locator(".global-search input");
  await globalSearch.fill("nonexistent-inventory-account-20261123");
  await page.getByText("No matching accounts", { exact: true }).waitFor();
  await globalSearch.fill("");

  // ORB-009/018: skip-link is keyboard-visible and targets the one main.
  await page.locator(".skip-link").focus();
  // Use actual keyboard navigation to enter the :focus-visible modality.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.locator(".skip-link").evaluate((el) =>
    getComputedStyle(el).position), "fixed");
  await page.keyboard.press("Enter");
  assert.equal(new URL(page.url()).hash, "#main-content");
  assert.equal(await page.locator("#main-content").count(), 1);

  // All sections expose their active state, including when nav text is
  // visually hidden by the narrow sidebar.
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Overview", exact: true })
    .getAttribute("aria-current"), "page");
  for (const size of [
    { width: 320, height: 568 }, { width: 390, height: 844 },
    { width: 640, height: 800 }, { width: 768, height: 1024 },
  ]) {
    await page.setViewportSize(size);
    const counts = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
      unnamed: [...document.querySelectorAll(".primary-nav button")].filter(
        (button) => !button.getAttribute("aria-label")
      ).length,
    }));
    assert.equal(counts.unnamed, 0, "collapsed navigation requires accessible names");
    assert.ok(counts.content <= counts.viewport + 2,
      "dashboard must not create page-wide horizontal overflow at " + size.width);
    await page.getByRole("button", { name: "Websites", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Websites", exact: true })
      .getAttribute("aria-current"), "page");
    // Only synthetic fixture inventory and no secret-bearing security dialog.
    mkdirSync(".data/browser-evidence", { recursive: true });
    await page.screenshot({
      path: `.data/browser-evidence/orb-018-responsive-${size.width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1280, height: 800 });

  // A failed POST must not be treated as a successful refresh, and a failed
  // secondary GET must not silently replace last-known-good snapshot data.
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  const beforeFailure = await page.locator(".metric-card .metric-value").first().textContent();
  await page.route("**/api/jobs/refresh", (route) => route.fulfill({
    status: 503, contentType: "application/json", body: '{"error":"fixture_service_unavailable"}',
  }));
  await page.getByRole("button", { name: "Refresh inventory" }).click();
  await page.getByRole("alert").getByText(/one or more refresh requests were rejected/i).waitFor();
  await page.unroute("**/api/jobs/refresh");
  await page.route("**/api/sites", (route) => route.fulfill({
    status: 503, contentType: "application/json", body: '{"error":"fixture_service_unavailable"}',
  }));
  await page.getByRole("button", { name: "Retry loading workspace" }).click();
  await page.getByRole("alert").getByText(/complete workspace snapshot/i).waitFor();
  assert.equal(await page.locator(".metric-card .metric-value").first().textContent(), beforeFailure,
    "a partial failed workspace reload must preserve the last successful snapshot");
  await page.unroute("**/api/sites");
  await page.getByRole("button", { name: "Retry loading workspace" }).click();
  await page.locator(".page-container > .error-banner").waitFor({ state: "hidden" });

  // Verify that reduced-motion preference disables the dashboard spinner.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedAnimationSeconds = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.className = "spinning";
    document.body.append(probe);
    const duration = getComputedStyle(probe).animationDuration;
    probe.remove();
    return Number.parseFloat(duration);
  });
  assert.ok(reducedAnimationSeconds < 0.001, "reduced motion must suppress spinning animations");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  for (const label of ["Hosting accounts", "Websites", "Migrations", "Storage", "Jobs & activity", "Automation & reports", "System & security"]) {
    await page.getByRole("button", { name: label }).click();
  }

  // Verify audit hash chain UI indicator
  await page.getByRole("button", { name: "Jobs & activity" }).click();
  await page.getByRole("button", { name: "Verify audit chain" }).click();
  await page.getByText(/SHA-256 audit chain verified/i).waitFor({ timeout: 5_000 });

  // Enroll passkey via virtual authenticator & verify Escape dismissal
  await page.locator(".sidebar-bottom .settings-item").click();
  assert.equal(await page.locator(".mfa-close").evaluate((el) =>
    document.activeElement === el), true, "modal must move focus inside");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.locator(".mfa-panel").evaluate((el) =>
    el.contains(document.activeElement)), true, "reverse Tab must stay inside dialog");
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(".mfa-panel").evaluate((el) =>
    el.contains(document.activeElement)), true, "Tab must remain trapped inside dialog");
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await page.locator(".passkey-setup input[type='password']").fill("owner-browser-passphrase-99");
  await page.getByRole("button", { name: "Register passkey" }).click();
  await page.getByText(/Passkey enrolled on this device/i).waitFor({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".sidebar-bottom .settings-item").evaluate(
    (el) => document.activeElement === el), true, "Escape restores dialog opener focus");

  // ORB-012: use the actual browser virtual authenticator for a passwordless assertion.
  const registered = app.db.prepare("SELECT credential_id, counter FROM passkeys").get();
  assert.ok(registered?.credential_id, "browser enrollment must persist a passkey");
  const initialCounter = registered.counter;
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await page.locator("#auth-error").getByText(/enter your email first/i).waitFor();
  assert.equal(await page.locator("form.auth-card input[type='email']").getAttribute("aria-invalid"), "true",
    "passkey sign-in without email must mark the email input");
  assert.equal(await page.locator("form.auth-card input[type='email']").getAttribute("aria-describedby"), "auth-error",
    "passkey missing-email error must be associated with the email input");
  await page.locator("form.auth-card input[type='email']").fill("owner@example.test");
  const assertionRequestPromise = page.waitForRequest((request) =>
    request.method() === "POST" && request.url().endsWith("/api/auth/passkeys/login/verify"));
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  const assertionRequest = await assertionRequestPromise;
  const assertionPayload = assertionRequest.postDataJSON();
  await page.getByRole("button", { name: "Overview", exact: true }).waitFor({ timeout: 10_000 });
  const updated = app.db.prepare("SELECT counter, last_used_at FROM passkeys WHERE credential_id = ?").get(registered.credential_id);
  assert.ok(updated.counter > initialCounter, "virtual authenticator sign counter must advance on successful assertion");
  assert.ok(updated.last_used_at, "successful assertion must persist last-used timestamp");

  // Browser-driven challenge creation and real cryptographically signed assertion.
  // Return serialized test data only to the Node harness; never log credential signatures or session cookies.
  async function newSignedAssertion() {
    return page.evaluate(async () => {
      const optionsRes = await fetch("/api/auth/passkeys/login/options", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "owner@example.test" }),
      });
      if (!optionsRes.ok) throw new Error("Could not request passkey challenge: " + optionsRes.status);
      const { challengeHandle, options } = await optionsRes.json();
      const decode = (value) => Uint8Array.from(
        atob(value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=")),
        (character) => character.charCodeAt(0));
      const encode = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer)))
        .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
      const credential = await navigator.credentials.get({
        publicKey: {
          ...options, challenge: decode(options.challenge),
          allowCredentials: options.allowCredentials.map((item) => ({ ...item, id: decode(item.id) })),
        },
      });
      if (!credential) throw new Error("Virtual authenticator did not return an assertion");
      return {
        challengeHandle,
        response: {
          id: credential.id,
          rawId: encode(credential.rawId),
          type: credential.type,
          authenticatorAttachment: credential.authenticatorAttachment,
          clientExtensionResults: credential.getClientExtensionResults(),
          response: {
            clientDataJSON: encode(credential.response.clientDataJSON),
            authenticatorData: encode(credential.response.authenticatorData),
            signature: encode(credential.response.signature),
            userHandle: credential.response.userHandle ? encode(credential.response.userHandle) : null,
          },
        },
      };
    });
  }

  async function verifySigned(payload) {
    return page.evaluate(async (body) => {
      const result = await fetch("/api/auth/passkeys/login/verify", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      return { status: result.status, body: await result.json() };
    }, payload);
  }

  // A consumed challenge may not be replayed, even with a previously valid assertion.
  const replay = await verifySigned(assertionPayload);
  assert.equal(replay.status, 401, "consumed login challenge must reject replay");
  assert.equal(replay.body.error, "invalid_passkey_challenge");

  // Wrong origin: mutate signed clientDataJSON to an attacker origin. It must not create a session.
  const wrongOrigin = await newSignedAssertion();
  const data = JSON.parse(Buffer.from(wrongOrigin.response.response.clientDataJSON, "base64url").toString("utf8"));
  data.origin = "https://not-orbicore.example";
  wrongOrigin.response.response.clientDataJSON = Buffer.from(JSON.stringify(data)).toString("base64url");
  assert.equal((await verifySigned(wrongOrigin)).status, 401, "wrong WebAuthn origin must be rejected");

  // Wrong RP: tamper RP ID hash in authenticatorData; server must reject the signed assertion.
  // This also invalidates the signature, so it proves rejection, not the precise failure stage.
  const wrongRp = await newSignedAssertion();
  const authData = Buffer.from(wrongRp.response.response.authenticatorData, "base64url");
  authData[0] ^= 0xff;
  wrongRp.response.response.authenticatorData = authData.toString("base64url");
  assert.equal((await verifySigned(wrongRp)).status, 401, "wrong RP ID hash must be rejected");

  // Expired signed challenge: force the stored challenge past expiry before verifying.
  const expired = await newSignedAssertion();
  const handleHash = createHash("sha256").update(expired.challengeHandle).digest("hex");
  app.db.prepare("UPDATE webauthn_challenges SET expires_at = ? WHERE handle_hash = ?")
    .run("2000-01-01T00:00:00.000Z", handleHash);
  assert.equal((await verifySigned(expired)).status, 401, "expired challenge must be rejected");
  assert.equal((await verifySigned(expired)).status, 401, "expired challenge must also be one-time");

  // Signed response with a reused/stale monotonic counter is rejected even with a fresh challenge.
  const staleCounter = await newSignedAssertion();
  const signedCounter = Buffer.from(staleCounter.response.response.authenticatorData, "base64url").readUInt32BE(33);
  assert.ok(signedCounter > 0, "monotonic-counter replay cannot be proven with a zero-counter authenticator");
  app.db.prepare("UPDATE passkeys SET counter = ? WHERE credential_id = ?")
    .run(signedCounter, registered.credential_id);
  const counterReplay = await verifySigned(staleCounter);
  assert.equal(counterReplay.status, 401, "reused sign count must fail");
  assert.ok(["webauthn_counter_replay", "webauthn_verification_failed"].includes(counterReplay.body.error), "assertion with a stale counter must fail closed");

  const finalCounter = app.db.prepare("SELECT counter FROM passkeys WHERE credential_id = ?").get(registered.credential_id).counter;
  assert.equal(finalCounter, signedCounter, "rejected assertion must not advance stored counter");
  const health = await fetch(baseUrl + "/api/health").then((res) => res.json());
  assert.equal(health.status, "ok");

  // Synthetic-only UI capture; never include credentials, recovery codes, or browser storage in artifacts.
  const evidenceDir = ".data/browser-evidence";
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: evidenceDir + "/orb-012-dashboard.png", fullPage: true });

  // The session resolves roles from the database on every request. Exercise a
  // role downgrade using the same authenticated browser, then restore it.
  // No provider request or cross-tenant data is involved.
  const roleBefore = app.db.prepare("SELECT role FROM users WHERE email = ?")
    .get("owner@example.test")?.role;
  assert.equal(roleBefore, "owner", "browser fixture must start with its owner");
  try {
    app.db.prepare("UPDATE users SET role = 'viewer' WHERE email = ?")
      .run("owner@example.test");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Overview", exact: true }).waitFor();
    await page.locator(".user-profile small").getByText(/viewer/).waitFor();
    assert.equal(await page.getByRole("button", { name: "Refresh inventory" }).isDisabled(),
      true, "a viewer must not be offered a working refresh enqueue control");
    await page.locator(".primary-nav").getByRole("button", { name: "Hosting accounts", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Add sandbox account" }).count(), 0,
      "a viewer must not see sandbox account creation controls");
  } finally {
    app.db.prepare("UPDATE users SET role = ? WHERE email = ?")
      .run(roleBefore, "owner@example.test");
    await page.reload({ waitUntil: "domcontentloaded" });
  }
  await page.getByRole("button", { name: "Overview", exact: true }).waitFor();

  // ORB-018: account-bound rows/errors and a clean signed-in session reset.
  // Add only deterministic synthetic fixture data, not hosting provider access.
  await page.getByRole("button", { name: "Load extended demo data" }).click();
  await page.locator(".environment-banner").getByText(/loaded|already loaded/i).waitFor();
  const accountSnapshot = await page.evaluate(async () => {
    const response = await fetch("/api/overview");
    if (!response.ok) throw new Error("Synthetic overview unavailable");
    return response.json();
  });
  assert.ok(accountSnapshot.accounts.length >= 2,
    "account-scoped browser proof requires at least two synthetic accounts");
  const firstAccount = accountSnapshot.accounts[0];
  const secondAccount = accountSnapshot.accounts[1];
  const firstRow = page.locator(".account-rows .account-row").first();
  const secondRow = page.locator(".account-rows .account-row").nth(1);
  await firstRow.click();
  await page.locator(".site-panel").getByText(firstAccount.label).waitFor();

  // Simulate one account's site endpoint failing while another account's data
  // had already been displayed. No old rows may appear under the new account.
  const failingSitePath = "**/api/accounts/" + encodeURIComponent(secondAccount.id) + "/sites";
  await page.route(failingSitePath, (route) => route.fulfill({
    status: 503, contentType: "application/json", body: '{"error":"synthetic_unavailable"}',
  }));
  await secondRow.click();
  const sitePanel = page.locator(".site-panel");
  await sitePanel.getByRole("alert").getByText(/websites could not be loaded/i).waitFor();
  assert.equal(await sitePanel.locator(".site-row").count(), 0,
    "an unavailable account cannot inherit previously displayed website rows");
  assert.equal(await sitePanel.locator(".count-chip").textContent(), "0",
    "a failed account site request cannot display the prior account's count");
  await page.unroute(failingSitePath);
  await sitePanel.getByRole("button", { name: "Retry websites" }).click();
  await sitePanel.locator(".error-banner").waitFor({ state: "hidden" });
  await sitePanel.getByText(secondAccount.label).waitFor();

  // The selection is reset when signing out; reauthentication must select the
  // current tenant's first account, not re-use a stale account from prior UI.
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.locator("form.auth-card input[type='email']").fill("owner@example.test");
  await page.locator("form.auth-card input[type='password']").fill("owner-browser-passphrase-99");
  await page.locator("form.auth-card").getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".primary-nav").getByRole("button", { name: "Overview", exact: true }).waitFor();
  await page.locator(".account-row.selected").getByText(firstAccount.label, { exact: true }).waitFor();

  // ORB-018: account deletion/removal reconciliation is tested as a mocked
  // changed overview; no irreversible fixture deletion or live provider call.
  await page.locator(".account-rows .account-row").nth(1).click();
  await page.locator(".account-row.selected").getByText(secondAccount.label, { exact: true }).waitFor();
  await page.route("**/api/overview", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    await route.fulfill({
      response,
      json: {
        ...snapshot,
        accounts: snapshot.accounts.filter((account) => account.id !== secondAccount.id),
        counts: { ...snapshot.counts, accounts: snapshot.counts.accounts - 1 },
      },
    });
  });
  await page.getByRole("button", { name: "Load extended demo data" }).click();
  await page.locator(".account-row.selected").getByText(firstAccount.label, { exact: true }).waitFor();
  await page.unroute("**/api/overview");

  // Set up a second independently authenticated synthetic tenant and keep a
  // verified snapshot from the first tenant's cookie deliberately delayed.
  // This tests that a late response from the signed-out tenant cannot replace
  // the second tenant's inventory, even though the promise was in flight.
  const foreignOrganization = "org-browser-other";
  const foreignAccountId = "acct-browser-other-only";
  const foreignLabel = "Independent Tenant Sandbox";
  const foreignEmail = "other-browser@example.test";
  const foreignPassword = "another-browser-local-passphrase-77";
  const foreignSalt = randomBytes(16).toString("hex");
  const now = new Date().toISOString();
  app.db.prepare("INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)")
    .run(foreignOrganization, "Independent Browser Tenant", now);
  app.db.prepare(`INSERT INTO accounts (id, organization_id, label, provider, host, username, health, used_bytes, quota_bytes, last_synced_at, source)
    VALUES (?, ?, ?, 'cPanel', 'tenant-isolated.test', 'otherbrowser', 'healthy', 10, 100, ?, 'mock_fixture')`)
    .run(foreignAccountId, foreignOrganization, foreignLabel, now);
  app.db.prepare(`INSERT INTO sites (id, account_id, domain, kind, document_root, php_version, status)
    VALUES ('site-browser-other-only', ?, 'isolated.tenant.test', 'wordpress', '/home/otherbrowser/public_html', '8.3', 'active')`)
    .run(foreignAccountId);
  app.db.prepare(`INSERT INTO users (id, organization_id, email, password_salt, password_hash, role, created_at)
    VALUES ('user-browser-other', ?, ?, ?, ?, 'owner', ?)`)
    .run(foreignOrganization, foreignEmail, foreignSalt, scryptSync(foreignPassword, foreignSalt, 64).toString("hex"), now);

  let allowLateOverview;
  const delayed = new Promise((resolve) => { allowLateOverview = resolve; });
  let markIntercepted;
  const intercepted = new Promise((resolve) => { markIntercepted = resolve; });
  let heldFirstOverview = false;
  await page.route("**/api/overview", async (route) => {
    if (heldFirstOverview) return route.continue();
    heldFirstOverview = true;
    const response = await route.fetch();
    const priorSessionSnapshot = await response.json();
    markIntercepted();
    await delayed;
    await route.fulfill({ response, json: priorSessionSnapshot });
  });
  await page.getByRole("button", { name: "Refresh inventory" }).click();
  await intercepted;
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.locator("form.auth-card input[type='email']").fill(foreignEmail);
  await page.locator("form.auth-card input[type='password']").fill(foreignPassword);
  await page.locator("form.auth-card").getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".primary-nav").getByRole("button", { name: "Overview", exact: true }).waitFor();
  await page.locator(".account-row.selected").getByText(foreignLabel, { exact: true }).waitFor();
  assert.equal(await page.locator(".account-rows .account-row").count(), 1,
    "the second tenant must see only its own account");
  await page.locator(".site-panel .site-row").getByText("isolated.tenant.test").waitFor();

  const unauthorized = await page.evaluate(async (priorAccountId) => {
    const site = await fetch("/api/accounts/" + encodeURIComponent(priorAccountId) + "/sites");
    const refresh = await fetch("/api/jobs/refresh", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: priorAccountId }),
    });
    return { site: site.status, refresh: refresh.status };
  }, firstAccount.id);
  assert.deepEqual(unauthorized, { site: 404, refresh: 404 },
    "a separately logged-in tenant cannot inspect or refresh the previous tenant's account");

  const oldRequestCompleted = page.waitForResponse((response) =>
    response.url().endsWith("/api/overview") && response.status() === 200);
  allowLateOverview();
  await oldRequestCompleted;
  // Wait for the post-fetch React promise continuation, not just the transport.
  await page.waitForTimeout(150);
  assert.equal(await page.locator(".account-rows .account-row").count(), 1,
    "late owner response must not add other-tenant accounts after the switch");
  await page.locator(".account-row.selected").getByText(foreignLabel, { exact: true }).waitFor();
  assert.equal(await page.locator(".site-panel .site-row").getByText("isolated.tenant.test").count(), 1,
    "late owner response must not displace the second tenant's sites");
  await page.unroute("**/api/overview");

  // Repeat the boundary in the reverse direction for session-state reset.
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.locator("form.auth-card input[type='email']").fill("owner@example.test");
  await page.locator("form.auth-card input[type='password']").fill("owner-browser-passphrase-99");
  await page.locator("form.auth-card").getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".account-row.selected").getByText(firstAccount.label, { exact: true }).waitFor();
  assert.equal(await page.locator(".account-rows .account-row").getByText(foreignLabel).count(), 0,
    "the restored first tenant must not see the other tenant's account");

  // ORB-009: a second real Chromium login exercises the full MFA UI contract.
  // Every secret below is a disposable in-memory test value and is never logged,
  // captured in screenshots or written to evidence artifacts.
  const mfaContext = await browser.newContext();
  try {
    const mfaPage = await mfaContext.newPage();
    await mfaPage.goto(baseUrl, { waitUntil: "domcontentloaded" });
    const mfaEmail = mfaPage.locator("form.auth-card input[type='email']");
    const mfaPassword = mfaPage.locator("form.auth-card input[type='password']");
    await mfaEmail.fill(foreignEmail);
    await mfaPassword.fill("intentionally-wrong-password");
    await mfaPage.locator("form.auth-card").getByRole("button", { name: "Sign in", exact: true }).click();
    await mfaPage.locator("#auth-error").getByText(/could not sign in/i).waitFor();
    assert.equal(await mfaEmail.getAttribute("aria-invalid"), "false",
      "generic incorrect credentials must not blame the email address");
    assert.equal(await mfaPassword.getAttribute("aria-invalid"), "false",
      "generic incorrect credentials must not identify the password field");

    await mfaPassword.fill(foreignPassword);
    await mfaPage.locator("form.auth-card").getByRole("button", { name: "Sign in", exact: true }).click();
    await mfaPage.getByRole("button", { name: "Set up MFA" }).waitFor();
    await mfaPage.getByRole("button", { name: "Set up MFA" }).click();
    await mfaPage.locator(".mfa-panel input[autocomplete='current-password']").fill(foreignPassword);
    await mfaPage.getByRole("button", { name: "Start enrollment" }).click();
    const mfaSecret = (await mfaPage.locator(".mfa-panel .mfa-secret").textContent())?.trim();
    assert.ok(mfaSecret, "fixture enrollment must display the TOTP seed only to this authorized session");
    const enrollmentCode = totpAt(mfaSecret, Math.floor(mfaTestClockMs / 30_000) * 30);
    await mfaPage.locator(".mfa-panel input[autocomplete='one-time-code']").fill(enrollmentCode);
    await mfaPage.getByRole("button", { name: "Verify and enable" }).click();
    const recoveryItem = mfaPage.locator(".mfa-panel .recovery-codes li").first();
    await recoveryItem.waitFor();
    const singleUseRecovery = (await recoveryItem.textContent())?.trim();
    assert.ok(singleUseRecovery && singleUseRecovery.length >= 20,
      "fixture MFA confirmation must issue a one-time recovery option");
    await mfaPage.getByRole("button", { name: "I saved the codes" }).click();

    // Password verification must challenge, not create a session immediately.
    await mfaPage.getByRole("button", { name: "Sign out" }).click();
    await mfaPage.locator("form.auth-card input[type='email']").fill(foreignEmail);
    await mfaPage.locator("form.auth-card input[type='password']").fill(foreignPassword);
    await mfaPage.locator("form.auth-card").getByRole("button", { name: "Sign in", exact: true }).click();
    await mfaPage.getByRole("heading", { name: "Verify your sign-in" }).waitFor();
    const challengeInput = mfaPage.locator("form.auth-card input[autocomplete='one-time-code']");
    assert.equal(await mfaPage.evaluate(async () => (await fetch("/api/auth/me")).status), 401,
      "password-only phase of MFA must not establish an authenticated browser session");

    // Simulate a rate limiter and a temporary outage without consuming the
    // real challenge. Neither condition may mark the authenticator code wrong.
    const challengeUrl = "**/api/auth/mfa/challenge";
    for (const scenario of [
      { status: 429, error: "rate_limited", message: /too many sign-in attempts/i },
      { status: 503, error: "mfa_key_unavailable", message: /temporarily unavailable/i },
      { status: 401, error: "invalid_mfa_challenge", message: /start sign-in again/i },
    ]) {
      await mfaPage.route(challengeUrl, (route) => route.fulfill({
        status: scenario.status, contentType: "application/json",
        body: JSON.stringify({ error: scenario.error }),
      }));
      await challengeInput.fill("123456");
      await mfaPage.getByRole("button", { name: "Verify and sign in" }).click();
      await mfaPage.locator("#auth-error").getByText(scenario.message).waitFor();
      assert.equal(await challengeInput.getAttribute("aria-invalid"), "false",
        "transport, rate limiting and expired challenge cannot blame the MFA code");
      assert.equal(await challengeInput.getAttribute("aria-describedby"), null,
        "non-code errors must not associate a wrong-code message with the input");
      await mfaPage.unroute(challengeUrl);
    }
    await mfaPage.getByRole("button", { name: "Start sign-in again" }).click();
    await mfaPage.getByRole("heading", { name: "Welcome back" }).waitFor();
    assert.equal(await mfaPage.locator("#auth-error").count(), 0,
      "restarting an expired MFA request must clear the obsolete error");

    // A new challenge must attribute an actually rejected code to that input.
    await mfaPage.locator("form.auth-card input[type='email']").fill(foreignEmail);
    await mfaPage.locator("form.auth-card input[type='password']").fill(foreignPassword);
    await mfaPage.locator("form.auth-card").getByRole("button", { name: "Sign in", exact: true }).click();
    await mfaPage.getByRole("heading", { name: "Verify your sign-in" }).waitFor();
    const freshCode = mfaPage.locator("form.auth-card input[autocomplete='one-time-code']");
    await freshCode.fill("123456");
    await mfaPage.getByRole("button", { name: "Verify and sign in" }).click();
    await mfaPage.locator("#auth-error").getByText(/code was not accepted/i).waitFor();
    assert.equal(await freshCode.getAttribute("aria-invalid"), "true",
      "a real invalid_mfa_code must mark the actual MFA input");
    assert.equal(await freshCode.getAttribute("aria-describedby"), "auth-error",
      "a rejected MFA code must be linked programmatically to its alert");

    // Recover through the real browser, then prove this recovery code is
    // consumed on the next login rather than allowing a second session.
    await freshCode.fill(singleUseRecovery);
    await mfaPage.getByRole("button", { name: "Verify and sign in" }).click();
    await mfaPage.getByRole("button", { name: "Overview", exact: true }).waitFor();
    await mfaPage.locator(".account-row.selected").getByText(foreignLabel, { exact: true }).waitFor();
    await mfaPage.getByRole("button", { name: "Sign out" }).click();
    await mfaPage.locator("form.auth-card input[type='email']").fill(foreignEmail);
    await mfaPage.locator("form.auth-card input[type='password']").fill(foreignPassword);
    await mfaPage.locator("form.auth-card").getByRole("button", { name: "Sign in", exact: true }).click();
    await mfaPage.getByRole("heading", { name: "Verify your sign-in" }).waitFor();
    const reusedCode = mfaPage.locator("form.auth-card input[autocomplete='one-time-code']");
    await reusedCode.fill(singleUseRecovery);
    await mfaPage.getByRole("button", { name: "Verify and sign in" }).click();
    await mfaPage.locator("#auth-error").getByText(/code was not accepted/i).waitFor();
    assert.equal(await reusedCode.getAttribute("aria-invalid"), "true");
    assert.equal(await mfaPage.evaluate(async () => (await fetch("/api/auth/me")).status), 401,
      "used recovery code must not issue a second authenticated session");
  } finally {
    await mfaContext.close();
  }

  const runtime = {
    testIds: ["AUTH-WEBAUTHN-E2E-001", "AUTH-WEBAUTHN-REPLAY-001",
      "ORB-009-KEYBOARD", "ORB-018-RESPONSIVE"],
    node: process.version, chromium: browser.version(),
    rpId: "localhost", origin: baseUrl, virtualAuthenticator: "ctap2/internal",
    registration: "passed", assertion: "passed", counterUpdate: "passed",
    consumedChallenge: "rejected", wrongOrigin: "rejected", wrongRpHash: "rejected",
    expiredChallenge: "rejected", replayedCounter: "rejected",
    keyboardSkipLink: "passed", modalFocusTrapAndReturn: "passed",
    mobileNarrowNavigation: "passed", viewportChecks: [320, 390, 640, 768],
    responsive320pxReflow: "passed", reducedMotionPreference: "passed",
    emptyFilterAndFailedNetworkStates: "passed", readOnlyRoleRefreshControl: "passed",
    authBootstrapTokenErrorAssociation: "passed", passkeyMissingEmailErrorAssociation: "passed",
    genericBadCredentialsFieldsUnattributed: "passed",
    mfaRateLimitServiceChallengeErrorsUnattributed: "passed",
    mfaRealWrongCodeFieldAssociation: "passed",
    mfaBrowserRecoveryCodeConsumedOnce: "passed",
    accountSiteFailureAndRetry: "passed", crossSessionSelectionReset: "passed",
    missingAccountSelectionReconciled: "passed",
    distinctTenantSessionScope: "passed", delayedOldTenantResponseDiscarded: "passed",
    physicalAuthenticator: "not_tested", liveProvider: "not_tested",
    manualScreenReaderAudit: "not_tested", fullWcagContrastAudit: "not_tested",
  };
  writeFileSync(evidenceDir + "/runtime.json", JSON.stringify(runtime, null, 2) + "\n");
  console.log(JSON.stringify({ browserVerified: true, ...runtime }));
} finally {
  await browser.close();
  app.close();
}
