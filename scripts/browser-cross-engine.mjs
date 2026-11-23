import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../apps/api/server.mjs";

// Independent browser-engine smoke coverage. Chromium's WebAuthn CDP and
// native Chrome zoom suites remain separate; this is NOT Firefox text-only
// zoom, a physical authenticator, or a WCAG certification.
const engine = process.env.ORBICORE_CROSS_BROWSER_ENGINE;
if (!["firefox", "webkit"].includes(engine)) {
  throw new Error("ORBICORE_CROSS_BROWSER_ENGINE must be firefox or webkit");
}
const playwright = await import("playwright");
const bootstrapToken = process.env.ORBICORE_BOOTSTRAP_TOKEN || "cross-engine-local-bootstrap-token-32b";
const app = createApp({ dbPath: ":memory:", startWorker: false, bootstrapToken });
let browser;

async function assessReflow(page, stage) {
  const snapshot = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
    mainCount: document.querySelectorAll("main").length,
    heading: document.querySelector(".page-heading h1, form.auth-card h1, .mfa-panel h2")?.textContent?.trim() ?? null,
  }));
  assert.equal(snapshot.mainCount, 1, stage + ": expected exactly one accessible main landmark");
  assert.ok(snapshot.documentWidth <= snapshot.viewport + 2,
    stage + ": document-level horizontal overflow: " + JSON.stringify(snapshot));
  assert.ok(snapshot.heading, stage + ": visible heading missing");
  return { stage, ...snapshot };
}

try {
  await new Promise((resolveListen, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolveListen);
  });
  const origin = "http://127.0.0.1:" + app.server.address().port;
  browser = await playwright[engine].launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator("form.auth-card input[autocomplete='new-password']").waitFor();

  const screenshotsOrSecrets = false;
  const checks = [];
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    checks.push(await assessReflow(page, "bootstrap/" + width));
  }
  // The essential form progression must work by keyboard in each engine.
  const email = page.locator("form.auth-card input[autocomplete='username']");
  const password = page.locator("form.auth-card input[autocomplete='new-password']");
  await email.focus();
  await page.keyboard.press("Tab");
  assert.equal(await password.evaluate((el) => document.activeElement === el),
    true, engine + ": keyboard Tab did not advance from email to password");

  await page.locator("form.auth-card input[autocomplete='off']").fill(bootstrapToken);
  await email.fill("cross-engine-owner@example.test");
  await password.fill("cross-engine-unique-synthetic-password-99");
  await page.getByRole("button", { name: "Create workspace owner" }).click();
  await page.getByRole("button", { name: "Overview", exact: true }).waitFor({ timeout: 20_000 });

  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    for (const section of ["Overview", "Websites", "Hosting accounts", "Jobs & activity"]) {
      await page.getByRole("button", { name: section, exact: true }).click();
      await page.locator(".page-heading h1").waitFor();
      checks.push(await assessReflow(page, section + "/" + width));
    }
  }

  await page.setViewportSize({ width: 320, height: 800 });
  await page.locator(".sidebar-bottom .settings-item").click();
  const dialog = page.getByRole("dialog", { name: "Authenticator setup" });
  await dialog.waitFor();
  // The dialog has its own scroller but must not introduce page-wide overflow.
  checks.push(await assessReflow(page, "security-dialog/320"));
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });

  const report = {
    engine,
    browserVersion: browser.version(),
    syntheticLocalOnly: true,
    screenshotsOrSecrets,
    widths: [1280, 390, 320],
    checks,
    keyboardEmailToPassword: "passed",
    dialogEscape: "passed",
    notNativeFirefoxTextOnlyZoom: true,
    notFullAccessibilityOrProviderEvidence: true,
  };
  const dir = resolve(".data/browser-evidence");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "cross-engine-" + engine + ".json"),
    JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({
    engine, browserVersion: report.browserVersion, checkedStates: checks.length,
    documentOverflow: false, keyboard: "passed", escape: "passed",
  }));
} finally {
  if (browser) await browser.close();
  app.close();
}
