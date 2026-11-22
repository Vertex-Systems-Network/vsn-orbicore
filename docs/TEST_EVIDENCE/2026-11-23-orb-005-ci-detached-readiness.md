# ORB-005 — CI-only detached witness checkpoint and fail-closed synthetic readiness

**Date:** 2026-11-23  
**Pull request:** [#29](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/29)  
**Functionally tested SHA:** `73a06983b84256d119a8edaedf3b2a9da76668ab`

## GitHub-hosted verification

- [Service Integration #45064183849](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45064183849) — **success, all 15/15 jobs** at tested functional SHA. The new job uses PostgreSQL 16, an actual nonowner witness and reconciliation role, existing private shadow schemas 010–013, file-backed SQLite, and a detached CI file.
- [PR standard CI #45064183858](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45064183858) and [branch standard CI #45064061226](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45064061226) — **success** at tested functional SHA. CI runs locked install, unit tests, lint, security/SBOM, npm audit, build, smoke and doctor.
- [Chromium virtual-authenticator/browser #45064183842](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45064183842) — browser result requires separate final confirmation; this is virtual WebAuthn, not production MFA or physical authenticator.
- Synthetic JSON proof artifact [#14770129613](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45064183849/artifacts/14770129613) named `orb-005-ci-detached-readiness`; GitHub-reported `sha256:2aaa5f47a794db8ba7ce24254d7f5b600fb743674ec1e94ddc400ee465d68fc5`. Contains only boolean/check names and no passwords, private HMAC keys or verifier outputs.
- Documentation commit follows the tested functional SHA. Confirm **final docs-head** and **postmerge main** CI separately before claiming end-to-end completion.

## Tested CI-only invariants

1. `ci-detached-witness-checkpoint.mjs` canonicalizes, validates, de-duplicates and sorts actual PostgreSQL witness rows, produces a compact SHA-256 manifest, and HMAC-signs a sequence, count, digest and key ID using a separately generated in-memory 32-byte auditor key. A **different writable file under the same hosted CI runner** stores the compact checkpoint, separate from the file-backed source SQLite and PostgreSQL. No raw email, password, account verifier, session, or key material is in the detached file.
2. The auditor must supply an exact independently pinned checkpoint MAC and a monotonic minimum sequence. The tested fixture rejects a corrupt/missing file, altered HMAC/sequence, old signed checkpoint, wrong signing key, truncated witness snapshot, and a manifest for a different witness set. Key rotation retaining the previous key was tested.
3. `ci-shadow-readiness-probe.mjs` combines HMAC-authenticated checkpoint, source event/witness completeness and actor-bound source MACs, a zero-pending SQLite source journal, per-user source credential epochs equaling the *reconciled* PostgreSQL fence, no unexpected PG fence, and denial of stale or disabled/MFA-active shadow drafts. Verified PostgreSQL source witness deletion, deleted SQLite source event, pending event, absent PG epoch fence, stale shadow-state tamper and source epoch rollback each make `fixtureConsistent:false`.
4. After fresh signed synthetic password reset and owner-initiated disable events, PostgreSQL witness capture and epoch reconciliation, the fixture returns `fixtureConsistent:true` and **always `productionLoginAuthorized:false`**. It remains false for production authority even after a disk-backed SQLite close/reopen and a valid checkpoint rotation. No production route imports this code and no PostgreSQL session is issued.
5. The test uses a real disposable PostgreSQL 16 service with restricted synthetic roles and current schema; it does not make shadow verifiers authoritative, perform user migration, interact with external providers, or enable persistent keys.

## Critical limitations

- **Not real WORM/object-lock/independent custody.** The detached file and pinned digest are test-controlled, writable artifacts in the same GitHub runner. They prove detection only **after a checkpoint is trusted and preserved independently**; if the key and trusted pin are compromised, snapshots can be replaced. Power loss, filesystem immutability, signed off-host retention, auditor separation, operational recovery, and external vault/HSM/KMS custody are not tested.
- **Not source+PG atomicity.** The snapshot is captured after a PostgreSQL witness and source transactions have committed independently. Deletion/suppression of an unwitnessed source event plus a coordinated source epoch rewrite before checkpointing is not prevented. The inspector has no atomic cross-database snapshot and no production-grade user/mutation/MFA actor authorization.
- **Not a production promotion gate.** The result is *synthetic consistency only*: production LoginAuthorized is structurally false, and default HTTP remains SQLite. Full SQLite v7 jobs/secrets/audit, verified production MFA/passkey key custody, session/cookie revocation, distributed throttling and privacy, off-host backup/restore, authorized rollout/cutover with rollback and human approval remain blocked.
- `ORB-005` remains `in_progress` / `integration_tested`. Next: independently administered, WORM/object-lock audit evidence with actual IAM/retention proof, multiple-authority key custody, independently validated off-host restoration, production-shaped MFA/actor authorization and cutover-veto behavior. No live hosting credentials were touched.
