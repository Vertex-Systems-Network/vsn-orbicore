# ORB-010 — Missing license metadata and lockfile fail-closed CI

**Date:** 2026-11-23  
**PR:** [#44](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/44)  
**Functional tested SHA:** `1ebcd9788a53a719180928be6d6161a073bfaf59`

## Hosted CI facts

- [PR CI #45084583870](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45084583870) and [branch CI #45084568862](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45084568862): **success** at the identical SHA.
- Standard GitHub-hosted Ubuntu/Node 24 run: **113 unit/API/security tests passed / 0 failed**, scoped source/secret/license gate passed, TypeScript/lint, official CycloneDX 1.5 upstream schema gate, build, smoke and doctor all passed; `npm audit --audit-level=high` reported **0 vulnerabilities at that run time**.
- Security report: `lockfilePresent:true`, `lockfileRootMatchesPackage:true`, `scannedFiles:242`, `unreviewedLicenses:[]`, zero existing disallowed licenses or high-confidence source secret findings. The recognized Git-tracked-file count increased from 241 in PR #43 when this test file/document was added.

## Tested policy

1. A new locked dependency with missing `license` metadata or a literal `UNKNOWN` license can no longer silently pass. The gate returns a package/version-only `unreviewedLicenses` entry and fails; operators must identify and review the correct upstream declaration/license, not assume it is MIT.
2. A missing `package-lock.json` is no longer silently interpreted as sufficient manifest-only evidence. `lockfilePresent:false` causes failure. A lockfile with root name or version differing from `package.json` also fails `lockfileRootMatchesPackage`.
3. Explicitly permitted known SPDX expressions and the one exact documented `caniuse-lite` data-license exception still pass; the generated SBOM and the existing CI audit remain separate controls.
4. One new synthetic temp-fixture Node test covers absent metadata, explicit UNKNOWN, valid MIT, mismatched root and missing lockfile. No real third-party license was modified.

## Limits

- The gate is conservative and does **not** automatically determine obligations or solve missing licenses; manually reviewed metadata and distribution requirements remain external compliance work.
- This covers the npm **lockfile's declared packages**, not exact deployed artifacts, other language ecosystems, OS/container libraries, full Git history, leaked credentials outside source files, real provider tokens or legal signoff.
- ORB-010 remains `in_progress/unit`; final documentation-head CI and postmerge main CI need independent verification.
