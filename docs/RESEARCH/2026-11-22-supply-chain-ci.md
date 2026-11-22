# ORB-015 — npm dependency auditing and CycloneDX lockfile SBOM

**Researched:** 2026-11-22  
**Scope:** GitHub Actions checks for the VSN ORBICORE Node.js prototype only.

## Primary sources

- [npm CLI audit documentation](https://docs.npmjs.com/cli/commands/npm-audit/) — the `--audit-level` threshold controls the severity that causes a nonzero exit code. Selected `npm audit --audit-level=high` to fail on high or critical findings, including development dependencies. Registry/network failure must also fail the gate rather than be silently ignored.
- [OWASP CycloneDX specification overview](https://cyclonedx.org/specification/overview/) — inventory can include components and their dependency relationships, with explicit composition completeness claims.
- [Official CycloneDX 1.5 JSON schema](https://github.com/CycloneDX/specification/blob/master/schema/bom-1.5.schema.json) — reference model for the chosen `specVersion: 1.5`. The current project validates essential shape and reference closure in tests but does **not** yet execute full schema validation against the upstream JSON schema.

## Decision and tradeoffs

Generate a stable source-dependency BOM directly from the checked-in npm `package-lock.json`, without a new runtime package or an unpinned external generator. Every installed lockfile package is emitted as a component with its version, SPDX license expression if declared, integrity hash if declared, and unique lockfile-path BOM reference. Dependency edges resolve from the nearest installed nested package path; missing optional packages and optional peers do not imply a broken graph. Missing *required* dependencies cause CI failure.

Determinism: no wall-clock values or random UUID; the same package and lockfile produce identical JSON and SHA-256. The generated BOM intentionally sets `compositions.aggregate = incomplete`: npm's lockfile is not a complete inventory of native binaries, OS packages, browser assets, production containers, cloud resources, deployed customer sites, or dynamically loaded runtime dependencies.

CI uploads `.data/ci/orbicore-sbom.cdx.json` as a retained workflow artifact after generation, then independently runs `npm audit --audit-level=high`, while existing scans/checks remain. A package with unknown license is not thereby legal for redistribution. The reviewed exception for `caniuse-lite` and CC BY 4.0 is in `docs/THIRD_PARTY_NOTICES.md`.

## Follow-up gates

1. Add pinned, official CycloneDX JSON schema validation (including referenced schemas) or a maintained external validator before claiming independently schema-validated release BOMs.
2. Export platform/container/OS and build outputs if a deployable release is introduced.
3. Establish documented vulnerability exception policy, expiry/review owners and audit evidence retention; do not conceal findings.
4. Run independent production/provider threat-model validation before enabling live provider tokens.
