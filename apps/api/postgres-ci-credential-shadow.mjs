import { randomBytes, scryptSync } from "node:crypto";
import { verifyLegacySqliteScryptPassword } from "./legacy-scrypt-verifier.mjs";

// CI-only, NOT imported by server.mjs or any HTTP/worker runtime. This KDF
// profile is an experimental OWASP scrypt fallback for disposable fixtures,
// not an approved production KDF choice. Argon2id/benchmarks remain open.
export const CI_SHADOW_KDF = Object.freeze({
  version: "scrypt-n32768-r8-p3-v1",
  N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024, keyLength: 64,
});
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY = /^[0-9a-f]{64}$/;
const SYNTHETIC_EMAIL = /^[^\s@]+@[^\s@]+\.(test|invalid)$/i;

export function createCiReauthenticationShadowPilot({ sqlite, postgres } = {}) {
  if (process.env.GITHUB_ACTIONS !== "true" ||
      process.env.ORBICORE_CI_SYNTHETIC_REAUTH !== "1" ||
      process.env.ORBICORE_CI_SYNTHETIC_SHADOW_SCHEMA !== "1") {
    throw new Error("ci_shadow_reauthentication_explicit_gate_required");
  }
  if (!sqlite || typeof sqlite.prepare !== "function" ||
      typeof sqlite.exec !== "function" ||
      !postgres || typeof postgres.connect !== "function") {
    throw new TypeError("ci_shadow_requires_sqlite_and_restricted_postgres_pool");
  }

  async function stage({ userId, password, expectedSourceEpoch, idempotencyKey } = {}) {
    if (typeof userId !== "string" || !ID.test(userId) ||
        typeof password !== "string" || password.length < 8 ||
        password.length > 256 ||
        !Number.isSafeInteger(expectedSourceEpoch) || expectedSourceEpoch < 1 ||
        typeof idempotencyKey !== "string" || !KEY.test(idempotencyKey)) {
      return false;
    }
    let sqliteOpen = false;
    let client;
    let pgOpen = false;
    try {
      // Locks the source fixture during verification and PG draft staging.
      // It is NOT an atomic transaction with PG, not a production pattern.
      sqlite.exec("BEGIN IMMEDIATE");
      sqliteOpen = true;
      const source = sqlite.prepare(
        "SELECT id, organization_id, email, password_salt, password_hash, " +
        "role, disabled, mfa_enabled FROM users WHERE id=?",
      ).get(userId);
      const epoch = sqlite.prepare(
        "SELECT epoch FROM ci_source_credential_epoch WHERE user_id=?",
      ).get(userId);
      if (!source || source.disabled !== 0 || source.mfa_enabled !== 0 ||
          !ID.test(source.organization_id) ||
          !SYNTHETIC_EMAIL.test(source.email) ||
          !["owner", "admin", "operator", "viewer"].includes(source.role) ||
          !epoch || epoch.epoch !== expectedSourceEpoch ||
          !verifyLegacySqliteScryptPassword({
            password, passwordSalt: source.password_salt,
            passwordHash: source.password_hash,
          })) {
        sqlite.exec("ROLLBACK");
        sqliteOpen = false;
        return false;
      }

      // Fresh salt is RAW bytes for the *new* profile, unlike the legacy
      // UTF-8 hex-text salt. Only a derived synthetic verifier goes to PG.
      const salt = randomBytes(24);
      const digest = scryptSync(password, salt, CI_SHADOW_KDF.keyLength, {
        N: CI_SHADOW_KDF.N, r: CI_SHADOW_KDF.r, p: CI_SHADOW_KDF.p,
        maxmem: CI_SHADOW_KDF.maxmem,
      }).toString("hex");
      client = await postgres.connect();
      await client.query("BEGIN");
      pgOpen = true;
      await client.query("SET LOCAL ROLE orbicore_ci_shadow_writer");
      const result = await client.query(
        "SELECT orbicore_ci_shadow.stage_reauth_draft(" +
        "$1,$2,$3,$4,$5,$6,$7,$8) AS staged",
        [source.organization_id,source.id,source.email,source.role,
          expectedSourceEpoch,idempotencyKey,salt.toString("hex"),digest],
      );
      await client.query("COMMIT");
      pgOpen = false;
      sqlite.exec("COMMIT");
      sqliteOpen = false;
      return result.rows[0]?.staged === true;
    } catch {
      if (pgOpen && client) {
        try { await client.query("ROLLBACK"); } catch { /* preserve denial */ }
      }
      if (sqliteOpen) {
        try { sqlite.exec("ROLLBACK"); } catch { /* preserve denial */ }
      }
      // No SQL detail, password, hash, user or tenant leaked to the caller.
      throw new Error("ci_shadow_stage_unavailable");
    } finally {
      if (client) client.release();
    }
  }
  return Object.freeze({ stage });
}
