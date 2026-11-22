# Test evidence index

Store task ID, command/workflow, runtime, date, exit code, commit, fixture/environment, artifacts and limitations. Redact secrets, personal data, tokenized URLs and database dumps. Separate unit/mock, browser, integration and live-provider evidence.

- [2026-11-09 local proof of concept](2026-11-09-local-poc.md): local/mock evidence only.
- [2026-11-10 GitHub CI checkpoints](2026-11-10-github-ci.md): merged PR #2/#3 implementation checks and PR #4 docs check; no browser or live-provider claim.
- [2026-11-22 ORB-015 license-gate CI](2026-11-22-orb-015-license-ci.md): reviewed CC-BY-4.0 transitive data exception; subsequent PR #6 merged.
- [2026-11-22 ORB-012 Chromium virtual-passkey E2E](2026-11-22-orb-012-browser-e2e.md): successful hosted browser run, synthetic screenshot/runtime artifact and explicit limits; no physical authenticator or provider claims.
- [2026-11-22 ORB-015 npm audit and CycloneDX artifact CI](2026-11-22-orb-015-audit-sbom-ci.md): 44 tests, zero npm audit findings at test time, reproducible 169-component lockfile BOM and uploaded artifact; no deployed-system or independent schema validation claim.
- [2026-11-22 ORB-016 PostgreSQL/Redis hosted service parity](2026-11-22-orb-016-services-ci.md): successful disposable DB schema/constraint and Redis I/O checks; no application adapter or worker restart claim.
