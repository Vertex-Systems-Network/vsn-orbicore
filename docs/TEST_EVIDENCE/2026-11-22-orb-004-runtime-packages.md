# ORB-004 — Pinned PostgreSQL and Redis runtime packages — 2026-11-22

## Verified results

- Repository: `Vertex-Systems-Network/vsn-orbicore`; PR [#13](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/13).
- **Tested feature SHA:** `3b7f26ee97e992427d5f0bad4cabc4c1a4f68e53`.
- [GitHub Actions service integration 44998860302](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44998860302) **success**: `npm ci` from the committed lockfile, import **`pg@8.23.1`** and **`redis@6.3.1`**, perform parameterized PostgreSQL query and Redis PING/SET/GET/DEL, then rerun PostgreSQL job repository, authenticated HTTP gateway, tenant-fenced claims and Redis Streams contract tests.
- [Standard CI 44998860295](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44998860295) **success**: **49 tests passed, 0 failed**, lint, existing license/secret gate, `npm audit --audit-level=high` reported **0 vulnerabilities at the test time**, build, smoke, doctor.
- Generated deterministic npm lockfile CycloneDX 1.5 inventory: **189 installed lockfile components**, **190 dependency entries**, **0 missing required dependencies**; exported JSON SHA-256 `ce09a55ae4b6e516d91871c7290235cec799ce989105e3d76218c9797be75ba0`. Lockfile manifest/graph tests passed.
- [Runtime client JSON artifact (ID 14744408086)](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44998860302/artifacts/14744408086); [HTTP job integration artifact (ID 14745071121)](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44998860302/artifacts/14745071121), plus PostgreSQL repository and Redis job lease artifacts in the same successful workflow.
- An ephemeral, restricted GitHub Actions workflow [44998641719](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/44998641719) generated `package.json` + `package-lock.json` using official npm registry `npm install --package-lock-only --ignore-scripts --no-audit --save-exact pg@8.23.1 redis@6.3.1`; both checked-in files were imported via GitHub contents API and the temporary workflow was deleted from the feature branch before PR review. No local-only repository copy, runtime secret, or production token was involved.

## Boundaries

- These are genuine installed **runtime npm dependencies**, not proof that the current standalone `createApp()` command initializes Postgres or Redis by default. The isolated PostgreSQL HTTP job mode still needs explicit `jobRepository` injection and `startWorker:false`; identity/accounts/audit remain in SQLite.
- No persistent Redis stream consumer, transactional Postgres outbox, production identity/account migration, provider-side policy enforcement, application restart recovery, Compose volume reboot or live provider integration was implemented by this PR.
- An npm audit result is a dated registry assessment; the SBOM remains a lockfile-only inventory with incomplete deployed-system scope and no separate external JSON-schema validation.
- This evidence file was committed after the original tested SHA. Check final PR-head and merged main CI independently before closing any tasks.

## Next

Build the production-shaped PostgreSQL job transaction/outbox and a separately restartable Redis Stream consumer with idempotent, policy-gated synthetic execution; test crash windows at each transition. Do not enable real provider actions based on infrastructure tests alone.
