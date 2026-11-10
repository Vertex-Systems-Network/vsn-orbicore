# Authenticator operations: backup, recovery, and key rotation

**Status:** Operational guidance with a blocked rotation procedure. The application does not yet ship a key-rotation command or a verified restore workflow. Do not treat the design steps below as an executable production runbook.

## What is stored

- TOTP seeds are encrypted with AES-256-GCM using `ORBICORE_MFA_ENCRYPTION_KEY`. Changing this environment variable without re-encrypting the stored seeds makes those authenticators unreadable.
- Recovery codes are stored as one-way hashes. The original codes are shown once at enrollment and must be kept by the account owner in a secure offline location.
- Passkey credential public keys, counters, transports, and device/backup metadata are stored in the application database. Private authenticator keys remain with the authenticator.
- The current notification outbox marks recovery notices `blocked_unverified_contact`. This does not mean an email or other notice was sent.

## Backup controls

1. Back up the application database using a SQLite-aware, transaction-consistent backup method. Do not copy only the live database file while WAL writes may be active.
2. Back up the exact TOTP encryption key separately in an approved secret manager with restricted access and a recorded key version. Never commit it, put it in a database backup, or send it through ordinary email/chat.
3. Protect database backups with encryption, access logging, retention limits, and a restore owner. Keep database and key backups available together for a restore, but store them under separate access controls.
4. Record the backup timestamp, database identity, key version, and restore-check outcome without recording secret values.
5. Test restoration in an isolated environment with synthetic accounts before relying on a backup. No automated restore check currently ships; until one is added and exercised, mark restore capability unverified.

## Key rotation: blocked until tooling exists

Do not rotate by replacing `ORBICORE_MFA_ENCRYPTION_KEY` alone. That would make all existing encrypted TOTP seeds undecryptable.

Before rotation is enabled, implement and test a reviewed migration utility that:

- takes the old and new keys from a secret manager without logging them;
- decrypts each seed with authenticated AES-GCM and re-encrypts it with a fresh nonce under the new key;
- uses a transaction or staged, verified migration that can be rolled back from a protected pre-rotation backup;
- verifies every row and records counts/key-version metadata without exposing plaintext;
- fails closed on any authentication-tag error or unexpected record and leaves the old key available for rollback;
- is tested against a disposable database, including corrupted ciphertext and interrupted migration.

After that utility passes, a controlled rotation can stop writes, take and verify a consistent database backup, run the utility, verify counts, switch the service to the new key, perform a TOTP verification in the isolated validation account, and keep the old key in restricted rollback escrow until the recovery window ends. This sequence is a future gate, not a currently supported command sequence.

## Lost-device and account recovery

- A signed-in owner/admin can register more than one passkey. Keep at least two independently available authenticators where possible.
- A lost passkey can be revoked only after password reauthentication in the current recovery UI. If MFA is enabled, the session must also have passed the configured MFA gate. Register a replacement from the same signed-in security panel.
- If the user still has a TOTP authenticator, use it to satisfy MFA. If not, use one saved, unused recovery code once; the current recovery endpoint revokes existing sessions and records an undelivered notice.
- If the user loses the password, TOTP device, passkeys, and all recovery codes, the application has no supported self-service recovery path. Do not bypass the checks by editing production database rows.
- Verified email/contact setup and delivery are not implemented. Until a delivery provider and contact verification flow are tested, recovery notification remains blocked and must not be represented as sent.

## Release gate

This document does not authorize provider credentials or production exposure. Before either is considered, implement key-rotation/restore tooling, verified notification delivery, a documented owner recovery process, and browser authenticator verification; record evidence in the project state.
