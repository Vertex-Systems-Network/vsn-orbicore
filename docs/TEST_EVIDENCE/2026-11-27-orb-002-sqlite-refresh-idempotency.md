# ORB-002/004/005 — SQLite inventory refresh idempotency

Date: 2026-11-27 UTC. Base: main b33dcd718f4f0528bf5bd50a79ce7924930ab206 (PR #84 merged). Hosted verification pending.

The local inventory refresh endpoint previously looked up an organization-scoped key before the writer transaction and returned an existing job without validating the account, operation or requester. The HTTP boundary also silently truncated keys to 120 characters.

- Look up and compare the complete SQLite job identity inside the existing BEGIN IMMEDIATE transaction; queue creation and audit remain atomic.
- Return redacted 409 idempotency_conflict when a key is reused for a different account, operation or requester. Successful retries explicitly retain live:false.
- Reject empty, overlong, or ambiguous comma-bearing key headers instead of truncating; this HTTP validation also applies to the injected test-only PostgreSQL job repository path.
- Three real local HTTP regression tests check account conflicts, invalid headers, and a second authorized same-tenant requester, with exact row/audit counts. Existing normal retry tests remain in place.

Compatibility: clients relying on truncation or cross-actor retries now receive a denial. No schema change, provider calls, distributed idempotency or PostgreSQL authority promotion. ORB-002 remains testing/mock_tested, ORB-004 testing/integration_tested, ORB-005 in_progress/integration_tested. 

## Hosted PR #85 functional-head evidence

GitHub Actions on `9a27b24d6118d21a53c67618c951d355b804a88b` (2026-11-27 UTC):

- [Standard CI #46000232751](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46000232751) and [push CI #46000206640](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46000206640): standard CI passed; push job log records 206/206 Node tests, zero failures/skips/cancellations, including all three new refresh idempotency tests. Lint, plan alignment, security, SBOM/CycloneDX, audit, build, smoke and doctor succeeded.
- [Service integration #46000232740](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46000232740): all 28 disposable PostgreSQL/Redis service jobs succeeded.
- [Browser #46000232637](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46000232637): Chromium, Firefox and WebKit 3/3 succeeded.
- [Trusted ledger #46000232522](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/46000232522): succeeded; 20 tasks, 6 verified, 9 testing, 3 in progress, 2 blocked.

Final evidence-only head verification and merge pending. No live provider or distributed production idempotency proof; lifecycle and verification levels unchanged.
