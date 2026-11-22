# ORB-018 — Account-bound site display, 503 recovery and session reset browser proof

**Date:** 2026-11-23  
**PR:** [#40](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/40)  
**Functional tested SHA:** `deb5834818b2e0159e1098dfd7d54db490371e0c`

## Hosted checks

- [PR CI #45081272511](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45081272511), [branch CI #45081254705](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45081254705) and [Chromium E2E #45081272410](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45081272410): **success** at the same functional SHA.
- Hosted Chromium on Node `24.22.3` and Chromium `159.0.8154.6` used the real local app, synthetic SQLite data, a virtual CTAP2/WebAuthn authenticator, plus a second local fixture account created through the existing demo-seed API. No real provider access or secrets.
- Browser output: `browserVerified:true`, `accountSiteFailureAndRetry:"passed"`, `crossSessionSelectionReset:"passed"`, plus prior 320/390/640/768px navigation, reduced-motion, passkey anti-replay, MFA keyboard focus and viewer role controls.
- [Synthetic browser artifact #14777034211](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45081272410/artifacts/14777034211), ZIP digest `sha256:064054cfeeda317ac913cd000d78b772a575f6cc4bfa484e8d3e49321bb03626`. Screenshots and metadata contain no displayed MFA secret or recovery codes.

## What changed and was tested

1. **Account-bound rows:** fetched site rows carry the selected account ID that generated them. If a different account becomes selected before the effect clears old rows, the dashboard render filters old rows and counts rather than momentarily showing them under another account.
2. **Account-bound errors:** a site request failure is scoped to that account, so a stale failure cannot appear under a different account. A 503 is not displayed as an empty inventory.
3. **Browser failure/retry:** select account A, switch to distinct synthetic account B with only B's site endpoint returning HTTP 503. Chromium observes an error with zero prior-account site rows and zero prior-account site count, then removes the route fault, clicks `Retry websites` and confirms recovery.
4. **Session reset:** sign out from a non-default account selection, sign back into the same synthetic owner account with a password, and verify that the first current account is selected. This checks UI session-state reset, not full cross-tenant server authorization.

## Remaining gates

- No actual two-tenant browser session switching, account deletion/removal reconciliation browser test, manual screen-reader/contrast/touch-target review, actual 200%/400% browser zoom, device matrix or full WCAG conformance evidence.
- The synthetic browser test is not a live provider, off-host recovery, production PostgreSQL auth or full authorization proof. ORB-018 remains `testing/browser_tested`.
- Review final docs-head CI/browser and postmerge `main` CI independently; don't transfer the functional-head result to an untested docs commit.
