# Handoff

## 2026-11-22 — ORB-016 hosted Postgres/Redis service parity (PR #9)

- CI tested head `2d46a0bac12f7631476fb72ad69529465a181e2f` in [run 44996391832](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44996391832): passed PostgreSQL 16.16 and Redis 7.4.12 service container start, partial schema twice, synthetic job persistence across independent SQL sessions, FK/idempotency constraints and Redis SET/GET/TTL/DEL. Artifact [14743823737](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44996391832/artifacts/14743823737). Evidence `docs/TEST_EVIDENCE/2026-11-22-orb-016-services-ci.md`.
- First attempt [44996321561](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44996321561) was blocked by missing Redis CLI on GitHub runner; workflow now installs `redis-tools`.
- `docker-compose.yml` now defines named Postgres/Redis data volumes; the Compose stack itself has **not** run. `db/postgres-schema.sql` explicitly declares partial target schema, not SQLite v7 parity.
- **Do not mark ORB-016 verified:** real app PostgreSQL adapter, Redis durable worker, schema migrations, worker restart/recovery and live Compose data persistence remain absent. Task stays testing with technical blockers. PR #9 docs commits require fresh CI before merge.
- PR [#8](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/8) merged into `main` as `2944dda70a332ece1a43225a904c58a5012fb421`.
- **Next:** ORB-004 / ORB-016 actual production-shaped DB and queue app slice with service-backed recovery tests, then ORB-018 accessibility and remaining security gates.

## 2026-11-22 — ORB-015 supply-chain gates verified (PR #8)

- Commit tested: `5e0cf94130e36c803a94c61b8d9f8a1828d13670`. GitHub [PR CI 44995631637](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44995631637) and [branch CI 44995614820](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44995614820) succeeded, including `npm test` (45 passing on final fix SHA `011317d2be346868356e2956e95676a6bea347c6`; earlier supply-chain head had 44 passing), `npm run lint`, `npm run security:check`, `npm audit --audit-level=high` (0 vulnerabilities reported), build, smoke and doctor.
- Lockfile-based CycloneDX 1.5 file included 169 components, 170 dependency entries, 0 missing required entries; exported JSON SHA-256 `8ae1c1ff0fc692ff926c965d196b92321dab9de2ab078e1430ce3f49e6f94bd8`. Artifact [14743787636](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44995631637/artifacts/14743787636). See `docs/TEST_EVIDENCE/2026-11-22-orb-015-audit-sbom-ci.md` and `docs/RESEARCH/2026-11-22-supply-chain-ci.md`.
- A follow-up fix addressed valid base64url recovery codes with multiple hyphens being rejected by the old normalized-length check. `tests/recovery-code-edge.test.mjs` passed in [CI 44995965598](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44995965598); the same SHA passed [browser 44995965552](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44995965552).
- **Limitations:** npm lockfile only; no independent official JSON-schema validation, container/OS inventory, comprehensive secret-detection or live provider access. Keep ORB-010 umbrella open.
- PR [#7](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/7) merged successfully into `main` as `1f8dec9446089dd38a4eb723e278467d7106484d`. PR #8 still requires final CI check and confirmed merge after docs updates.
- **Next:** ORB-016 PostgreSQL/Redis hosted service containers. Avoid conflating schema/Redis ping with real production persistence/queue integration.

## 2026-11-22 — ORB-012 browser E2E verified (PR #7)

- ORB-012 code/test SHA `8c7e9a2b3eaf952469a9f8882ab3e674f95b633f`, GitHub Actions [browser run 44995181964](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44995181964), **success**; [standard CI 44995181961](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44995181961), **success**. Chromium 159.0.8154.6, Node v24.22.3, localhost RP ID, synthetic fixtures. Artifact: [14743052654](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44995181964/artifacts/14743052654).
- Registered passkey with browser virtual CTAP2 authenticator, signed in, verified counter increment; replay, tampered origin/RP hash, expired challenge and stale counter were rejected. Basic auth/nav/audit DOM checks passed. See `docs/TEST_EVIDENCE/2026-11-22-orb-012-browser-e2e.md`.
- Earlier browser failures were due to localhost listener/`networkidle` and ambiguous `Overview` locator. Fixed on branch `feat/orb-012-browser-webauthn-e2e`; do not claim production or physical authenticator verification.
- PR [#6](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/6) **merged**, SHA `6aa0629540525174cdf1ff88dc6bf74c56e9a048`. PR #7 merged after required browser and standard CI checks; browser run verifies the application/test script.
- **Next:** ORB-015 full dependency audit/SBOM artifact CI, ORB-016 real hosted service-container integration, ORB-018 full accessibility and platform authenticator/manual gates. No real cPanel credentials supplied.

## 2026-11-22 — ORB-015 CI gate repair (PR #6)

Main's 2026-11-22 push CI [44980063547](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44980063547) failed in the supply-chain test due to a `caniuse-lite@1.0.30001823` CC-BY-4.0 license declaration. PR [#6](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/6) adds an exact-version reviewed license exception, attribution notice, and regression assertion; [CI 44994225836](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44994225836) passed tests/lint/security/build/smoke/doctor for head `a42e8cedd7a4ebd4ac4157ef2ff241c6b1dcf593`. Evidence: `docs/TEST_EVIDENCE/2026-11-22-orb-015-license-ci.md`. Follow-up evidence-only commit requires recheck; do not claim merge before confirmed. ORB-012 remains next for browser passkey E2E.

## Latest verified checkpoint

- Correct repo: `Vertex-Systems-Network/vsn-orbicore`; audit baseline `main`: `fac13611c21cfbeec6148a7cbd93a0799dfc4c45`.
- PR #2 merged WebAuthn server/UI at `bdd3b6179d911cb0abdd3a35f9aefb17dca02ab5`; PR #3 merged passkey inventory/revocation/rebinding at `c4cdab76a82578fc4db698b04098e0234e5570a2`; PR #4 synchronized docs.
- Actions runs: [PR #2](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/42733887820), [PR #3](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/42734476163), [PR #4](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/42734679968). Evidence index: `docs/TEST_EVIDENCE/2026-11-10-github-ci.md` & `docs/TEST_EVIDENCE/2026-11-21-local-slices.md`.
- Local workspace vertical slices across Phases 0–8 pass **42 automated tests**, `npm run security:check` (secret scan, OSS licenses, CycloneDX SBOM), `npm run lint`, `npm run build`, `npm run smoke`, and `npm run doctor`, including SHA-256 tamper-evident audit chaining (`/api/audit/verify`), interrupted job crash recovery, production deployment readiness wizard (`/api/system/deployment-readiness`), AES-256-GCM encrypted secret references (`/api/secrets`), Light/Dark theme toggle & sortable inventory tables, and pre-seeded + on-demand dummy demo datasets (`/api/system/demo-seed`). Hosted workflows `.github/workflows/ci-services.yml` and `.github/workflows/ci-browser.yml` + `scripts/browser-verify.mjs` are prepared for GitHub-hosted PostgreSQL/Redis & Chromium execution.
- Local verification does not establish live provider behavior, Docker PostgreSQL/Redis runtime execution, or hosted browser DOM/passkey E2E.

## Resume from current main

1. Trigger `.github/workflows/ci-browser.yml` (ORB-012 / ORB-018) on GitHub-hosted Chromium with WebAuthn virtual authenticator; record run artifacts.
2. Trigger `.github/workflows/ci-services.yml` (ORB-016) to execute `db/postgres-schema.sql` & Redis readiness in GitHub service containers.
3. Supply an owner-authorized disposable cPanel UAPI token to validate ORB-006/019 read-only discovery before enabling live mutations.
