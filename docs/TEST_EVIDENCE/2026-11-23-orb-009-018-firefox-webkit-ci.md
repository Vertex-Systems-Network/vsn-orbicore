# ORB-009 / ORB-018 — independent Firefox and WebKit browser regression CI

**Date:** 2026-11-23 UTC. **State:** New matrix job and browser driver pending hosted GitHub CI verification.

## Rationale

The existing mandatory hosted browser workflow exercises Chromium/WebAuthn, Chrome native page zoom 200%/400%, and a simulated 200% text-only stylesheet. These browser-engine-specific checks do not prove Firefox and WebKit behavior. The Phase 1 dashboard accessibility tasks explicitly list independent engines as an open gate.

## Added coverage

- A new **2-engine matrix** in `.github/workflows/ci-browser.yml`, one isolated Ubuntu runner each for Playwright Firefox and WebKit. Install only the needed browser and its system dependencies via Playwright CLI (per [official Playwright CI guidance](https://playwright.dev/docs/ci)). Preserve existing Chromium job as-is.
- A new `scripts/browser-cross-engine.mjs` fixture driver boots independent synthetic local SQLite/API and browser sessions, checks bootstrap reflow at 1280/390/320 CSS pixels, keyboard Tab sequence to password, completes owner creation, checks Overview/Websites/Hosting accounts/Jobs & activity for document overflow at three widths, opens/closes the Authenticator setup dialog at 320 px with Escape.
- Persist only a small, **non-sensitive** per-engine JSON record with browser version, test state names, viewport/document width, keyboard results and explicit limitations. Do not export cookies, tokens, UI screenshots, account data or real provider credentials.

## Required verification

GitHub Node plan/lint/security/SBOM/build/smoke/doctor plus new hosted Firefox and WebKit jobs, existing Chromium/WebAuthn/Chrome zoom, trusted PR ledger. If a browser check fails, fix the actual code/regression or document why it is blocked rather than disabling the job. Inspect final head SHA and both engine artifacts, update measured evidence and task records, then only merge on green gates. Confirm post-merge main CI. Production/live identity and manual accessibility remain blocked.

## Explicit limitations

This is **not native Firefox Text Only Zoom**, a physical passkey/authenticator, real WebKit/Safari on an iPhone, keyboard screen-reader testing, full WCAG certification, manual contrast audit, touch testing, production PostgreSQL authority or live cPanel. ORB-009 and ORB-018 remain `testing/browser_tested` until independent broader requirements are met.
