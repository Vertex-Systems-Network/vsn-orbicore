# Test evidence index

- [2026-11-23 ORB-004/005/016/017 signed quarantine non-executable recovery-policy dry-run](2026-11-23-orb-004-replay-policy-dry-run.md): manual review for queued, investigation for running, seven unfulfilled production gates, no Redis/public outbox/provider effects; hosted PR CI pending.


- [2026-11-23 ORB-004/005/016/017 CI-only active-job Ed25519 verification across two runners](2026-11-23-orb-004-cross-runner-quarantine-attestation.md): signed PG16 fixture quarantine metadata with separate SHA/public-key pins, independent fresh-runner negative tamper tests, no re-enqueue; functional head `5693e059` passed 151/151 Node, 26/26 PG16/Redis7, browser/ledger; final documentation-head CI pending.


- [2026-11-23 ORB-004/005/016/017 signed active-quarantine source/PG reconciliation](2026-11-23-orb-004-ci-signed-quarantine-reconciliation.md): detached HMAC fixture checkpoint, read-only source-to-PG parity, forged-hash/source-drift denial and zero runtime replay; 148/148 Node and 25/25 PG16/Redis7 plus Chromium/ledger passed at functional SHA f69351fb; final docs-head CI pending.


- [2026-11-23 ORB-004/005/016/017 non-executable synthetic active-job quarantine](2026-11-23-orb-004-ci-active-job-quarantine.md): private PG16 fixture schema, strict consent, tenant checks, audit metadata, injected rollback, denied non-owner access and no Redis/job-outbox replay; functional PR head `d4e0e130` passed 145/145 Node, 25/25 PG16/Redis7, browser/ledger; final docs-head CI pending.


- [2026-11-23 ORB-005/017 SQLite v7 source migration manifest preflight](2026-11-23-orb-005-017-sqlite-source-manifest.md): exact 7-version/name/timestamp gate, negative PG16 source tamper/refusal checks passed at c17e32e8; 142 Node tests, 24 PG16/Redis7 jobs, Chromium and ledger success. Final docs-head CI pending.


- [2026-11-23 ORB-004/005/016/017 synthetic terminal job history migration](2026-11-23-orb-004-005-terminal-job-history-ci.md): synthetic terminal history and real local mock-worker job copy passed latest 24/24 PG/Redis jobs + 140 Node tests at 6890baa6, with intermediate red-to-green regression recorded; final docs-head CI pending.


- [2026-11-23 ORB-010/015 vendored official CycloneDX 1.5 CI](2026-11-23-orb-010-offline-schema-ci.md): 136 hosted Node tests, four Python fail-closed pin tests, official JSON Schema + three invalid BOMs passed at functional SHA 104b0b5; docs/head CI pending.

- [2026-11-23 ORB-006/010 fake-fetch UAPI response/redirect guard](2026-11-23-orb-006-uapi-response-redirect-guard.md): no-live-credentials response-status and outbound redirect denial regressions passed 136/136 hosted Node tests, Chromium and PR task-ledger at dfa3eda; docs-head CI pending.

- [2026-11-23 ORB-005/017 loopback development and proxy header guard](2026-11-23-orb-005-017-loopback-proxy-guard.md): default listener hosts and forwarded authority regressions passed 133/133 hosted Node tests, Chromium, PG16/Redis7 and task ledger at functional head eb47845; docs-head CI pending.

- [2026-11-23 ORB-005 HTTP JSON ingress guard](2026-11-23-orb-005-http-json-ingress.md): byte-limit/strict UTF-8/object validation passed 130/130 hosted Node tests and browser/PG/Redis workflows at e1133385; final docs-head merge pending.

