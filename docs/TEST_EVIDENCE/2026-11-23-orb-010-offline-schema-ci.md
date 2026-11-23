# ORB-010 / ORB-015 — Offline exact official CycloneDX 1.5 schema and license

**Date:** 2026-11-23 UTC. **PR:** [#58](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/58).

## Root cause / prior measurement

After PR #56, [main CI #45141894808](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45141894808) failed the official CycloneDX validation stage with `HTTP Error 503: Backend.max_conn reached` from downloading pinned upstream schema files. [Subsequent main CI #45142124493](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45142124493) passed at the **same** `1a6fbc68` Git commit. This external schema endpoint dependency caused a reproducibility failure; it was not evidence of a malformed SBOM.

## Exact immutable provenance

[Official upstream repository](https://github.com/CycloneDX/specification), commit `5fee6af48d43c751dc6a5b31138f06af2b10bac5`. The adapter checked each original GitHub source blob SHA before upload and the target-repository blob SHA after upload, ensuring byte-for-byte copying:
- `bom-1.5.schema.json`: `d9c4d08031d45ecf0c4b2f6fcac8eeb8c9e78a65`
- `spdx.schema.json`: `566c4a32518c60778e55a56ccf71bf781320b279`
- `jsf-0.82.schema.json`: `f46bfb1e52731ad1280123ff3e2bd29bd18d4bc2`
- Upstream Apache-2.0 `LICENSE`: `0808751c23d827d483dc3673d6e3f49514e49d1f`

[Vendored manifest](../../vendor/cyclonedx/1.5/PROVENANCE.md) and [third-party license notice](../THIRD_PARTY_NOTICES.md) document distribution attribution.

## Observed hosted CI

- [Feature branch CI #45143195069](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45143195069) completed **success** on functional SHA `104b0b53f7f34dd224f2479b9c8b22b7236f36da`.
- **136/136 Node tests, 0 failures**; **4/4 Python integrity tests**, covering three exact official hashes, one modified SPDX source failure, one missing file failure and one unknown filename rejection.
- The **real official CycloneDX Draft7 validator** ran successfully against 189 npm lockfile components. Actual CI output: `{"cyclonedxSchemaValidated":true,"schemaVersion":"1.5","officialSchemaCommit":"5fee6af48d43c751dc6a5b31138f06af2b10bac5","lockedSchemaFiles":3,"schemaSource":"vendored_verified_git_blobs_no_network","componentCount":189,"negativeFixturesRejected":3,"deploymentScope":"npm-lockfile-only"}`.
- Existing Node lint/security, npm audit, SBOM publish, build, smoke and doctor checks passed. PR CI and final docs-only head evidence must be observed before merge.

## Boundary

The local validator rejects altered/corrupt/missing schemas via Git object hash, size, JSON `$id` and draft checks. External raw-GitHub schema requests have been removed, but Python/npm package installation, GitHub Actions, and review remain external dependencies. Git blob IDs establish source-content equality, **not** independent source identity assurance or a signed upstream release. The BOM deliberately remains `npm-lockfile-only/incomplete`, not an OS/container/production software inventory or a release attestation. No live provider, KMS, external audit, full history secret-scan or production credential migration is covered. ORB-010 stays `in_progress/unit`, ORB-015 stays `verified/unit`.
