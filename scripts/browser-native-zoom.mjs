import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../apps/api/server.mjs";

const { chromium } = await import("playwright");
const bootstrapToken = process.env.ORBICORE_BOOTSTRAP_TOKEN || "ci-native-zoom-bootstrap-test-token-32bytes";
const app = createApp({ dbPath: ":memory:", startWorker: false, bootstrapToken });
await new Promise((ok, fail) => {
  app.server.once("error", fail);
  app.server.listen(0, ok);
});
const baseUrl = "http://localhost:" + app.server.address().port;
const extensionPath = resolve("tests/fixtures/native-zoom-extension");
const profileDir = mkdtempSync(join(tmpdir(), "orbicore-zoom-"));
const evidenceDir = resolve(".data/browser-evidence");
let context;

async function setNativeZoom(worker, url, zoom) {
  const result = await worker.evaluate(async ({ url, zoom }) => {
    const tabs = await chrome.tabs.query({});
    const target = tabs.find((tab) => typeof tab.url === "string" && tab.url.startsWith(url));
    if (!target || typeof target.id !== "number") throw new Error("Fixture browser tab unavailable to extension");
    await chrome.tabs.setZoom(target.id, zoom);
    return { requested: zoom, applied: await chrome.tabs.getZoom(target.id) };
  }, { url, zoom });
  assert.ok(Math.abs(result.applied - zoom) < 0.01,
    "Chrome native zoom API returned " + result.applied + " but expected " + zoom);
  return result.applied;
}

async function assessReflow(page, label, zoom) {
  await page.waitForFunction((expected) => Math.abs(window.innerWidth - expected) <= 6,
    1280 / zoom, { timeout: 10_000 });
  const outcome = await page.evaluate(() => {
    const doc = document.documentElement;
    if (!document.querySelector("main")) throw new Error("Accessible main landmark not found");
    return {
      innerWidth: window.innerWidth,
      viewportWidth: doc.clientWidth,
      documentWidth: doc.scrollWidth,
      devicePixelRatio: window.devicePixelRatio,
      mainCount: document.querySelectorAll("main").length,
    };
  });
  assert.ok(Math.abs(outcome.viewportWidth - (1280 / zoom)) <= 6,
    label + ": native zoom must alter CSS layout viewport");
  assert.ok(outcome.documentWidth <= outcome.viewportWidth + 2,
    label + ": page-wide horizontal overflow at " + (zoom * 100) + "%: " +
    outcome.documentWidth + " > " + outcome.viewportWidth);
  assert.equal(outcome.mainCount, 1, label + ": exactly one main landmark required");
  return { zoom, ...outcome };
}