- [2026-11-23 ORB-020 real PR #52/#53 auto-sync webhook validation](2026-11-23-orb-020-live-pr-ledger-webhook.md): actual opened/synchronize/edited PR events inserted/refreshed 20-row task table; independent stale-PR main-push fanout verified and ORB-020 closed in PR #54.

- [2026-11-23 ORB-020 AI plan status governance, PR task ledger, npm install and GitHub action warning cleanup](2026-11-23-orb-020-plan-governance-ci.md): 122 Node tests, all 23 service CI jobs and browser CI green; live PR webhook write permission pending.

- [2026-11-23 ORB-009/018 200% text-only simulation and four browser-proven CSS fixes](2026-11-23-orb-009-018-200percent-text-only-simulated-browser.md): 60 sampled text/control checks, 3 widths, four red-to-green auth/security overflow regressions; not native Firefox text-only zoom or full WCAG.

- [2026-11-23 ORB-009/018 WCAG 1.4.12 text spacing at native Chromium 400% zoom](2026-11-23-orb-009-018-text-spacing-400-browser.md): 12 sampled auth/dashboard text nodes and 320px page width passed injected line/letter/word-spacing clipping checks; sampled only, not full WCAG.

- [2026-11-23 ORB-009/018 security dialog 400% native Chromium zoom focus/scrollport](2026-11-23-orb-009-018-native-400-security-dialog-focus.md): six focused controls fully inside browser and modal viewports; real Tab/Shift+Tab/Escape focus checks, no secrets captured; still no full WCAG.

- [2026-11-23 ORB-009/018 native Chromium 200%/400% zoom and scrollable collapsed sidebar](2026-11-23-orb-009-018-native-chromium-zoom.md): real tab zoom, measured 1280/640/320 px, 400% offscreen Jobs link fixed, no page-wide overflow for sampled dashboard screens; not full WCAG.

- [2026-11-23 ORB-009 light/dark sign-in computed-color contrast](2026-11-23-orb-009-auth-theme-contrast-browser.md): four normal-text roles checked per theme at 4.5:1; does not certify full WCAG.

- [2026-11-23 ORB-009 browser MFA real wrong code, simulated 429/503/expired challenge and one-time recovery](2026-11-23-orb-009-mfa-browser-error-matrix.md): two synthetic Chromium sessions, TOTP enroll UI, code attribution and replay rejection; no real provider or manual WCAG claim.

- [2026-11-23 ORB-010 unknown license and npm lockfile denial](2026-11-23-orb-010-unknown-license-lockfile-denial.md): 113 tests, denied missing/UNKNOWN license, missing lockfile and root mismatch; release legal signoff not proven.

- [2026-11-23 ORB-010 Git-tracked source secrets and SPDX license expressions](2026-11-23-orb-010-tracked-source-secret-license-gate.md): 241 source files inspected with 112 passing hosted tests; no full historical or live deployed security claim.

- [2026-11-23 ORB-009 auth field error accessibility](2026-11-23-orb-009-auth-form-accessible-errors.md): browser `aria-invalid` and `aria-describedby` checks for wrong bootstrap token and missing passkey email; manual WCAG not proven.

- [2026-11-23 ORB-018 cross-tenant delayed response and missing account browser verification](2026-11-23-orb-018-cross-tenant-snapshot-races.md): hosted Chromium two synthetic tenants, stale GET discard, 404 cross-tenant site/refresh and snapshot-reconciled account selection.

- [2026-11-23 ORB-018 account-bound site UI and browser session reset](2026-11-23-orb-018-account-site-isolation.md): synthetic account-specific 503/retry and same-owner logout/login recovery; no real multi-tenant provider proof.

- [2026-11-23 ORB-010 official CycloneDX 1.5 schema CI gate](2026-11-23-orb-010-official-cyclonedx-schema-ci.md): pinned upstream JSON Schema, 189 npm lockfile components, three invalid fixture denials; not a deployed-system SBOM.

- [2026-11-23 ORB-009/018 reliable workspace state and 320px/browser permissions](2026-11-23-orb-009-018-truthful-ui-states.md): hosted synthetic Chromium and standard CI; full WCAG/real zoom/manual audit not proven.

Store task ID, command/workflow, runtime, date, exit code, commit, fixture/environment, artifacts and limitations. Redact secrets, personal data, tokenized URLs and database dumps. Separate unit/mock, browser, integration and live-provider evidence.

- [2026-11-09 local proof of concept](2026-11-09-local-poc.md): local/mock evidence only.
- [2026-11-10 GitHub CI checkpoints](2026-11-10-github-ci.md): merged PR #2/#3 implementation checks and PR #4 docs check; no browser or live-provider claim.
- [2026-11-22 ORB-015 license-gate CI](2026-11-22-orb-015-license-ci.md): reviewed CC-BY-4.0 transitive data exception; subsequent PR #6 merged.
- [2026-11-22 ORB-012 Chromium virtual-passkey E2E](2026-11-22-orb-012-browser-e2e.md): successful hosted browser run, synthetic screenshot/runtime artifact and explicit limits; no physical authenticator or provider claims.
- [2026-11-22 ORB-015 npm audit and CycloneDX artifact CI](2026-11-22-orb-015-audit-sbom-ci.md): 44 tests, zero npm audit findings at test time, reproducible 169-component lockfile BOM and uploaded artifact; no deployed-system or independent schema validation claim.
- [2026-11-22 ORB-016 PostgreSQL/Redis hosted service parity](2026-11-22-orb-016-services-ci.md): successful disposable DB schema/constraint and Redis I/O checks; no application adapter or worker restart claim.
- [2026-11-22 ORB-004 leased PostgreSQL job + Redis Streams contract](2026-11-22-orb-004-lease-contract-ci.md): hosted lease/fencing/tenant/concurrency and stream redelivery assertions, with no production API adapter or true process/container restart claim.
- [2026-11-22 ORB-004 Node PostgreSQL job repository integration](2026-11-22-orb-004-node-postgres-repository.md): 47-test CI and real PostgreSQL query/tenant/idempotency/reconnect proof; no production API/Redis worker wiring.
- [2026-11-22 ORB-004 authenticated PostgreSQL job HTTP E2E](2026-11-22-orb-004-postgres-http-ci.md): hosted 49-test and real PostgreSQL-backed HTTP job checks with tenant/RBAC; no runtime PG/Redis worker or atomic cross-store audit.
- [2026-11-22 ORB-004 pinned PostgreSQL/Redis runtime clients](2026-11-22-orb-004-runtime-packages.md): official npm lockfile generation, 49 passing tests, hosted drivers, Redis/PG I/O and 189-component SBOM; no production worker yet.
- [2026-11-22 ORB-004 atomic PostgreSQL outbox and Redis synthetic worker](2026-11-22-orb-004-outbox-worker.md): verified atomic enqueue, SIGKILL/reclaim, actor policy revocation, replay reconciliation and opt-in standalone worker; no complete PG identity migration or Compose persistence.
- [2026-11-22 ORB-016 Docker Compose named-volume + Redis AOF recovery](2026-11-22-orb-016-compose-recreation.md): real disposable container removal/recreation and persisted PG/Redis state, naturally expired lease and standalone worker recovery; production HA not tested.
- [2026-11-22 ORB-005 PostgreSQL core identity and tenant RLS](2026-11-22-orb-005-postgres-identity-core.md): 55-test CI, hosted guarded synthetic SQLite snapshot, exact audit chain, MFA/disabled/expiry session denials and NOLOGIN read role restrictions; not full v7/cutover.
- [2026-11-22 ORB-005 PostgreSQL synthetic MFA/passkey/recovery state](2026-11-22-orb-005-pg-auth-state.md): hosted 57-test checkpoint, atomically copied fake auth-state tables with tenant FKs and safe-column RLS; not cryptographic migration, full SQLite v7 or live HTTP cutover.
- [2026-11-22 ORB-005 PostgreSQL tenant-pinned operational feature state](2026-11-22-orb-005-pg-feature-state.md): hosted 61-test, five-service-job proof for seven feature tables, full synthetic transactional identity+auth+feature snapshot, tenant FK rollback, safe-column RLS; not runtime write role or production cutover.
- [2026-11-22 ORB-005 authenticated PostgreSQL synthetic writer](2026-11-22-orb-005-pg-synthetic-writer.md): 65-test, six-service-job real non-owner LOGIN/NOLOGIN function proof, fresh session/MFA/tenant policy, one-transaction job/outbox/legacy-compatible fixed-format audit, concurrent replay and forced rollback; not app HTTP cutover or production roles.
- [2026-11-22 ORB-005 PostgreSQL-authenticated CI HTTP cookie/CSRF slice](2026-11-22-orb-005-pg-http-csrf.md): 68 automated tests and seven hosted PG/Redis/Compose jobs, real nonowner DB session probe, HMAC CSRF, raw Host/origin, revocation race and atomic audit rollback; no actual login issuance, production HTTP switch or live providers.
- [2026-11-22 ORB-005 PostgreSQL CI login, recovery MFA and cookie lifecycle](2026-11-22-orb-005-pg-ci-login.md): 73 tests, eight hosted service jobs and Chromium; non-owner PG fixture-only bcrypt verifier, real test-cookie issuance, bounded password/MFA failures, one-use recovery-code rotation, CSRF logout. Not SQLite scrypt production migration or real TOTP/passkey/TLS cutover.
- [2026-11-22 ORB-005 PostgreSQL CI-only atomic auth SHA audit](2026-11-22-orb-005-pg-atomic-auth-audit.md): 75 tests, nine service jobs, real non-owner restricted role, redacted Node-compatible tenant login/recovery/logout audit, forced session/MFA/logout rollback and tampered-head refusal; not SQLite scrypt credential cutover or production auth.
