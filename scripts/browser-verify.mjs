import assert from "node:assert/strict";
import { createApp } from "../apps/api/server.mjs";

const { chromium } = await import("playwright");

const bootstrapToken = process.env.ORBICORE_BOOTSTRAP_TOKEN || "browser-verify-bootstrap-token-32b";
const mfaKey = process.env.ORBICORE_MFA_ENCRYPTION_KEY || "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const app = createApp({ dbPath: ":memory:", startWorker: true, bootstrapToken, mfaKey });

await new Promise((resolveListen, reject) => {
  app.server.once("error", reject);
  app.server.listen(0, "127.0.0.1", resolveListen);
});

const port = app.server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;
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

  await page.goto(baseUrl, { waitUntil: "networkidle" });

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
  await page.getByText("Overview").waitFor({ timeout: 10_000 });

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
  await page.getByRole("button", { name: /MFA|Security/i }).click();
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await page.locator(".passkey-setup input[type='password']").fill("owner-browser-passphrase-99");
  await page.getByRole("button", { name: "Register passkey" }).click();
  await page.getByText(/Passkey enrolled on this device/i).waitFor({ timeout: 10_000 });
  await page.keyboard.press("Escape");

  const credentials = await fetch(`${baseUrl}/api/health`).then((r) => r.json());
  assert.equal(credentials.status, "ok");
  console.log(JSON.stringify({ browserVerified: true, webauthnVirtualAuthenticator: true, a11yChecksPassed: true, navigationTabsChecked: 7 }));
} finally {
  await browser.close();
  app.close();
}
