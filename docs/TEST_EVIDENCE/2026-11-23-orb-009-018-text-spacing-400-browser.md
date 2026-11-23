# ORB-009 / ORB-018 — W3C text-spacing override in real Chromium 400% page zoom

**Date:** 2026-11-23  
**PR:** [#49](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/49)  
**Functional browser-test SHA:** `bcca20958b0612f0f22d9111f8b694ce93090b3e`  
**Test script:** `scripts/browser-native-zoom.mjs`  
**Scope:** synthetic in-memory SQLite workspace with Chrome's actual 400% `tabs.setZoom` and 320 CSS pixel measured layout viewport.

## Host CI evidence

- [PR CI #45094046523](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45094046523), [branch CI #45094039359](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45094039359), and [Chromium E2E #45094046409](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45094046409): **completed success at functional SHA** `bcca20958b0612f0f22d9111f8b694ce93090b3e`. The previous [PR CI #45093865814](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45093865814) and [Chromium E2E #45093865812](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45093865812) also passed before the additional paragraph-spacing measurement field.
- 113 existing Node tests passed (0 failures) on the first functional SHA; build, code checks, dependency-license and source-secret gates, npm audit and npm-lockfile-only CycloneDX schema CI passed. This is **not** a deployed runtime security/complete-SBOM claim.
- [Latest browser artifact #14781979572](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45094046409/artifacts/14781979572), SHA-256 `f468e0d85988b1f3c7f1cb7d2f44cd123e48f7641b0a65eb0721469d6eb6025e`, includes measured `native-zoom-runtime.json` and the preexisting synthetic-dashboard screenshot. No password, token, passkey secret, MFA code, or recovery text was captured.

## Technique and observed results

Per W3C [WCAG 2.2 SC 1.4.12, Text Spacing](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html), inject an **ephemeral CI-only** CSS override on the existing page:

- `line-height:1.5` (at least 1.5 times font size)
- `letter-spacing:0.12em` and `word-spacing:0.16em`
- `body p {margin-bottom:2em}` for two-font-size paragraph spacing

The test checks computed line/letter/word spacing **for each sample**, no individual sample `scrollWidth > clientWidth + 2` or `scrollHeight > clientHeight + 2` clipping, and no page-wide horizontal overflow. It removes the CSS after each sample; it does not modify the shipped design. The later checkpoint also records the actual paragraph bottom margin **22px on the 11px bootstrap paragraph** (2em); a separate automated assertion on that margin was **not** added.

| Sampled UI at *real* 400% zoom | Measured targets | Clipped in computed sample | Document width / CSS viewport |
| --- | --- | --- | --- |
| Bootstrap sign-up | Heading, description paragraph, setup label, footnote: **4 elements** | 0 | 320 / 320 px |
| Overview | Heading and subtitle: **2 elements** | 0 | 320 / 320 px |
| Websites | Heading and subtitle: **2 elements** | 0 | 320 / 320 px |
| Hosting accounts | Heading and subtitle: **2 elements** | 0 | 320 / 320 px |
| Jobs & activity | Heading and subtitle: **2 elements** | 0 | 320 / 320 px |

At 400% native Chrome page zoom, earlier account access, modal focus trap/scroll, WebAuthn, MFA, reduced-motion, stale tenant and keyboard regressions remain passing in the **same** hosted browser workflow. Results were produced by a real browser, not by simply changing the 1280px browser's viewport to 320px.

## Boundaries and next work

**This is 12-element automated sample evidence only**, **not complete WCAG 2.2 AA / SC 1.4.12 conformance**. `scrollWidth/scrollHeight` is a narrow mechanical clipping check; it does not prove all text stays readable, visible to a screen reader, unobscured or free of overlapping independent elements. More screens, data tables, toast/errors, dynamic text, security/passkey modal text, text-only 200% resizing, Firefox/WebKit, manual visual review, touch targets and actual assistive technology remain open. No production code or external provider/identity/cluster configuration changed. ORB-009 and ORB-018 remain `testing/browser_tested`.

## Standards

- [W3C WCAG 2.2 SC 1.4.12 Text Spacing](https://www.w3.org/TR/WCAG22/#text-spacing)
- [W3C Understanding SC 1.4.12](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html)
- [Prior real Chromium zoom and scrollable sidebar CI evidence](2026-11-23-orb-009-018-native-chromium-zoom.md)
