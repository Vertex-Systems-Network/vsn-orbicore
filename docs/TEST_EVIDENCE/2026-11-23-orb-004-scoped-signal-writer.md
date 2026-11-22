# ORB-004 — Tenant-bound non-owner PostgreSQL signal audit gateway

**Date:** 2026-11-23  
**Pull request:** [#35](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/35)  
**Functional tested SHA:** `797eb708b807c9c5a1e7c2d8d52497f7a3db7b22`

## Hosted evidence

- [Service Integration #45071162058](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45071162058) — **21/21 jobs successful**. The new real PostgreSQL 16/Redis 7 job `PG16/Redis7 nonowner scoped signal recorder and ACK-failure boundary` passed. Existing twenty PostgreSQL/Redis/Compose, synthetic auth, recovery, key and worker regressions remain green.
- [PR standard CI #45071161798](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45071161798), [branch standard CI #45071093165](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45071093165), [Chromium virtual passkey browser #45071162057](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45071162057) — **success** at functional SHA.
- [Metadata-only evidence artifact #14773591618](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45071162058/artifacts/14773591618), name `orb-004-ci-scoped-signal-writer-proof`, GitHub-reported digest `sha256:732fe248b4acec9ecda253ea566f3a8b31aa2defaa5b8f91427e1e7f0744ca87`. It contains boolean check names; no login password, raw Redis payload, job ID or PostgreSQL verifier is uploaded.
- Research: [PostgreSQL 16 SECURITY DEFINER, role grants and search_path](../RESEARCH/2026-11-23-scoped-signal-authorization.md). Evidence document follows the tested implementation commit; the **final docs-head and postmerge main CI require separate verification**.

## Boundaries verified in actual hosted PG16 + Redis 7

1. Additive, opt-in [migration 015](../../db/migrations/015_postgres_ci_rejection_writer.sql) creates a `NOLOGIN NOINHERIT NOBYPASSRLS` synthetic signal recorder role, a **privately admin-managed** PG login principal-to-tenant mapping table, and two fixed-signature `SECURITY DEFINER` entrypoints for bounded rejection write/read. The function is created and its default PUBLIC EXECUTE revoked **within one transaction**. Its search path is `pg_catalog,pg_temp` with fully qualified schema objects. Re-applying migration succeeds.
2. Hosted test generates two unrelated **ephemeral in-memory passwords** and two **real PG authenticated, non-superuser sessions**, each with distinct `session_user` and tenant mapping. It activates only the NOLOGIN function role using `SET ROLE`. `session_user`, not the mutable `current_user` or an application-supplied tenant setting, selects the allowed tenant in the trusted function. Tests deny direct SELECT/INSERT/UPDATE/DELETE of rejection table, scope-mapping updates, reads of users, and attempts to `SET ROLE` to schema owner.
3. One scoped writer successfully records and increments only its assigned-tenant Redis synthetic signal metadata, while cross-tenant record/inspection, conflicting reason replay, raw/SQL-shaped Redis entry IDs and out-of-range inspection limits are denied. An attempted `SET orbicore.tenant_id` to another organization never grants access.
4. An actual Redis 7 stream feeds the original synthetic consumer with **a separately injected, restricted PostgreSQL connection for the rejection suboperation only**. Forged-tenant, malformed-ID and missing-job events are recorded under the correct scoped login before ACK; the other tenant's inspector sees no rows. Tests then revoke the function EXECUTE privilege while the Redis consumer holds a message: the database write fails, PEL keeps the message unacknowledged, and restoring the grant enables safe reclaim and ACK.
5. The existing synthetic worker's general job claim/outbox/reconciliation pool stays unchanged and **privileged in this fixture**. The new adapter is CI-gated and only substitutes the rejection recording/inspection operations, not the entire worker's PostgreSQL identity. Normal HTTP authentication remains SQLite.

## Explicit unresolved risks

- No production-restricted worker role for job claim, outbox publisher, lease/fencing, policy checks, job completion or Redis operations. There is no authenticated publisher provenance, signed Redis event, explicit resource/fleet supervisor, dedicated operator-approved redrive, immutable off-host audit, KMS key custody or full PostgreSQL application login cutover.
- `SECURITY DEFINER` has **schema-owner rights** and can bypass table RLS. The guard is SQL argument allowlisting plus a privileged login-name/tenant map; compromise of a mapped login permits that tenant's synthetic rejected-signal operations. A production deployment requires audited role/key provisioning, database ownership separation, immutable administration and real application authorization.
- CI-only fixture GUC is not a security principal. It is a second opt-in, not a replacement for credential and role boundaries. No real hosting accounts, providers, user passwords, authenticated sessions or customer data were used.
- ORB-004 remains `testing/integration_tested`. Required production follow-up: **nonowner job/outbox/claim/complete gateway**, authenticated Redis publisher, alerts/DLQ workflows, distributed crash recovery and real identity policy.
