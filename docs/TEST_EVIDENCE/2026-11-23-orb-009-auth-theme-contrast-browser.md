# ORB-009 — Computed light/dark sign-in text contrast browser checkpoint

**Date:** 2026-11-23  
**PR:** [#46](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/46)  
**Functional tested SHA:** `8b1c1ae396adaf1802cf75cb32722775005c82ec`

## Hosted GitHub CI

- [PR CI #45089326030](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45089326030) and [branch CI #45089320285](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45089320285) **success** at the identical SHA; **113 Node tests passed / 0 failed**. Secret/license check scanned **244 recognized Git-tracked source files** with no high-confidence pattern findings or unreviewed license declarations; official CycloneDX 1.5 schema gate, npm audit (0 reported at run time), lint, build, smoke and doctor also passed.
- [Hosted Chromium #45089326005](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45089326005) **success**, Node `24.22.3`, Chromium `159.0.8154.6`; `authThemeSampledTextContrast:"passed"` with the following **measured computed-style contrast ratios**. Existing WebAuthn, synthetic MFA recovery, tenant isolation and responsive/keyboard browser cases also passed.
- [Browser evidence artifact #14780263499](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45089326005/artifacts/14780263499), ZIP SHA-256 `2dc6b913bdd0788fe145f23ac1548a7a919ebd70f4077ab811a61d339807d5f8`.

| Auth surface | Light theme | Dark theme | Normal-text 4.5:1 threshold |
| --- | ---: | ---: | --- |
| Sign-in helper paragraph | 5.81:1 | 10.92:1 | passed |
| Form field label | 6.25:1 | 10.92:1 | passed |
| Footnote | 5.81:1 | 10.92:1 | passed |
| Password input text | 10.14:1 | 14.87:1 | passed |

## Scope of implementation and checks

- Explicit scoped color changes darken previously pale helper/footnote/MFA prose in the light theme and brighten auth labels, help, notes, MFA dialog text and restart controls in the dark theme; surrounding layouts and product branding remain unchanged.
- A new fresh unauthenticated Chromium context per theme samples visible computed text and background colors for the four named auth elements; the test computes WCAG relative luminance and fails under **4.5:1**. Only the rounded ratios are emitted; no credentials or recovery codes are written.
- The original browser attempt at SHA `f42b2f0d` failed **only the new selector**: the bootstrap form has both a password-type setup token and password input, and a strict Playwright locator matched both. It was corrected to target the explicit `autocomplete=new-password` field at `8b1c1ae396adaf1802cf75cb32722775005c82ec`; both CI workflows and Chromium then passed. No accessibility contrast failure was observed.

## Limits and remaining controls

- These are **four sampled sign-in text roles per theme**, not a complete visual/semantic WCAG audit of all product screens, disabled states, modal copy, icon contrast, focus rings or dynamic color overlays. The unverified full color-contrast audit and manual screen-reader testing remain marked `not_tested` in runtime evidence.
- Does not test actual browser page zoom 200%/400%, device touch targets, physical passkey behavior, keyboard consistency on every screen, production identity, independent KMS, or external hosting APIs.
- ORB-009 stays `testing/browser_tested`. Final documentation-head and postmerge `main` CI must be checked separately.
