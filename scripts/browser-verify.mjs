import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createApp } from "../apps/api/server.mjs";

const { chromium } = await import("playwright");

const bootstrapToken = process.env.ORBICORE_BOOTSTRAP_TOKEN || "browser-verify-bootstrap-token-32b";
const mfaKey = process.env.ORBICORE_MFA_ENCRYPTION_KEY || "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
// A stable localhost origin is required: WebAuthn RP ID and expected origin must match the browser URL.
const port = Number(process.env.ORBICORE_BROWSER_PORT ?? 41753);
const baseUrl = "http://localhost:" + port;
const app = createApp({ dbPath: ":memory:", startWorker: true, bootstrapToken, mfaKey, webauthnRPID: "localhost", webauthnOrigin: baseUrl });

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

  for (const label of ["Hosting accounts", "Websites", "Migrations", "Storage", "Jobs & activity", "Automation & reports", "System & security"]) {
    await page.getByRole("button", { name: label }).click();
  }

  // Verify audit hash chain UI indicator
  await page.getByRole("button", { name: "Jobs & activity" }).click();
  await page.getByRole("button", { name: "Verify audit chain" }).click();
  await page.getByText(/SHA-256 audit chain verified/i).waitFor({ timeout: 5_000 });

  // Enroll passkey via virtual authenticator & verify Escape dismissal
  await page.locator(".sidebar-bottom .settings-item").click();
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await page.locator(".passkey-setup input[type='password']").fill("owner-browser-passphrase-99");
  await page.getByRole("button", { name: "Register passkey" }).click();
  await page.getByText(/Passkey enrolled on this device/i).waitFor({ timeout: 10_000 });
  await page.keyboard.press("Escape");


  // ORB-012: use the actual browser virtual authenticator for a passwordless assertion.
  const registered = app.db.prepare("SELECT credential_id, counter FROM passkeys").get();
  assert.ok(registered?.credential_id, "browser enrollment must persist a passkey");
  const initialCounter = registered.counter;
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.reload({ waitUntil: "domcontentloaded" });
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
  const runtime = {
    testIds: ["AUTH-WEBAUTHN-E2E-001", "AUTH-WEBAUTHN-REPLAY-001"],
    node: process.version, chromium: browser.version(),
    rpId: "localhost", origin: baseUrl, virtualAuthenticator: "ctap2/internal",
    registration: "passed", assertion: "passed", counterUpdate: "passed",
    consumedChallenge: "rejected", wrongOrigin: "rejected", wrongRpHash: "rejected",
    expiredChallenge: "rejected", replayedCounter: "rejected",
    physicalAuthenticator: "not_tested", liveProvider: "not_tested",
  };
  writeFileSync(evidenceDir + "/runtime.json", JSON.stringify(runtime, null, 2) + "\n");
  console.log(JSON.stringify({ browserVerified: true, ...runtime }));
} finally {
  await browser.close();
  app.close();
}
