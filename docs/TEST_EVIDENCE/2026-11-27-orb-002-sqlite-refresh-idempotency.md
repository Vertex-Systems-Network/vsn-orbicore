# ORB-002/004/005 — SQLite inventory refresh idempotency

Date: 2026-11-27 UTC. Base: main b33dcd718f4f0528bf5bd50a79ce7924930ab206 (PR #84 merged). Hosted verification pending.

The local inventory refresh endpoint previously looked up an organization-scoped key before the writer transaction and returned an existing job without validating the account, operation or requester. The HTTP boundary also silently truncated keys to 120 characters.

- Look up and compare the complete SQLite job identity inside the existing BEGIN IMMEDIATE transaction; queue creation and audit remain atomic.
- Return redacted 409 idempotency_conflict when a key is reused for a different account, operation or requester. Successful retries explicitly retain live:false.
- Reject empty, overlong, or ambiguous comma-bearing key headers instead of truncating; this HTTP validation also applies to the injected test-only PostgreSQL job repository path.
- Three real local HTTP regression tests check account conflicts, invalid headers, and a second authorized same-tenant requester, with exact row/audit counts. Existing normal retry tests remain in place.

Compatibility: clients relying on truncation or cross-actor retries now receive a denial. No schema change, provider calls, distributed idempotency or PostgreSQL authority promotion. ORB-002 remains testing/mock_tested, ORB-004 testing/integration_tested, ORB-005 in_progress/integration_tested. 
