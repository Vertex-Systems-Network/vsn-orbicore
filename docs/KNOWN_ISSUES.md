# Known issues and blockers

| ID | Severity | State | Detail | Next action |
|---|---|---|---|---|
| KI-001 | High | Partial | Bootstrap/login, tenant scopes, TOTP/recovery, WebAuthn enrollment/login, passkey inventory/revocation and password-reauthenticated rebinding are implemented. Browser E2E, verified contact delivery, production key/restore lifecycle, SSO, vault, distributed throttling, hardening and tamper-evident audit are unverified. | Loopback/synthetic-only; execute ORB-012–015 before provider credentials. |
| KI-002 | Medium | Environment blocked | Docker/PostgreSQL/Redis absent in earlier environment; hosted service-container feasibility unknown. | Attempt ORB-016 in GitHub Actions. |
| KI-003 | High | External blocked | No authorized cPanel/WHM sandbox account or scoped token. | Keep fixture-only until owner supplies disposable least-privilege access. |
| KI-004 | Medium | Open | VPS minimums and performance baselines not measured. | Benchmark after production-shaped stack is available. |
| KI-005 | Low | Open | Main branch-protection state from earlier inspection may be stale. | Continue PR flow; recheck governance state when scheduled. |
| KI-006 | High | Unverified | CI lacks browser E2E, threat-model tests, secret/dependency scans, SBOM/license gates and service-backed DB/queue tests. | Track ORB-012, ORB-015, ORB-016 and ORB-018. |
