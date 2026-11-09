# Next action

1. Implement ORB-011 MFA enrollment, login verification, single-use recovery codes, session revocation, and notification/audit behavior before accepting any provider credentials.
2. Implement ORB-010 threat-model tests and reproducible dependency/SBOM/license scanning after the MFA design and code are reviewed.
3. Add browser-level verification for bootstrap/sign-in/dashboard flow when a browser can reach the local runtime; the API+Vite HTTP smoke is not a visual/UI pass.
4. Keep ORB-004 blocked until PostgreSQL/Redis are available; keep ORB-006 blocked until an owner-authorized disposable cPanel account/token is available.

**Current verified result:** Phase 0 exit criteria met. ORB-001/003/008 are verified; ORB-002 and ORB-005 are mock-tested. Local bootstrap/login, session controls, tenant-scoped reads/jobs/audit, worker policy rechecks, 12 tests, bank validation, and the API+Vite smoke pass. MFA/recovery, rendered browser UI, live providers, PostgreSQL/Redis, and production readiness remain unverified.
