# Next action

1. **ORB-004 / ORB-016:** Implement a real versioned PostgreSQL data adapter and Redis-backed durable job worker behind existing application ports. Keep current SQLite synthetic development mode and existing 45 tests working. Provide a migration plan for SQLite v7 entities; current `db/postgres-schema.sql` is only a **partial** target schema.
2. Write GitHub-hosted service-backed integration tests that exercise actual ORBICORE persistence/jobs, process restart, idempotent retry, rollback and recovery; verify Compose named-volume persistence after container recreation in a disposable environment. Do **not** treat schema/Redis CLI tests as production app integration.
3. **ORB-018 / ORB-009:** Expand browser accessibility QA to keyboard/focus, contrast, desktop/mobile, loading, stale, empty, error and permission states.
4. **ORB-010:** Review release SBOM official-schema validation, full deployed-system inventory and production identity/secret controls.
5. **ORB-011 / ORB-013 / ORB-014 / ORB-017:** Physical authenticator, verified contact live notification, key restore and production installer/upgrade gates stay open.
6. **ORB-006 / ORB-019:** Live cPanel requires owner-authorized disposable account/token. Maintain synthetic-only provider boundaries.

## Verified checkpoints

- ORB-012 Chromium virtual-authenticator E2E merged in PR #7, `main` SHA `1f8dec9446089dd38a4eb723e278467d7106484d` ([evidence](TEST_EVIDENCE/2026-11-22-orb-012-browser-e2e.md)).
- ORB-015 npm audit / lockfile SBOM CI and multi-hyphen recovery-code fix merged in PR #8, `main` SHA `2944dda70a332ece1a43225a904c58a5012fb421` ([evidence](TEST_EVIDENCE/2026-11-22-orb-015-audit-sbom-ci.md)).
- **ORB-016 partial service evidence:** PR [#9](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/9), tested SHA `2d46a0bac12f7631476fb72ad69529465a181e2f`, [GitHub Actions 44996391832](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44996391832) passed hosted PostgreSQL 16 + Redis 7 tests; [artifact](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44996391832/artifacts/14743823737). Task stays `testing` / `integration_tested` for **service level only**, pending production app adapter, restart and Compose tests. Confirm final PR/merge result independently.

## Evidence contract

Store exact tested SHA, Actions run, commands/jobs, runtime, exit result, artifacts and limitations in `docs/TEST_EVIDENCE/`; never infer production, live provider, physical authenticator or full accessibility success from synthetic service tests.
