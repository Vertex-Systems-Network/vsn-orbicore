import { createHash, randomBytes } from "node:crypto";
import { recoveryCodeHash } from "./mfa.mjs";

// This adapter has no production app import. It uses only EXECUTE-only
// PostgreSQL functions on a dedicated non-owner pool; no password hashes,
// recovery codes, or plaintext session tokens are selected from SQL.
const HEX = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const CODES = /^[A-Za-z0-9_-]{12,128}$/;
const sha = (value) => createHash("sha256").update(value).digest("hex");

export function createPostgresCiLoginAdapter(pool) {
  if (process.env.GITHUB_ACTIONS !== "true" ||
      process.env.ORBICORE_CI_SYNTHETIC_PG_LOGIN !== "1") {
    throw new Error("postgres_fixture_login_ci_only");
  }
  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError("A restricted PostgreSQL pool is required");
  }

  async function restricted(sql, args) {
    const connection = await pool.connect();
    let open = false;
    try {
      await connection.query("BEGIN");
      open = true;
      await connection.query("SET LOCAL ROLE orbicore_synthetic_submitter");
      const result = await connection.query(sql, args);
      await connection.query("COMMIT");
      open = false;
      return result.rows[0];
    } catch (error) {
      if (open) {
        try { await connection.query("ROLLBACK"); } catch { /* original error */ }
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  return Object.freeze({
    async login({ email, password }) {
      if (typeof email !== "string" || email.length > 254 ||
          !EMAIL.test(email.trim()) ||
          typeof password !== "string" ||
          password.length < 8 || password.length > 128) {
        return {accepted:false,rateLimited:false};
      }
      const token = randomBytes(32).toString("base64url");
      const row = await restricted(
        "SELECT accepted, needs_mfa, tenant_id, rate_limited " +
          "FROM public.orbicore_ci_password_login($1,$2,$3)",
        [email.trim().toLowerCase(),password,sha(token)],
      );
      if (!row || row.accepted !== true) {
        return {accepted:false,rateLimited:row?.rate_limited === true};
      }
      if (typeof row.tenant_id !== "string" ||
          typeof row.needs_mfa !== "boolean") {
        throw new Error("postgres_fixture_invalid_login_result");
      }
      return {
        accepted:true,mfaRequired:row.needs_mfa,
        token,tenantId:row.tenant_id,
      };
    },

    async finishRecoveryMfa({ token, code }) {
      if (typeof token !== "string" || !TOKEN.test(token) ||
          typeof code !== "string" || !CODES.test(code)) {
        return {accepted:false};
      }
      const newToken = randomBytes(32).toString("base64url");
      const row = await restricted(
        "SELECT public.orbicore_ci_finish_recovery_mfa($1,$2,$3) AS accepted",
        [sha(token),sha(newToken),recoveryCodeHash(code)],
      );
      return row?.accepted === true
        ? {accepted:true,token:newToken}
        : {accepted:false};
    },

    async revoke({ token }) {
      if (typeof token !== "string" || !TOKEN.test(token)) return false;
      const row = await restricted(
        "SELECT public.orbicore_ci_revoke_session($1) AS revoked",
        [sha(token)],
      );
      return row?.revoked === true;
    },
  });
}
