# Next action

1. **ORB-004 / ORB-016:** The **synthetic PostgreSQL transaction/outbox and Redis Streams worker** now pass service-backed CI, including an opt-in standalone worker executable and real Node `SIGKILL` after a claim. **Next: migrate identity, account, tenant and audit authority from SQLite v7 into a complete versioned PostgreSQL schema** with explicit backfill/cutover/rollback and consistency gates; stop relying on manually mirrored CI user/account rows.
2. Add PostgreSQL database roles and tenant-aware RLS, stable actor authorization, tamper-evident audit/outbox writes in one PostgreSQL transaction, configuration and secrets hardening. Avoid enabling live provider actions until policy and authorization evidence exist.
3. Run disposable **actual PostgreSQL/Redis container stop/recreate** and `docker compose` named-volume persistence drills (including backup/restore), worker restart after natural lease expiry without manual timestamp advancement, duplicate/outbox crash windows and Redis AOF recovery. The current process kill test forcibly advances the test lease clock; it is **not** a full service disaster-recovery demonstration.
4. Add worker supervision/operational readiness, real retry/backoff and poison-message inspection before production. The explicit standalone runner is **synthetic-only** and does not auto-start via `npm start`.
5. **ORB-018 / ORB-009:** Expand browser accessibility QA for keyboard/focus, contrast, mobile, stale/empty/error and permission states.
6. **ORB-010 / ORB-017:** Release CycloneDX JSON schema validation, deployed-system inventory and installer/upgrade/rollback gates remain.
7. **ORB-006 / ORB-019:** Live cPanel/WHM needs owner-authorized disposable scoped credentials and external operation approvals.

## Verified checkpoint chain

- ORB-012 passkeys PR [#7](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/7); ORB-015 npm audit/SBOM PR [#8](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/8); ORB-016 hosted services PR [#9](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/9) merged.
- ORB-004 PRs [#10](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/10), [#11](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/11), [#12](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/12), [#13](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/13) merged into `main` (last main `d7efb48fef3e16a96ca906c961343bd5485027fe`). Prior evidence indexed in [test evidence](TEST_EVIDENCE/README.md).
- ORB-004 PR [#14](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/14): synthetic job/outbox/Redis worker [service integration #45002004269](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45002004269), [52-test CI #45002004261](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45002004261), [Chromium #45002004230](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45002004230) **passed** on `037e7bd9e00067db6a3f5474099e9598f2472102`. [Detailed limits](TEST_EVIDENCE/2026-11-22-orb-004-outbox-worker.md). Verify final PR head and squash merge separately.

## Evidence contract

Preserve tested SHA, hosted run, complete commands, versions, artifacts and remaining limits. Do not infer production, exactly-once provider effects, full database migration, provider authorization or physical authenticator coverage from fixture-based tests.
