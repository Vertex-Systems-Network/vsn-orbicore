# ORB-016/017 — deterministic PG16 archive authentication tamper fixture

**Date:** 2026-11-23 UTC. **State:** First PR #77 services run failed at the negative tamper assertion; deterministic repair committed for rerun. Nothing here proves production backup recovery or key custody.

## Actual failure

At PR #77 SHA `680ecd21`, [PG16/Redis7 service workflow #45197497191](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45197497191) reported failure in job `CI-only encrypted PG16 archive to separate PG16 cluster with globals/RLS`, at step `Run AES-GCM archive and separate disposable PostgreSQL-cluster recovery`, message **`tampered encrypted archive unexpectedly accepted`**. The tested shell line was `printf 'X' | dd ... bs=1 seek=39 ...`: if the randomly generated ciphertext byte at position 39 already has byte value 0x58 (`X`), the file remains identical. An authenticated decrypt then properly succeeds, but the negative test falsely reports a security failure. This possibility is roughly 1 in 256 for uniformly random ciphertext at that byte; the observed failure is consistent with that collision.

## Fix and regression plan

- Replace constant overwrite with a deterministic bitwise XOR of 0x01 at offset 39 (byte 3 of authenticated ciphertext after 8-byte magic, 12-byte nonce, 16-byte GCM tag), leaving the original archive unchanged and guaranteeing a different fixture.
- A pure helper in the CI-only archive module copies the buffer, validates its archive header/length, and flips one bit. Hosted shell calls it before verifying that decryption fails and no restored file is created.
- Two Node regressions exercise an explicit source byte equal to 0x58 (old test's collision), and actual AES-GCM sealed synthetic content: original decrypt succeeds, corrupt decrypt fails authentication.
- Hosted standard CI, relevant PostgreSQL16 service job and PR ledger must rerun on the **final head**. The original failing service result is not counted as a pass.

## Limits

Only the CI synthetic archive authenticity negative test changed. No production encryption key manager, independent immutable storage, offsite/backups, WAL/PITR, live data restore, or admin separation was verified. ORB-016 and ORB-017 remain `testing/integration_tested` despite green tests if rerun succeeds.
