# Next action

1. **ORB-004 / ORB-016:** Wire a real PostgreSQL data adapter and Redis-backed worker into a **single, isolated API job vertical slice**, without breaking the SQLite development path. The hosted job-lease contract is now test-proven, but existing API endpoints and worker do not use it.
2. Model **transactional outbox, idempotent enqueue and delivery reconciliation** between authoritative PostgreSQL job rows and Redis streams. Redis consumer redelivery alone is not exactly-once execution or DB↔queue consistency. Recheck provider action policies/fencing before external side effects.
3. Add synthetic GitHub-hosted **application** integration tests for an API refresh request through a Postgres-backed job state and Redis worker, process crash/restart, retry fencing, tenant isolation, rollback/migrations, and real Docker Compose named-volume persistence. Current CI only proves independent SQL/Redis CLI invocations and forced lease expiry.
4. **ORB-018 / ORB-009:** Extend hosted browser accessibility tests for keyboard/focus, contrast, mobile, error, stale and permission states.
5. **ORB-010 / ORB-017:** Full production deployment, schema parity with SQLite v7, release SBOM validation, secret/identity controls and disaster recovery remain distinct gates.
6. **ORB-011 / ORB-013 / ORB-014:** Physical authenticator, verified live notifications and production MFA/restore exercises remain open.
7. **ORB-006 / ORB-019:** Do not access live cPanel without authorized disposable credentials and scope.

## Verified checkpoints

- PR [#7](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/7): ORB-012 Chromium virtual-passkey browser E2E merged as `1f8dec9446089dd38a4eb723e278467d7106484d`.
- PR [#8](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/8): ORB-015 npm audit, lockfile SBOM and recovery-code regression merged as `2944dda70a332ece1a43225a904c58a5012fb421`.
- PR [#9](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/9): hosted Postgres/Redis service parity merged as `4b9622fb3db0e81d5caf67d54210db3624e951fa`; [service evidence](TEST_EVIDENCE/2026-11-22-orb-016-services-ci.md).
- PR [#10](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/10): staged PostgreSQL lease/Redis Streams recovery contract tested at SHA `33eaebafb6aee7eac133700f75e764a771089c18`; [Actions run 44997036564](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44997036564) and [evidence](TEST_EVIDENCE/2026-11-22-orb-004-lease-contract-ci.md). Final merge/head status must be checked separately.

## Evidence contract

Record exact tested SHA, hosted workflow/run URLs, command coverage, runtime, artifact, and specific limitation in `docs/TEST_EVIDENCE/`. Synthetic service checks do not establish a full production integration, physical authenticator or live provider authorization.
