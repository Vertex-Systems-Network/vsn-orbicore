import { createHash, randomUUID } from "node:crypto";

// ORB-004: a PostgreSQL-backed *job* repository, not a replacement for the
// synchronous SQLite authentication/inventory API. The caller injects a
// parameterized-query capable driver/pool; this module performs no network I/O
// until a repository method is called.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_TYPE = "inventory_refresh";

function identifier(value, field) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new TypeError(field + " must be a scoped, nonempty identifier (max 128 chars)");
  }
  return value;
}

function keyHash(organizationId, key) {
  if (typeof key !== "string" || key.length < 1 || key.length > 256) {
    throw new TypeError("idempotencyKey must be between 1 and 256 characters");
  }
  // The PostgreSQL target schema has a globally unique idempotency_key column.
  // Namespace the caller's key so tenants cannot collide on the same raw value.
  return createHash("sha256").update(organizationId).update("\0").update(key).digest("hex");
}

function jobFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    accountId: row.account_id,
    type: row.type,
    requestedBy: row.requested_by,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    error: row.error,
    result: row.result_json,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

const JOB_COLUMNS = "id, organization_id, account_id, type, requested_by, status, attempts, max_attempts, error, result_json, created_at, completed_at";

export function createPostgresJobRepository(database) {
  if (!database || typeof database.query !== "function") {
    throw new TypeError("PostgreSQL repository requires a query(sql, parameters) client");
  }

  async function getJob({ organizationId, id }) {
    identifier(organizationId, "organizationId");
    identifier(id, "id");
    const result = await database.query(
      "SELECT " + JOB_COLUMNS + " FROM jobs WHERE organization_id = $1 AND id = $2",
      [organizationId, id],
    );
    return jobFromRow(result.rows[0]);
  }

  return Object.freeze({
    async enqueue({ organizationId, accountId, requestedBy = null, idempotencyKey, id = randomUUID() }) {
      identifier(organizationId, "organizationId");
      identifier(accountId, "accountId");
      identifier(id, "id");
      if (requestedBy !== null) identifier(requestedBy, "requestedBy");
      const hashedKey = keyHash(organizationId, idempotencyKey);
      const inserted = await database.query(
        "INSERT INTO jobs (id, organization_id, account_id, requested_by, type, status, idempotency_key, created_at) " +
        "VALUES ($1, $2, $3, $4, $5, 'queued', $6, NOW()) " +
        "ON CONFLICT (idempotency_key) DO NOTHING RETURNING " + JOB_COLUMNS,
        [id, organizationId, accountId, requestedBy, JOB_TYPE, hashedKey],
      );
      if (inserted.rows[0]) return { job: jobFromRow(inserted.rows[0]), created: true };

      const existing = await database.query(
        "SELECT " + JOB_COLUMNS + " FROM jobs WHERE organization_id = $1 AND idempotency_key = $2",
        [organizationId, hashedKey],
      );
      const job = jobFromRow(existing.rows[0]);
      if (!job || job.accountId !== accountId || job.type !== JOB_TYPE) {
        throw new Error("idempotency_key_payload_conflict");
      }
      return { job, created: false };
    },

    getJob,

    async claimNext({ organizationId, workerId, leaseSeconds = 30 }) {
      identifier(organizationId, "organizationId");
      identifier(workerId, "workerId");
      if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) {
        throw new RangeError("leaseSeconds must be an integer in [1, 3600]");
      }
      const result = await database.query(
        "SELECT job_id, claim_token, attempt FROM orbicore_claim_job($1, $2, $3)",
        [organizationId, workerId, leaseSeconds],
      );
      if (!result.rows[0]) return null;
      return {
        jobId: result.rows[0].job_id,
        claimToken: result.rows[0].claim_token,
        attempt: result.rows[0].attempt,
      };
    },

    async complete({ organizationId, jobId, claimToken, result = {} }) {
      identifier(organizationId, "organizationId");
      identifier(jobId, "jobId");
      if (typeof claimToken !== "string" || !UUID_PATTERN.test(claimToken)) {
        throw new TypeError("claimToken must be a UUID");
      }
      const payload = JSON.stringify(result);
      if (!payload || payload.length > 65536) throw new RangeError("result JSON exceeds the limit");
      const response = await database.query(
        "SELECT orbicore_complete_job($1, $2, $3::uuid, $4::jsonb) AS completed",
        [organizationId, jobId, claimToken, payload],
      );
      return response.rows[0]?.completed === true;
    },

    async failExpired({ organizationId }) {
      identifier(organizationId, "organizationId");
      const response = await database.query(
        "SELECT orbicore_fail_exhausted_jobs($1) AS failed_count",
        [organizationId],
      );
      return response.rows[0]?.failed_count ?? 0;
    },
  });
}
