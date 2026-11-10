# Next action

1. **ORB-012:** Add GitHub Actions browser E2E using Chromium/Playwright with WebAuthn virtual authenticator. Exercise registration → assertion → counter update → replay rejection; reject wrong origin/RP ID and expired/reused challenge.
2. Record browser/runtime versions, run URL, tested SHA, logs and artifact links. If runner setup fails, preserve exact failure and keep the task blocked; do not call it browser-verified.
3. Update ORB-011/012 verification levels only from workflow evidence. Physical platform authenticator remains a separate manual gate.
4. Then execute ORB-015 security negative tests and secret/dependency/SBOM/license gates.
5. Attempt ORB-016 service containers for PostgreSQL/Redis and ORB-018 hosted browser accessibility; update environment blockers only from results.
6. Implement ORB-007 local idempotent preflight independently; ORB-017 covers production DB/queue, upgrades and recovery.
7. ORB-013/014 cover verified notification delivery and tested key rotation/backup restore. Provider credentials remain disabled until required security gates pass.
8. ORB-006/019 require owner-authorized disposable cPanel account and scoped token.

## Evidence contract

For each task, record task ID, workflow URL, tested SHA, commands/jobs, runtime, exit outcome, artifacts and limitations in `docs/TEST_EVIDENCE/`. Do not infer physical authenticator, live email, production DB/queue, or provider behavior from unit/mock CI.

## Current verified result

Audit baseline `main`: `fac13611c21cfbeec6148a7cbd93a0799dfc4c45`. PR #2/#3 contain merged passkey implementation and management controls. Their Actions runs passed tests/lint/build/smoke/doctor; browser and operational gates remain unverified. See the evidence index.
