# ORB-005 — CI-only signed synthetic audit metadata transported to a fresh runner

**Date:** 2026-11-23  
**Pull request:** [#30](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/30)  
**Functional tested head:** `b9edaa8d8ca1429b83262a073500578f588e8815`

## Hosted verification

- [Service Integration #45065048221](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45065048221) — **success, all 17/17 jobs** on tested HEAD. Fifteen existing PG16/Redis/Compose service jobs, plus an actual independent runner **A** exporter and dependent runner **B** verifier/metadata restorer.
- [PR standard CI #45065048214](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45065048214) and [branch standard CI #45065042098](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45065042098) — **success** on tested HEAD; locked install, Node tests, lint, build, security/SBOM, smoke and doctor.
- [Chromium/virtual WebAuthn browser #45065048325](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45065048325) — **success** on tested HEAD; not a live physical authenticator.
- Uploaded synthetic metadata-only signed archive [artifact #14770679693](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45065048221/artifacts/14770679693) named `orb-005-ci-cross-runner-metadata`, GitHub digest `sha256:21ae585e2011bc3a1c87b4021fac9d10f057af3f0e8e9b2831e6ebdb7dcc1d64`.
- Second-runner non-secret proof [artifact #14770333788](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45065048221/artifacts/14770333788) named `orb-005-ci-cross-runner-restore-proof`, GitHub digest `sha256:c23d9397b1368cd704db4e7085357e88d985cd9815bab5a708a770c9d5129a45`.
- An earlier functional HEAD (`c3d629fa`) had a **syntax error in a newly added unit-test fixture** despite passing the 17-job service workflow; it was fixed and full PR checks reran successfully on `b9edaa8d...`. No untested earlier run is treated as final evidence.
- This evidence/documentation follows the tested implementation commit. Re-run all final docs-head checks and verify separately the resulting post-merge `main` SHA and CI.

## Observed bounded properties

1. An ephemeral Node Ed25519 key pair is minted on CI runner A. Private key **stays in memory**, is not written to Git, artifact, log, project output, or SQLite. A signed normalized evidence envelope contains only random opaque synthetic IDs, source credential epoch integers, source events, PG-shaped witness metadata, fixture HMAC-shaped random values and source event reason codes. Account password hashes, email, session tokens, MFA/recovery codes and provider secrets are structurally rejected by exact field allowlist.
2. The portable archive is transported through GitHub `upload-artifact@v4`. **Separate** GitHub job outputs carry expected SHA-256 public-key fingerprint, envelope SHA-256, and fixed sequence 7. On runner B, `download-artifact@v4` obtains the archive; Node verifies signer identity pin, archive checksum and Ed25519 signature before accepting any metadata. Cryptographically signed fields cannot be changed without detection so long as the separately transported public fingerprint remains trusted.
3. The receiver checks per-user epoch coverage (every epoch 2 through head), witness/source row equality and uniqueness, no orphan/repeated records, strict canonical ordering, and no unexpected fields. Tests reject altered actor/reason/MAC, duplicate witnesses, deleted source event, substituted public key or signature, wrong published artifact hash, replayed/advanced sequence and a hidden password-hash field.
4. A **different runner** reconstructs only `ci_recovered_epochs`, `ci_recovered_events` and `ci_recovered_witnesses` tables in a new SQLite `:memory:` database. An injected exception inside the transaction rolls back **both** DDL and inserted rows, then the next clean attempt successfully reconstructs all 3 synthetic users, 3 events and 3 witnesses. There is **no** `users` authentication table or session authority.
5. All tests are opt-in `GITHUB_ACTIONS=true` and `ORBICORE_CI_SYNTHETIC_CROSS_RUNNER=1`; production/default runtime does not import the modules. The only verified recovery is **synthetic witness/event metadata**.

## Security blockers / deliberate nonclaims

- **Not independently administered off-host production backup:** GitHub Actions artifact and producer job outputs are controlled by the same workflow/repository, not distinct trust owners, key custodians, external KMS/HSM, S3 Object Lock/WORM, immutability proof or incident-tested restoration. Artifacts use **7-day retention** and may be deleted by authorized administrators.
- A private Ed25519 key minted at export only authenticates the export under a separately supplied **in-workflow** public-key pin. It does **not** independently prove that source SQLite had an authorized actor or an unsuppressed source event before export. The source MAC-like values are random **fixture placeholders**, not verifiable external provenance; the consumer does not have the source signing key.
- Fresh-runner **metadata** restoration does not restore real SQLite/PG identities, MFA secrets, encrypted key rings, job queues, audit chain, Redis/AOF, provider credentials or production sessions; no host crash, offsite restore, cross-region DR or live switch was attempted. Nor does it replace fail-closed read-routing or human-approved production cutover.
- `ORB-005` stays **in_progress / integration_tested**. Production HTTP remains SQLite; every PostgreSQL authentication and synthetic shadow experiment is disabled for normal users. Next: controlled IAM/object-lock audit storage, externally held trusted public-key pin, full encrypted off-host backup/restore, real MFA-aware mutation policies, distributed throttling and operator-reviewed rollback gates.
