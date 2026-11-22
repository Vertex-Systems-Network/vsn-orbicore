# Test evidence index

Store task ID, command/workflow, runtime, date, exit code, commit, fixture/environment, artifacts and limitations. Redact secrets, personal data, tokenized URLs and database dumps. Separate unit/mock, browser, integration and live-provider evidence.

- [2026-11-09 local proof of concept](2026-11-09-local-poc.md): local/mock evidence only.
- [2026-11-10 GitHub CI checkpoints](2026-11-10-github-ci.md): merged PR #2/#3 implementation checks and PR #4 docs check; no browser or live-provider claim.
- [2026-11-22 ORB-015 license-gate CI](2026-11-22-orb-015-license-ci.md): reviewed CC-BY-4.0 transitive data exception; subsequent PR #6 merged.
- [2026-11-22 ORB-012 Chromium virtual-passkey E2E](2026-11-22-orb-012-browser-e2e.md): successful hosted browser run, synthetic screenshot/runtime artifact and explicit limits; no physical authenticator or provider claims.
- [2026-11-22 ORB-015 npm audit and CycloneDX artifact CI](2026-11-22-orb-015-audit-sbom-ci.md): 44 tests, zero npm audit findings at test time, reproducible 169-component lockfile BOM and uploaded artifact; no deployed-system or independent schema validation claim.
- [2026-11-22 ORB-016 PostgreSQL/Redis hosted service parity](2026-11-22-orb-016-services-ci.md): successful disposable DB schema/constraint and Redis I/O checks; no application adapter or worker restart claim.
- [2026-11-22 ORB-004 leased PostgreSQL job + Redis Streams contract](2026-11-22-orb-004-lease-contract-ci.md): hosted lease/fencing/tenant/concurrency and stream redelivery assertions, with no production API adapter or true process/container restart claim.
- [2026-11-22 ORB-004 Node PostgreSQL job repository integration](2026-11-22-orb-004-node-postgres-repository.md): 47-test CI and real PostgreSQL query/tenant/idempotency/reconnect proof; no production API/Redis worker wiring.
- [2026-11-22 ORB-004 authenticated PostgreSQL job HTTP E2E](2026-11-22-orb-004-postgres-http-ci.md): hosted 49-test and real PostgreSQL-backed HTTP job checks with tenant/RBAC; no runtime PG/Redis worker or atomic cross-store audit.
- [2026-11-22 ORB-004 pinned PostgreSQL/Redis runtime clients](2026-11-22-orb-004-runtime-packages.md): official npm lockfile generation, 49 passing tests, hosted drivers, Redis/PG I/O and 189-component SBOM; no production worker yet.
- [2026-11-22 ORB-004 atomic PostgreSQL outbox and Redis synthetic worker](2026-11-22-orb-004-outbox-worker.md): verified atomic enqueue, SIGKILL/reclaim, actor policy revocation, replay reconciliation and opt-in standalone worker; no complete PG identity migration or Compose persistence.
- [2026-11-22 ORB-016 Docker Compose named-volume + Redis AOF recovery](2026-11-22-orb-016-compose-recreation.md): real disposable container removal/recreation and persisted PG/Redis state, naturally expired lease and standalone worker recovery; production HA not tested.
- [2026-11-22 ORB-005 PostgreSQL core identity and tenant RLS](2026-11-22-orb-005-postgres-identity-core.md): 55-test CI, hosted guarded synthetic SQLite snapshot, exact audit chain, MFA/disabled/expiry session denials and NOLOGIN read role restrictions; not full v7/cutover.
- [2026-11-22 ORB-005 PostgreSQL synthetic MFA/passkey/recovery state](2026-11-22-orb-005-pg-auth-state.md): hosted 57-test checkpoint, atomically copied fake auth-state tables with tenant FKs and safe-column RLS; not cryptographic migration, full SQLite v7 or live HTTP cutover.
