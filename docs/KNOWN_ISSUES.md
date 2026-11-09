# Known issues and blockers

| ID | Severity | State | Detail | Workaround / next step |
|---|---|---|---|---|
| KI-001 | High | Open | No authentication, tenant enforcement or production secrets vault exists at bootstrap | Use only synthetic local data until ORB-005 is implemented and tested |
| KI-002 | Medium | Open | Docker, PostgreSQL and Redis are absent from current environment | Continue the local SQLite slice; mark production queue/database integration blocked |
| KI-003 | High | Open | No authorized cPanel/WHM sandbox account or token supplied | Mock fixtures only; live integration remains `blocked_external` |
| KI-004 | Medium | Open | No supported VPS minimums or performance baselines have been measured | Establish a reproducible benchmark after the production stack is running |
| KI-005 | Low | Open | Current branch protection was observed disabled on main | Use a feature branch and avoid direct main writes; owner can enable protections later |
