# Next action

1. **ORB-004 / ORB-016:** Replace the test-only hybrid PostgreSQL gateway with an **end-to-end production-shaped job flow**. Pinned runtime `pg@8.23.1` and `redis@6.3.1` are now installed and CI-verified. Implement the complete PostgreSQL identity/account/tenant schema, or an explicit migration/sync contract; do not silently treat the local SQLite identities as production-authoritative.
2. Implement **transactional PostgreSQL job + outbox publication**, Redis Streams consumer with ACK/reclaim and idempotent execution, and a dedicated worker with fresh tenant/policy checks. Redis redelivery tests alone do not establish exactly-once side effects.
3. Run GitHub-hosted real application tests with actual worker process shutdown/restart, persistent job and outbox recovery, cross-tenant denial, safe retries, and Docker Compose named-volume persistence after service container replacement. The existing authenticated HTTP test uses a manually injected PostgreSQL store and **does not start a PG worker**.
4. Continue ORB-018/009 accessible browser testing of keyboard/focus, contrast, responsiveness and permission/error states; keep physical authenticator and live contact delivery as separate gates.
5. ORB-010/017 production security/installer: complete release SBOM validation, secrets/RLS policy, PostgreSQL upgrade/rollback, restore and resource benchmarks.
6. ORB-006/019 live cPanel/WHM testing requires authorized disposable least-privilege credentials and explicit scope.

## Latest merged and verified checkpoints

- ORB-012 PR [#7](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/7) virtual passkey E2E merged as `1f8dec9446089dd38a4eb723e278467d7106484d`.
- ORB-015 PR [#8](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/8) security audit/SBOM and recovery fix merged as `2944dda70a332ece1a43225a904c58a5012fb421`.
- ORB-016 PR [#9](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/9) hosted PostgreSQL/Redis service tests merged as `4b9622fb3db0e81d5caf67d54210db3624e951fa`.
- ORB-004 PR [#10](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/10) lease/stream contract merged as `12eb732320b3d6e932a7012c774f1e2df32b6557`.
- ORB-004 PR [#11](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/11) injected PostgreSQL job repository merged as `8a8762cecf78c1350d4f9130d808502b291593a5`.
- ORB-004 PR [#12](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/12) authenticated PostgreSQL HTTP slice merged into `main` as `c5267790a71cc8978b2c6101aeeafc64c21775b3`. [Evidence](TEST_EVIDENCE/2026-11-22-orb-004-postgres-http-ci.md).
- ORB-004 PR [#13](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/13) pinned PG/Redis runtime packages at SHA `3b7f26ee97e992427d5f0bad4cabc4c1a4f68e53`; [hosted service run #44998860302](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44998860302) and [49-test standard CI #44998860295](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44998860295) passed. [Evidence](TEST_EVIDENCE/2026-11-22-orb-004-runtime-packages.md). Verify final PR head and merge independently.

## Evidence contract

For every completion claim preserve workflow/run URL, exact tested SHA, job/version/commands, runtime result, artifact, and explicit untested limits in `docs/TEST_EVIDENCE/`. Do not infer live provider, production readiness, persistent worker or full accessibility from mock/virtual-service results.
