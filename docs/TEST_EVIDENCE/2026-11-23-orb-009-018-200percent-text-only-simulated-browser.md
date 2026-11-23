# ORB-009 / ORB-018 — 200% font-only override: browser regression and CSS fixes

**Date:** 2026-11-23
**PR:** [#50](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/50)
**Functional head SHA:** `969fc6312d4f75b1bf1d4aa0c99114956a72b699`
**Scope:** synthetic in-memory SQLite user and Chromium 159.0.8154.6; **CSS font-only override simulation**, not native Firefox "Zoom Text Only."

## Observed hosted verification

- [PR CI #45099390177](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45099390177), [branch CI #45099384272](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45099384272) and [Chrome browser suite #45099390144](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45099390144): **success** at functional SHA `969fc6312d4f75b1bf1d4aa0c99114956a72b699`.
- CI: **113 Node tests pass, 0 fail**; 254 eligible Git-tracked source files scanned with no high-confidence findings, no unknown npm dependency license metadata, official CycloneDX **npm-lockfile-only** JSON schema (189 components) passed, npm audit reported zero findings **at run time**.
- Browser: existing real Chrome 100/200/400% native page zoom, WebAuthn, MFA recovery and negative/error states, tenant isolation and sampled text-spacing checks remained green; new independent font-size-only fixture succeeded in **3 bootstrap states, 12 dashboard states, 2 security-dialog states, 60 sampled text nodes** across **1280, 390 and 320 CSS px**.
- Non-sensitive browser artifact [#14785135017](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45099390144/artifacts/14785135017), SHA256 `261247cc78c6b6463843251e41380802416971fc3c38005eaf64c40017047077`: contains `.data/browser-evidence/text-resize-runtime.json` plus previous synthetic browser evidence. Text-only test emits measured widths/font sizes/overflow booleans; **no submitted credential or MFA code values**.

## Red / green browser-backed changes

1. Initial CI browser [#45098585872](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45098585872) at `a1b10b78` failed due to the *test harness* calling `.some` on a DOM NodeList. Changed to `Array.from(...).some` before interpreting any application behavior.
2. At SHA `890d7731`, browser [#45098737958](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45098737958) showed **real application page-wide overflow** at 390 CSS px with doubled text: document width **445 px**, auth card/grid width **420 px**. Fix: an explicit zero-minimum auth grid track; form min-width/max-width constraints and wrappable content; input/label min-width boundaries.
3. At SHA `63fea11a`, browser [#45099030949](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45099030949) reached 320px bootstrap and caught clipped two-line **Create workspace owner** text: button height **38px**, scroll content **53px**. Fix: auto-height action, 40px minimum, adequate vertical padding and natural line wrapping.
4. At SHA `1865780e`, browser [#45099138238](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45099138238) found a doubled **Authenticator setup** heading at narrow width extending **302px of text into a 222px container**. Fix: `overflow-wrap:anywhere` on the security panel.
5. At SHA `bed4a34d`, browser [#45099257347](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45099257347) found the security password label at width **222px** having **526px horizontal scroll content**, due to the input's intrinsic minimum grid size. Fix: `grid-template-columns:minmax(0,1fr)` on security labels and `min-width:0;width:100%` on their inputs.
6. Final SHA `969fc6312d4f75b1bf1d4aa0c99114956a72b699`: [#45099390144](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45099390144) **passed all checks**, including 60 text/control samples, no measured sampled clipping, and no global overflow across the tested states.

## What the test actually does

`scripts/browser-text-resize.mjs` uses **real Playwright Chromium rendering and synthetic login**, but simulates a user stylesheet by doubling each text-bearing element's **original computed pixel font size** in a synchronous browser evaluation; it then restores prior inline values and tests form navigation normally. It measures each sampled element's computed font ratio, internal scroll dimensions, and direct text-node `Range.getClientRects` bounds, and refuses global document horizontal scroll. This is a practical automated approximation of the W3C [SC 1.4.4 Resize Text](https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html) scenario, not a native Firefox text-only browser zoom command.

## Remaining limitations

It does **not** prove full WCAG 2.2 AA or actual native Firefox text-only zoom, Firefox/WebKit parity, every dynamic account state, all icon/button and text-node overlap, 200% resizing of text generated in pseudo-elements, manual screen-reader/contrast/touch inspection, real provider operation or deployed auth. The source scan is Git-tracked recognized text, not all history/binary files. `ORB-009` and `ORB-018` stay `testing/browser_tested` pending manual and cross-browser validation. Verify final docs-head CI and postmerge `main` CI separately.
