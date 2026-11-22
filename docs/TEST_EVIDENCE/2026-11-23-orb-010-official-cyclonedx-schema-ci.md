# ORB-010 — Official CycloneDX 1.5 schema validation in GitHub CI

**Date:** 2026-11-23  
**PR:** [#39](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/39)  
**Functional tested SHA:** `bd6b2cdb0183e036838e8c9ab677e71812cbb7f9`

## Measured hosted GitHub evidence

- [PR-head CI #45080916542](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45080916542): **success**. [Branch-head CI #45080898373](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45080898373): **success**.
- Runner: GitHub-hosted Ubuntu, Node 24, setup-python 3.12, `jsonschema==4.25.1` via pip; exact patch/tooling logs retained in the runs. No live hosting connectors or production credentials.
- Existing standard checks all succeeded: `npm ci`, **109 automated Node tests passed, 0 failed**, `npm run lint`, `npm run security:check`, generated deterministic SBOM, upstream schema validation, `npm audit --audit-level=high` reporting **0 vulnerabilities at the checked time**, `npm run build`, `npm run smoke`, `npm run doctor`.
- Validator printed `{"cyclonedxSchemaValidated":true,"schemaVersion":"1.5","officialSchemaCommit":"5fee6af48d43c751dc6a5b31138f06af2b10bac5","lockedSchemaFiles":3,"componentCount":189,"negativeFixturesRejected":3,"deploymentScope":"npm-lockfile-only"}`.
- [SBOM artifact #14777048411](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45080898373/artifacts/14777048411) `orb-015-cyclonedx-sbom`; hosted ZIP digest `sha256:e4bd0cb1dff3426f449cc44372667c18fa17f81c303595ab2f696eaafa320963` (artifact wrapper, not raw JSON).

## How validation works

- Only the three official upstream schema files `bom-1.5.schema.json`, `spdx.schema.json` and `jsf-0.82.schema.json` are fetched from pinned upstream commit `5fee6af48d43c751dc6a5b31138f06af2b10bac5`. Each downloaded file must match its distinct expected Git blob object ID and strict size limit before parsing. Unexpected external references cannot silently become trusted schemas.
- The generated SBOM is validated using JSON Schema draft-07, including referenced SPDX/JSF schemas and a format checker. Explicit graph checks also enforce a one-to-one dependency inventory, no missing references, zero unresolved required dependencies and the `incomplete` deployment-scope disclaimer.
- Three deliberately malformed cloned SBOMs (wrong BOM type, unexpected top-level field, and missing library name) are passed to the **actual upstream validator** and must all be rejected.
- The SBOM upload step now requires CI success; a failed validation does not upload an invalid artifact. Existing Node tests assert workflow ordering and validator pinning.

## Limitations and follow-up

- The upstream schema validation is an **external schema integration gate**, not a deployed-system BOM, live provider provenance check, full dependency license opinion, independent release-signature verification or production supply-chain audit.
- GitHub and PyPI availability are CI dependencies. The schema source is pinned by immutable upstream commit and per-file blob IDs; the Python direct dependency is version-pinned, but the pip dependency resolution is not fully hash-locked.
- The project still needs complete runtime/container/OS inventory, artifact attestation, external schema/tool dependency custody, extended credential scanning and full tenant/identity/backup/provider production security review.
- ORB-010 remains `in_progress` with `unit` evidence strength for CI; ORB-015's already verified subtask does not equal production readiness. Check final documentation-head and postmerge main CI before marking the PR merged.
