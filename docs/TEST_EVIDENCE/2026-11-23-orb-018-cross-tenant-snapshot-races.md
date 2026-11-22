# ORB-018 — Cross-tenant stale response and account-removal browser checkpoint

**Date:** 2026-11-23  
**PR:** [#41](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/41)  
**Functional SHA:** `573dda09e716ef6d5ab290df262bf7bb24879d64`

## Hosted results

- [PR CI #45081987366](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45081987366) **success**; [branch CI #45081970426](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45081970426) **success** at the identical SHA.
- Hosted Node 24 standard checks: **109 passed / 0 failed**, lint, scoped secret/license gate, official CycloneDX 1.5 schema validation of **189 npm lockfile components** and three negative schema fixtures, npm audit reporting **0 vulnerabilities at run time**, build, smoke, doctor.
- [Hosted Chromium virtual-authenticator browser #45081987542](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45081987542) **success** at the identical SHA. Runtime log: Node `24.22.3`, Chromium `159.0.8154.6`; `missingAccountSelectionReconciled:passed`, `distinctTenantSessionScope:passed`, `delayedOldTenantResponseDiscarded:passed`, existing `accountSiteFailureAndRetry:passed`, `crossSessionSelectionReset:passed` plus previously tested keyboard, reduced-motion, narrow viewport and virtual passkey checks.
- [Browser evidence artifact #14778235264](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45081987542/artifacts/14778235264); ZIP digest `sha256:a85e5eb7ee4c438f3e9cdcababec98eff72ec20b9a9fc27c8acb1c67afa68786`.

## Implementation and isolated tests

1. `loadOverview` assigns a monotonically increasing generation ID before the parallel overview/sites GET requests. Only the newest still-current request may publish site/account results, loading state or error. Older in-flight responses become inert.
2. Logout invalidates all existing overview requests **before** logout HTTP completion. A failed logout is displayed as an error and does not falsely advance to the login screen. A newly authenticated actor explicitly starts with empty tenant-scoped overview/site/errors.
3. Chromium selects a nondefault account, then mocks the next overview read omitting that account: selection reconciles to the first valid account. The **removal is a mocked API snapshot**, not a destructive DB/provider deletion.
4. Chromium creates a **second synthetic organization/user/account/site**, with a distinct legitimate login cookie. While signed into tenant A, the browser holds one response from `/api/overview`; it logs out of A and signs into tenant B, where only B's account and site appear. A direct B-session read of an A-account site and B-session POST to refresh an A-account both return **404**, per existing server auth policy.
5. The browser releases the already-answered-but-delayed tenant-A GET response, observes that B's account/site remain unchanged, signs out and returns to A, and confirms B's account remains absent.

## Boundaries

- In-memory SQLite, local HTTP loopback, synthetic accounts and test credentials only. No real hosting provider, production account, server deployment, external KMS, privileged infrastructure or PostgreSQL identity authority.
- The previous request response is deliberately delayed by test routing; this is a browser concurrency proof, not a multi-node session invalidation/distributed cache or a full security penetration assessment.
- Actual 200%/400% browser zoom, manual WCAG screen reader/contrast/touch-target and full field-error audits, physical authenticator and production tenant/security reviews remain **unverified**. ORB-018 stays `testing/browser_tested`.
- Verify the final documentation-head and postmerge `main` CI separately before claiming whole-PR completion.
