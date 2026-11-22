# Next action

1. **ORB-015:** Review and strengthen the already-running CI security suite. Ensure negative tests cover SSRF, traversal, tenant isolation, injection, replay and redaction, add an actionable dependency audit policy and produce a reproducible full CycloneDX SBOM artifact. Current `security:check` produces a summary, not a distributable full SBOM. Preserve license attribution and fail-closed behavior.
2. **ORB-016:** Execute and evaluate GitHub Actions PostgreSQL/Redis service-container workflow (`.github/workflows/ci-services.yml`). Verify schema reapplication, connectivity and then implement/test durable worker recovery; do not mislabel schema-only success as a production DB/queue application integration.
3. **ORB-018 / ORB-009:** Expand hosted Chromium checks for WCAG keyboard, focus, color contrast, desktop/mobile layouts, loading, stale, permission and error paths. Basic DOM checks in ORB-012 do not close this.
4. **ORB-011 / ORB-013 / ORB-014:** Complete verified contact *live* notification delivery, physical platform authenticator, production key management and backup restore, with safe sandbox boundaries.
5. **ORB-017:** Production installer, PostgreSQL/Redis upgrades/recovery, and measured VPS resources remain separate from local SQLite preflight.
6. **ORB-006 / ORB-019:** Owner-authorized disposable cPanel account/token required before any scoped read-only live integration tests; never enable real provider mutations from mock evidence.

## Verified checkpoint

- **ORB-012 is browser-tested and verified**, [GitHub Actions 44995181964](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44995181964), tested SHA `8c7e9a2b3eaf952469a9f8882ab3e674f95b633f`. See [evidence](TEST_EVIDENCE/2026-11-22-orb-012-browser-e2e.md) and [artifact](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44995181964/artifacts/14743052654).
- Browser verification used Chromium with an internal virtual CTAP2 authenticator and synthetic SQLite fixtures. No physical authenticator, live provider, production secrets, full accessibility or distributed DB/queue was verified.
- PR [#6](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/6) merged the scoped Can I Use license fix in `main` at `6aa0629540525174cdf1ff88dc6bf74c56e9a048`. PR #7 includes ORB-012 code and evidence; verify its final CI/merge SHA independently.

## Evidence contract

For each task, record its ID, URL, exact tested SHA, jobs and commands, runtime, exit result, artifacts, limitations, and any unblocker in `docs/TEST_EVIDENCE/`. Keep task lifecycle distinct from the verification level; do not upgrade physical authenticator, live email, production DB/queue or provider status based on local or mocked tests.