try {
  context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium", headless: true,
    viewport: { width: 1280, height: 960 },
    args: [
      "--disable-extensions-except=" + extensionPath,
      "--load-extension=" + extensionPath,
    ],
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20_000 });
  assert.ok(worker.url().startsWith("chrome-extension://"),
    "Native zoom API must run in the temporary fixture extension");
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator("form.auth-card input[autocomplete='new-password']").waitFor();

  const authMeasurements = [await assessReflow(page, "auth", 1)];
  for (const zoom of [2, 4]) {
    await setNativeZoom(worker, baseUrl, zoom);
    authMeasurements.push(await assessReflow(page, "auth", zoom));
    const tokenField = page.locator("form.auth-card input[autocomplete='off']");
    const emailField = page.locator("form.auth-card input[autocomplete='username']");
    const passwordField = page.locator("form.auth-card input[autocomplete='new-password']");
    assert.ok(await tokenField.isVisible() && await emailField.isVisible() && await passwordField.isVisible(),
      "Bootstrap form controls must remain present at zoom " + zoom);
    await emailField.focus();
    await page.keyboard.press("Tab");
    assert.equal(await passwordField.evaluate((input) => document.activeElement === input), true,
      "Keyboard focus must reach password field at zoom " + zoom);
  }

  await page.locator("form.auth-card input[autocomplete='off']").fill(bootstrapToken);
  await page.locator("form.auth-card input[autocomplete='username']").fill("zoom-owner@example.test");
  await page.locator("form.auth-card input[autocomplete='new-password']").fill("zoom-browser-unique-passphrase-99");
  await page.getByRole("button", { name: "Create workspace owner" }).click();
  await page.getByRole("button", { name: "Overview", exact: true }).waitFor({ timeout: 15_000 });
  assert.equal(await page.evaluate(async () => (await fetch("/api/auth/me")).status), 200,
    "Native 400% zoom must not stop successful synthetic bootstrap");

  const dashboardMeasurements = [];
  for (const zoom of [4, 2, 1]) {
    await setNativeZoom(worker, baseUrl, zoom);
    dashboardMeasurements.push(await assessReflow(page, "dashboard", zoom));
    for (const name of ["Overview", "Websites", "Hosting accounts", "Jobs & activity"]) {
      const button = page.getByRole("button", { name, exact: true }).first();
      await button.click();
      assert.equal(await button.getAttribute("aria-current"), "page",
        name + ": active navigation must remain discoverable at zoom " + zoom);
      await assessReflow(page, "dashboard/" + name, zoom);
    }
  }
  await setNativeZoom(worker, baseUrl, 4);
  const sidebarAt400 = await page.locator(".sidebar").evaluate((sidebar) => ({
    availableHeight: sidebar.clientHeight,
    contentHeight: sidebar.scrollHeight,
    overflowY: getComputedStyle(sidebar).overflowY,
  }));
  assert.equal(sidebarAt400.overflowY, "auto",
    "native 400% collapsed navigation must be scrollable, not clipped");
  assert.ok(sidebarAt400.contentHeight > sidebarAt400.availableHeight,
    "native 400% fixture must exercise the sidebar vertical overflow path");
  const lastNav = page.getByRole("button", { name: "Jobs & activity", exact: true });
  await lastNav.click();
  const lastNavVisible = await lastNav.evaluate((button) => {
    const scroller = button.closest(".sidebar");
    const rect = button.getBoundingClientRect();
    const parent = scroller?.getBoundingClientRect();
    return !!parent && rect.top >= parent.top - 1 && rect.bottom <= parent.bottom + 1;
  });
  assert.equal(lastNavVisible, true,
    "sidebar must scroll bottom navigation into the visual viewport at native 400%");
  await page.getByRole("button", { name: "Websites", exact: true }).click();
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({
    path: join(evidenceDir, "orb-009-real-chromium-400-percent-websites.png"),
    fullPage: true,
  });
  // Screenshot is taken after bootstrap on synthetic inventory; no token/MFA UI.

  // ORB-009: native 400% zoom leaves only 320x240 CSS pixels. The security
  // dialog must remain keyboard operable inside its own scrollport without
  // allowing fixed sidebar/main content to hide focused modal controls.
  const opener = page.locator(".sidebar-bottom .settings-item");
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Authenticator setup" });
  await dialog.waitFor();
  const closeButton = dialog.getByRole("button", { name: "Close security setup" });
  assert.equal(await closeButton.evaluate((el) => document.activeElement === el), true,
    "security dialog must autofocus its close control even at native 400% zoom");

  const checkModalFocusVisible = async (control, label) => {
    await control.focus();
    const result = await control.evaluate((node) => {
      const panel = node.closest(".mfa-panel");
      const target = node.getBoundingClientRect();
      const viewport = panel?.getBoundingClientRect();
      const innerWidth = document.documentElement.clientWidth;
      const innerHeight = document.documentElement.clientHeight;
      return {
        insidePanel: !!viewport && target.top >= viewport.top - 2 &&
          target.bottom <= viewport.bottom + 2 &&
          target.left >= viewport.left - 2 && target.right <= viewport.right + 2,
        insideBrowser: target.top >= -2 && target.bottom <= innerHeight + 2 &&
          target.left >= -2 && target.right <= innerWidth + 2,
        active: document.activeElement === node,
        innerWidth, innerHeight,
        panelScrollHeight: panel?.scrollHeight ?? 0,
        panelClientHeight: panel?.clientHeight ?? 0,
        panelOverflow: panel ? getComputedStyle(panel).overflowY : "missing",
        documentWidth: document.documentElement.scrollWidth,
      };
    });
    assert.ok(result.active && result.insidePanel && result.insideBrowser,
      label + ": focused security control must not be clipped or off-screen at native 400%: " +
      JSON.stringify(result));
    assert.ok(result.documentWidth <= result.innerWidth + 2,
      label + ": security modal must not introduce page-wide horizontal overflow");
    return result;
  };
  const securityModalAt400 = {
    close: await checkModalFocusVisible(closeButton, "Close security setup"),
    passkeyToggle: await checkModalFocusVisible(
      dialog.getByRole("button", { name: "Add a passkey" }), "Add a passkey"),
    enrollPassword: await checkModalFocusVisible(
      dialog.locator("input[autocomplete='current-password']").first(), "Current password"),
  };
  // Enable the real conditional action before asserting focusability; never
  // submit this fixture credential or record its value in evidence.
  await dialog.locator("input[autocomplete='current-password']").first().fill(
    "zoom-browser-unique-passphrase-99");
  securityModalAt400.enrollAction = await checkModalFocusVisible(
    dialog.getByRole("button", { name: "Start enrollment" }), "Start enrollment");
  await dialog.getByRole("button", { name: "Add a passkey" }).click();
  const passkeyField = dialog.locator(".passkey-setup input[autocomplete='current-password']");
  securityModalAt400.passkeyPassword = await checkModalFocusVisible(
    passkeyField, "Passkey confirmation input");
  await passkeyField.fill("zoom-browser-unique-passphrase-99");
  securityModalAt400.passkeyAction = await checkModalFocusVisible(
    dialog.getByRole("button", { name: "Register passkey" }), "Register passkey");

  // Exercise the actual keyboard traversal at 400%, not only programmatic
  // focus: reverse Tab from the first modal control must wrap to the last,
  // and forward Tab must return to the close control without escaping.
  await closeButton.focus();
  await page.keyboard.press("Shift+Tab");
  const reverseTabIsInsideDialog = await dialog.evaluate((node) =>
    node.contains(document.activeElement) && document.activeElement !== node);
  assert.equal(reverseTabIsInsideDialog, true,
    "native 400% Shift+Tab must keep focus within the security dialog");
  await page.keyboard.press("Tab");
  const forwardTabWrappedToClose = await closeButton.evaluate((node) =>
    document.activeElement === node);
  assert.equal(forwardTabWrappedToClose, true,
    "native 400% Tab must wrap to dialog close rather than background content");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  const returnFocusAt400 = await opener.evaluate((node) => {
    const target = node.getBoundingClientRect();
    const scroller = node.closest(".sidebar");
    const scrollport = scroller?.getBoundingClientRect();
    return {
      returned: document.activeElement === node,
      inSidebarView: !!scrollport &&
        target.top >= scrollport.top - 1 && target.bottom <= scrollport.bottom + 1,
    };
  });
  assert.deepEqual(returnFocusAt400, { returned: true, inSidebarView: true },
    "Escape must return keyboard focus to a visible sidebar opener at native 400%");

  const proof = {
    browserVerifiedNativePageZoom: true,
    method: "chrome.tabs.setZoom and chrome.tabs.getZoom (CI-only MV3 extension)",
    chromium: context.browser()?.version() ?? "unknown",
    desktopWindowCssViewport: { width: 1280, height: 960 },
    ratios: [1, 2, 4],
    authMeasurements, dashboardMeasurements,
    keyboardAuthPasswordFocus: "passed",
    dashboardNavigationAndPageWideReflow: "passed",
    sidebarAt400, bottomNavigationReachableAt400: "passed",
    securityDialogKeyboardAndFocusAt400: "passed", securityModalAt400,
    securityDialogReverseAndForwardTabTrapAt400: "passed",
    securityDialogEscapeFocusReturnAt400: returnFocusAt400,
    knownLimitations: [
      "Synthetic localhost SQLite; no external hosting credentials or identity provider",
      "Chromium only; other browsers and OS accessibility magnification not tested",
      "Not a full WCAG/manual screen-reader/contrast/touch-target certification",
      "Table-local two-dimensional scrolling may remain; page-wide overflow denied",
    ],
  };
  writeFileSync(join(evidenceDir, "native-zoom-runtime.json"), JSON.stringify(proof, null, 2) + "\n");
  console.log(JSON.stringify(proof));
} finally {
  if (context) await context.close();
  app.close();
  rmSync(profileDir, { recursive: true, force: true });
}
