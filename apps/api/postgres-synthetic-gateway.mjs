// A narrowly privileged PostgreSQL *synthetic-only* job submission gateway.
// No normal HTTP route uses this yet. A future authorized deployment must
// connect with a role that can SET ROLE orbicore_synthetic_submitter but has
// no schema-owner/superuser capability; CI currently uses a disposable owner.
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function createPostgresSyntheticSubmissionGateway(pool) {
  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError("Synthetic gateway requires a PostgreSQL Pool");
  }

  return Object.freeze({
    async sessionTenant({ tokenHash }) {
      if (typeof tokenHash !== "string" || !SHA256.test(tokenHash)) {
        throw new TypeError("tokenHash must be a lowercase SHA-256 hex digest");
      }
      const connection = await pool.connect();
      let open = false;
      try {
        await connection.query("BEGIN");
        open = true;
        await connection.query("SET LOCAL ROLE orbicore_synthetic_submitter");
        const result = await connection.query(
          "SELECT organization_id FROM public.orbicore_probe_synthetic_session($1)",
          [tokenHash],
        );
        const org = result.rows?.[0]?.organization_id ?? null;
        if (org !== null && (typeof org !== "string" || !ID.test(org))) {
          throw new Error("synthetic_gateway_invalid_session_scope");
        }
        await connection.query("COMMIT");
        open = false;
        return org;
      } catch (error) {
        if (open) {
          try { await connection.query("ROLLBACK"); } catch { /* preserve reason */ }
        }
        throw error;
      } finally {
        connection.release();
      }
    },

    async enqueue({ tokenHash, organizationId, accountId, idempotencyKey }) {
      if (typeof tokenHash !== "string" || !SHA256.test(tokenHash)) {
        throw new TypeError("tokenHash must be a lowercase SHA-256 hex digest");
      }
      if (typeof organizationId !== "string" || !ID.test(organizationId) ||
          typeof accountId !== "string" || !ID.test(accountId)) {
        throw new TypeError("organizationId/accountId must be scoped identifiers");
      }
      if (typeof idempotencyKey !== "string" ||
          idempotencyKey.length < 1 || idempotencyKey.length > 256) {
        throw new TypeError("idempotencyKey must contain 1-256 characters");
      }
      const connection = await pool.connect();
      let open = false;
      try {
        await connection.query("BEGIN");
        open = true;
        // SET LOCAL ROLE intentionally restricts even the CI schema-owner
        // connection to EXECUTE-only. It does not accept caller role or SQL.
        await connection.query("SET LOCAL ROLE orbicore_synthetic_submitter");
        const result = await connection.query(
          'SELECT job_id AS "jobId", created FROM ' +
          "public.orbicore_submit_synthetic_inventory($1,$2,$3,$4)",
          [tokenHash, organizationId, accountId, idempotencyKey],
        );
        if (!result.rows?.[0]?.jobId ||
            typeof result.rows[0].created !== "boolean") {
          throw new Error("synthetic_gateway_invalid_response");
        }
        await connection.query("COMMIT");
        open = false;
        return Object.freeze({
          jobId: result.rows[0].jobId,
          created: result.rows[0].created,
          source: "mock_fixture",
          live: false,
        });
      } catch (error) {
        if (open) {
          try { await connection.query("ROLLBACK"); } catch { /* preserve reason */ }
        }
        throw error;
      } finally {
        connection.release();
      }
    },
  });
}
