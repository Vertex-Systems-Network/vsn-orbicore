# ORB-009 / ORB-018 — independent Firefox and WebKit browser regression CI

**Date:** 2026-11-23 UTC. **State:** Functional PR SHA `8477ba8358374b56062a2200cad41a2fe44f6516` passed hosted CI in all three browsers; docs-head CI/merge pending.

## Rationale

The existing mandatory hosted browser workflow exercises Chromium/WebAuthn, Chrome native page zoom 200%/400%, and a simulated 200% text-only stylesheet. These browser-engine-specific checks do not prove Firefox and WebKit behavior. The Phase 1 dashboard accessibility tasks explicitly list independent engines as an open gate.

## Added coverage

- A new **2-engine matrix** in `.github/workflows/ci-browser.yml`, one isolated Ubuntu runner each for Playwright Firefox and WebKit. Install only the needed browser and its system dependencies via Playwright CLI (per [official Playwright CI guidance](https://playwright.dev/docs/ci)). Preserve existing Chromium job as-is.
- A new `scripts/browser-cross-engine.mjs` fixture driver boots independent synthetic local SQLite/API and browser sessions, checks bootstrap reflow at 1280/390/320 CSS pixels, keyboard Tab sequence to password, completes owner creation, checks Overview/Websites/Hosting accounts/Jobs & activity for document overflow at three widths, opens/closes the Authenticator setup dialog at 320 px with Escape.
- Persist only a small, **non-sensitive** per-engine JSON record with browser version, test state names, viewport/document width, keyboard results and explicit limitations. Do not export cookies, tokens, UI screenshots, account data or real provider credentials.

## Measured GitHub CI verification

- [PR CI #45185137467](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45185137467) and [branch CI #45185060085](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45185060085) passed **170/170 Node**, zero failures, including plan, security, npm audit, CycloneDX official local schema/SBOM, build/smoke/doctor.
- [Browser run #45185137763](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45185137763) passed **3/3 jobs**: [Firefox 159.0](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45185137763/job/137728659775) and [WebKit 27.2](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45185137763/job/137728659809) each reported **16 checked states**, zero page-wide overflow, successful keyboard Tab and dialog Escape; existing Chromium/WebAuthn/zoom suite passed.
- Non-sensitive [Firefox artifact #14823376757](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45185137763/artifacts/14823376757) and [WebKit artifact #14823686209](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45185137763/artifacts/14823686209) include metadata only. [Trusted ledger #45185137468](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45185137468) passed. PG16/Redis7 workflow **not triggered** by this path-scoped diff.
- **Pending:** final docs-head CI, PR merge, post-merge main CI. These browser checks do **not** establish native Firefox Text Only Zoom, manual WCAG or production/provider signoff.

## Explicit limitations

This is **not native Firefox Text Only Zoom**, a physical passkey/authenticator, real WebKit/Safari on an iPhone, keyboard screen-reader testing, full WCAG certification, manual contrast audit, touch testing, production PostgreSQL authority or live cPanel. ORB-009 and ORB-018 remain `testing/browser_tested` until independent broader requirements are met.
