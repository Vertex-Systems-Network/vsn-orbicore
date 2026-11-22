# ORB-005 — legacy SQLite scrypt compatibility contract — 2026-11-22

## Hosted GitHub evidence (PR #23)

- [Pull request #23](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/23), tested functional head `1ac44ad8a3220ed0a3b9bed09fc7c681b1c96726`.
- [Standard CI #45055406351](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45055406351) **success** on that exact head. Independently the push [CI #45055379223](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45055379223) **success** on the same head.
- The standard CI workflow uses Node 24 and runs `npm ci`, `npm test`, `npm run lint`, `npm run security:check`, `node scripts/generate-sbom.mjs`, `npm audit --audit-level=high`, `npm run build`, `npm run smoke` and `npm run doctor`. All steps succeeded. An SBOM artifact was uploaded by the workflow; it has not been separately schema-validated as a production deployment inventory.
- [Chromium browser/WebAuthn #45055406339](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45055406339) **success** on the same head. This regression run exercises the unchanged local prototype browser surface, not PostgreSQL credential migration or production auth.
- This document was added **after** the functional head above passed. The final documentation commit and post-merge `main` workflow must be inspected independently before calling the whole PR merged/verified.

## Implemented

- `apps/api/legacy-scrypt-verifier.mjs` is a new **read-only, not yet runtime-wired** legacy SQLite verifier. It pins the original Node 24 `scryptSync` options `N=16384`, `r=8`, `p=1`, `maxmem=32 MiB`, output `64` bytes, and verifies using a constant-length `timingSafeEqual`.
- The historical salt is a 32-character lowercase hex **string passed as UTF-8 text**, not the 16 decoded random bytes. Only full 32-hex-character salt / 128-hex-character verifier shapes are accepted. Malformed shapes are rejected before password derivation; the API returns a boolean, not a password hash.
- Six new automated tests in `tests/legacy-scrypt-verifier.test.mjs` cover fixed synthetic ASCII, Unicode and empty-password regression vectors; comparison against the existing implicit-default Node call; salt encoding mismatch; malformed/truncated salt/hashes; wrong password/hash and oversized/wrong-type input; and boolean-only return.
- The frozen vectors were independently calculated via Python `hashlib.scrypt` (`n=16384,r=8,p=1,dklen=64`, UTF-8 strings) prior to PR CI. The hosted evidence above covers Node test execution; Python fixture generation was not a GitHub workflow gate. For documented Node 24 defaults see [official Node.js v24 crypto documentation](https://nodejs.org/download/release/v24.22.1/docs/api/crypto.html#cryptoscryptsyncpassword-salt-keylen-options).
- No existing `apps/api/server.mjs` login or account mutation code was changed; the current SQLite authentication and its already documented limitations remain intact.

## Not proven / remaining blockers

- A verifier helper is **not** an approved migration verifier for real accounts. Strict salt format may reject historically nonstandard users; this is intentional fail-closed behavior that requires reconciliation before migration.
- This compatibility test does **not** prove unknown-user timing camouflage, tenant/user mapping, audit of failed attempts, external HMAC key custody, distributed lockout, or secret-safe SQL access. The helper is not directly exposed to HTTP.
- No restricted PostgreSQL shadow credential table, reauthentication/epoch fencing, vetted new KDF, SQL role audit, fault-injected PG write, TOTP/passkey key migration, production HTTPS cookies, full SQLite-v7 jobs/secrets migration, off-host restore or cutover/rollback proof exists from this PR.
- The existing PostgreSQL CI-only bcrypt login, SQL 008/009 and default SQLite scrypt login remain separate. No real credentials, production provider operations, account export, data migration or deployment changes were performed.

## Next action

Implement **ADR-0003 Slice B** in a separate limited-scope PR: versioned, private tenant-bound synthetic shadow credential schema and real non-owner negative authorization tests, with no runtime authority change. Complete Slice A's remaining tenant/provenance/HTTP confidentiality tests as part of the authentication boundary design. Preserve SQLite authority until all explicit recovery and security gates pass.
