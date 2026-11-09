# Known issues and blockers

| ID | Severity | State | Detail | Workaround / next step |
|---|---|---|---|---|
| KI-001 | High | Partial | Local bootstrap/login, hashed sessions, tenant-scoped inventory/jobs and worker role rechecks are implemented; a TOTP compatibility fallback and one-time recovery codes are mock-tested; WebAuthn/passkeys, verified notifications, recovery rebinding, production-grade policy, external secrets vault, distributed throttling and hardened deployment are absent | Keep API loopback-only and use synthetic data; finish ORB-005 before adding provider credentials |
| KI-002 | Medium | Open | Docker, PostgreSQL and Redis are absent from current environment | Continue the local SQLite slice; mark production queue/database integration blocked |
| KI-003 | High | Open | No authorized cPanel/WHM sandbox account or token supplied | Mock fixtures only; live integration remains `blocked_external` |
| KI-004 | Medium | Open | No supported VPS minimums or performance baselines have been measured | Establish a reproducible benchmark after the production stack is running |
| KI-005 | Low | Open | Current branch protection was observed disabled on main | Use a feature branch and avoid direct main writes; owner can enable protections later |
