import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../apps/api/server.mjs";

const { chromium } = await import("playwright");
const bootstrapToken = process.env.ORBICORE_BOOTSTRAP_TOKEN || "ci-text-resize-token-32bytes";
const app = createApp({ dbPath: ":memory:", startWorker: false, bootstrapToken });
await new Promise((ok, fail) => {
  app.server.once("error", fail);
  app.server.listen(0, ok);
});
const origin = "http://localhost:" + app.server.address().port;
const evidencePath = resolve(".data/browser-evidence/text-resize-runtime.json");
let browser;

async function inspectAtDoubleText(page, state, selectors) {
  // This is an explicit browser-side USER STYLESHEET SIMULATION, not the native
  // Firefox "Zoom Text Only" control. Every rendered element bearing its own
  // text receives twice its original computed font-size; layout widths stay
  // unchanged. Inline font styles are restored in the same synchronous task.
  const findings = await page.evaluate(({ selectors }) => {
    const samples = selectors.map((selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) throw new Error("Sample missing: " + selector);
      if (getComputedStyle(element).display === "none") throw new Error("Sample hidden: " + selector);
      return { selector, element, originalFontPx: parseFloat(getComputedStyle(element).fontSize) };
    });
    const changes = [];
    for (const element of document.querySelectorAll("body *")) {
      if (!(element instanceof HTMLElement)) continue;
      if (!Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) &&
        !element.matches("input, select, textarea")) continue;
      if (getComputedStyle(element).display === "none") continue;
      const original = getComputedStyle(element).fontSize;
      const pixels = parseFloat(original);
      if (!Number.isFinite(pixels) || pixels <= 0) continue;
      changes.push({
        element,
        value: element.style.getPropertyValue("font-size"),
        priority: element.style.getPropertyPriority("font-size"),
      });
      element.style.setProperty("font-size", (pixels * 2) + "px", "important");
    }
    try {
      const viewport = document.documentElement.clientWidth;
      const documentWidth = document.documentElement.scrollWidth;
      return {
        alteredTextElements: changes.length, viewport, documentWidth,
        samples: samples.map(({ selector, element, originalFontPx }) => {
          const computed = getComputedStyle(element);
          const fontPx = parseFloat(computed.fontSize);
          const box = element.getBoundingClientRect();
          const textRects = [];
          for (const node of element.childNodes) {
            if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const rect of range.getClientRects()) {
              textRects.push({
                x: Math.round(rect.left * 100) / 100,
                y: Math.round(rect.top * 100) / 100,
                width: Math.round(rect.width * 100) / 100,
                height: Math.round(rect.height * 100) / 100,
              });
            }
          }
          const overflowX = element.scrollWidth > element.clientWidth + 2;
          const overflowY = element.scrollHeight > element.clientHeight + 2;
          const textOutside = textRects.some((rect) =>
            rect.x < box.left - 3 || rect.y < box.top - 3 ||
            rect.x + rect.width > box.right + 3 ||
            rect.y + rect.height > box.bottom + 3
          );
          return {
            selector, originalFontPx, doubledFontPx: fontPx,
            width: element.clientWidth, scrollWidth: element.scrollWidth,
            height: element.clientHeight, scrollHeight: element.scrollHeight,
            overflowX, overflowY, textOutside, textRectCount: textRects.length,
          };
        }),
      };
    } finally {
      for (const { element, value, priority } of changes) {
        if (value) element.style.setProperty("font-size", value, priority);
        else element.style.removeProperty("font-size");
      }
    }
  }, { selectors });
  assert.ok(findings.alteredTextElements >= 8,
    state + ": font-only fixture did not affect enough real text elements");
  assert.ok(findings.documentWidth <= findings.viewport + 2,
    state + ": doubled text caused page-wide horizontal scroll: " +
    findings.documentWidth + " > " + findings.viewport);
  for (const sample of findings.samples) {
    assert.ok(Math.abs(sample.doubledFontPx / sample.originalFontPx - 2) < 0.02,
      state + ": expected exactly doubled computed font: " + JSON.stringify(sample));
    assert.ok(!sample.textOutside && !sample.overflowX && !sample.overflowY,
      state + ": doubled UI text clipped/overflows: " + JSON.stringify(sample));
  }
  return { state, ...findings };
}

try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator("form.auth-card input[autocomplete='new-password']").waitFor();

  const auth = [];
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    auth.push(await inspectAtDoubleText(page, "bootstrap/" + width, [
      "form.auth-card h1", "form.auth-card > p",
      "form.auth-card label:first-of-type", "form.auth-card .auth-submit",
      "form.auth-card .auth-footnote",
    ]));
  }
  await page.locator("form.auth-card input[autocomplete='off']").fill(bootstrapToken);
  await page.locator("form.auth-card input[autocomplete='username']").fill("text-resize-owner@example.test");
  await page.locator("form.auth-card input[autocomplete='new-password']").fill("text-resize-synthetic-passphrase-99");
  await page.getByRole("button", { name: "Create workspace owner" }).click();
  await page.getByRole("button", { name: "Overview", exact: true }).waitFor({ timeout: 12_000 });

  const dashboard = [];
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    for (const section of ["Overview", "Websites", "Hosting accounts", "Jobs & activity"]) {
      await page.getByRole("button", { name: section, exact: true }).click();
      dashboard.push(await inspectAtDoubleText(page, section + "/" + width, [
        ".page-heading h1", ".page-subtitle",
        ".topbar .theme-toggle",
      ]));
    }
  }
  await page.setViewportSize({ width: 320, height: 800 });
  await page.locator(".sidebar-bottom .settings-item").click();
  const dialog = page.getByRole("dialog", { name: "Authenticator setup" });
  await dialog.waitFor();
  const modal = [
    await inspectAtDoubleText(page, "securityDialog/320", [
      ".mfa-panel h2", ".mfa-panel > p", ".mfa-panel label",
      ".mfa-panel .secondary-button", ".mfa-panel .mfa-close",
    ]),
  ];
  await dialog.getByRole("button", { name: "Add a passkey" }).click();
  modal.push(await inspectAtDoubleText(page, "securityPasskey/320", [
    ".passkey-setup > p", ".passkey-setup h3", ".passkey-setup label",
    ".mfa-panel .secondary-button",
  ]));
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });

  mkdirSync(resolve(".data/browser-evidence"), { recursive: true });
  const proof = {
    simulatedFontOnlyResize200: "passed",
    method: "double computed text-bearing HTML font sizes inline in synchronous fixture; restore originals",
    notNativeFirefoxTextOnlyZoom: true,
    chromium: browser.version(),
    auth, dashboard, modal,
    limitations: [
      "Simulated text-only 200% browser style override, not native Firefox text-only zoom or browser setting",
      "Focused text/control sample only, not every text element or full WCAG SC 1.4.4 conformance",
      "Synthetic localhost SQLite and no production provider or identity credentials",
      "No screen-reader, accessibility magnifier, touch target, or independent human visual audit",
    ],
  };
  writeFileSync(evidencePath, JSON.stringify(proof, null, 2) + "\n");
  console.log(JSON.stringify({
    simulatedFontOnlyResize200: "passed",
    chromium: proof.chromium,
    authStates: auth.length, dashboardStates: dashboard.length,
    modalStates: modal.length,
    verifiedSampleCount: [...auth, ...dashboard, ...modal].reduce((n, row) => n + row.samples.length, 0),
    widths: [1280, 390, 320],
  }));
} finally {
  if (browser) await browser.close();
  app.close();
}
