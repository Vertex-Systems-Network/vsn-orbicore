# Next action

1. Implement ORB-005: real local bootstrap/login/session handling and tenant-scoped authorization; keep the provider fixture synthetic.
2. Add negative tests for unauthenticated access, tenant A vs tenant B reads/jobs, session expiry, and worker policy rechecks.
3. Start ORB-009 browser accessibility and interaction verification when a browser can access the local runtime.
4. Keep ORB-004 blocked until PostgreSQL/Redis are available and ORB-006 blocked until an owner-authorized disposable cPanel account/token is available.

**Current verified result:** Phase 0 exit criteria met; ORB-001/003/008 verified; ORB-002 mock-tested. Browser QA is blocked by environment. No live provider connections or production readiness are claimed.
