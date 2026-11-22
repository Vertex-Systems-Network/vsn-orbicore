# ORB-015 — GitHub CI npm audit and CycloneDX artifact — 2026-11-22

## Verified result

- Repository: `Vertex-Systems-Network/vsn-orbicore`; PR [#8](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/8).
- **Tested feature SHA:** `5e0cf94130e36c803a94c61b8d9f8a1828d13670`.
- [GitHub Actions PR run 44995631637](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44995631637): **success** (also [branch run 44995614820](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44995614820): success).
- Runner: GitHub Actions `ubuntu-latest`, Node 24 via `actions/setup-node@v4`; exact npm patch and runner image revision are in the workflow logs.
- Commands: `npm ci`, `npm test`, `npm run lint`, `npm run security:check`, `node scripts/generate-sbom.mjs`, `npm audit --audit-level=high`, `npm run build`, `npm run smoke`, `npm run doctor`. Artifact upload step passed.
- Tests: **44 passed, 0 failed**. This includes deterministic SBOM and nested/optional-peer dependency graph unit checks, plus existing SSRF/traversal/redaction, injection, tenant isolation and authentication replay tests.
- Runtime npm audit reported **0 vulnerabilities** in the tested dependency set at the time of the run (this is a dated registry result, not a permanent absence-of-vulnerability guarantee).
- Generated lockfile-scoped CycloneDX **1.5**: **169 components**, 170 dependency entries, **0 unresolved required dependencies**. Exported JSON SHA-256 `8ae1c1ff0fc692ff926c965d196b92321dab9de2ab078e1430ce3f49e6f94bd8`.
- [Artifact `orb-015-cyclonedx-sbom` (ID 14743787636)](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44995631637/artifacts/14743787636); artifact ZIP digest `sha256:d5c9f26b22663a9550c4a993e4c5eaf8ac41cf4542c92f1cd4941c570442d2ae`. Normal workflow retention applies.

## Limitations

- Lockfile inventory is **not** a validated deployed-system SBOM; `compositions.aggregate = incomplete` is intentional. Upstream CycloneDX JSON-schema validation has not run; the deterministic unit tests check shape, reference integrity and graph closure.
- The regular security script scans a bounded set of credential patterns; it does not prove a comprehensive secrets investigation. Dependency advisories depend on npm registry visibility and time.
- Static unit/security checks do not verify live cPanel, physical authenticator behavior, production DB/queue or an external SIEM/WORM audit.
- Subsequent documentation/status commits and merged `main` SHA require their own CI observations. Do not infer a run tested files introduced after the head SHA above.

## Final ORB-011 regression correction verified on the same PR

An intermediate documentation-head CI intermittently rejected a valid generated recovery code during MFA login. Root cause: `apps/api/server.mjs` checked a minimum 20-character length **after** stripping base64url hyphens; a 22-character issued code with several hyphens can become shorter than 20. PR #8 updates the guard to accept normalized codes of at least 16 characters when the original input has at least 20, and adds a deterministic API regression test at `tests/recovery-code-edge.test.mjs`. The normal authentication rate limits, code hashes and single-use semantics remain in place.

- **Fixed/tested SHA:** `011317d2be346868356e2956e95676a6bea347c6`.
- [CI run 44995965598](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44995965598): **success**, **45 tests passed / 0 failed**, `npm audit --audit-level=high` found **0 vulnerabilities**, 169-component deterministic SBOM reproduced unchanged.
- [Browser run 44995965552](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44995965552): **success** against the same SHA.
- [Uploaded SBOM artifact 14743976054](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44995965598/artifacts/14743976054); the exported JSON SHA-256 still equals `8ae1c1ff0fc692ff926c965d196b92321dab9de2ab078e1430ce3f49e6f94bd8`.
- Existing real-world recovery contact delivery and physical authenticator verification remain untested.
