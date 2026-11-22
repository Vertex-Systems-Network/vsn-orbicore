import { createPostgresJobRepository } from "./postgres-jobs.mjs";

// Synthetic-only, PostgreSQL-authoritative job runner. Redis Streams carries
// wake-up signals, not credentials, provider commands, or job payloads.
// The worker uses SQL job leases/fencing and rechecks a PostgreSQL actor policy.
// It never opens live cPanel/WHM endpoints.
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GROUP = "orbicore-synthetic-v1";
const assertId = (value, name) => {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new TypeError(name + " must be a valid scoped identifier.");
  }
  return value;
};
function redisFields(raw) {
  if (!Array.isArray(raw) || raw.length % 2) throw new Error("invalid_stream_fields");
  const result = {};
  for (let i = 0; i < raw.length; i += 2) result[raw[i]] = raw[i + 1];
  return result;
}
function parseStreamReply(reply, reclaim) {
  if (!reply) return null;
  // node-redis 6 can decode XREADGROUP as a stream-keyed object;
  // older RESP2 decoders return a nested tuple array.
  const entries = reclaim
    ? (Array.isArray(reply) ? reply[1] : reply?.messages)
    : (Array.isArray(reply) ? reply[0]?.[1] : reply?.[Object.keys(reply)[0]]);
  if (!Array.isArray(entries) || !entries.length) return null;
  const entry = entries[0];
  if (!Array.isArray(entry) || typeof entry[0] !== "string") throw new Error("invalid_stream_entry");
  return { redisId: entry[0], fields: redisFields(entry[1]) };
}

export function createSyntheticRedisJobRunner({
  pool,
  redis,
  organizationId,
  workerId,
  leaseSeconds = 5,
  afterClaim = async () => {},
  rejectionRecorder = null,
}) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new TypeError("A PostgreSQL Pool is required.");
  }
  if (!redis || typeof redis.sendCommand !== "function") {
    throw new TypeError("A Redis client with sendCommand is required.");
  }
  assertId(organizationId, "organizationId");
  assertId(workerId, "workerId");
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) {
    throw new RangeError("leaseSeconds must be an integer between 1 and 3600.");
  }
  if (typeof afterClaim !== "function") throw new TypeError("afterClaim must be a function.");
  if (rejectionRecorder !== null &&
      (typeof rejectionRecorder.record !== "function" ||
       typeof rejectionRecorder.inspect !== "function")) {
    throw new TypeError("rejectionRecorder requires record and inspect methods");
  }
  const stream = "orbicore:synthetic:jobs:v1:" + organizationId;
  const repository = createPostgresJobRepository(pool);

  async function ensureGroup() {
    try {
      await redis.sendCommand(["XGROUP", "CREATE", stream, GROUP, "0", "MKSTREAM"]);
    } catch (error) {
      if (!/BUSYGROUP/.test(String(error?.message ?? ""))) throw error;
    }
  }

  async function publishOne() {
    const client = await pool.connect();
    let open = false;
    try {
      await client.query("BEGIN");
      open = true;
      const selected = await client.query(
        "SELECT id, job_id FROM job_outbox " +
        "WHERE organization_id = $1 AND published_at IS NULL " +
        "ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1",
        [organizationId],
      );
      const event = selected.rows[0];
      if (!event) {
        await client.query("COMMIT");
        open = false;
        return null;
      }
      const redisId = await redis.sendCommand([
        "XADD", stream, "*", "organization_id", organizationId, "job_id", event.job_id,
      ]);
      if (typeof redisId !== "string" || !redisId) throw new Error("redis_publish_failed");
      await client.query(
        "UPDATE job_outbox SET published_at = clock_timestamp(), redis_entry_id = $2, " +
        "publish_attempts = publish_attempts + 1 WHERE id = $1",
        [event.id, redisId],
      );
      await client.query("COMMIT");
      open = false;
      return { jobId: event.job_id, redisId };
    } catch (error) {
      if (open) {
        try { await client.query("ROLLBACK"); } catch { /* preserve original */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  // Redis is non-authoritative: if its stream is lost/truncated, explicitly
  // reconcile old unfinished jobs back to the outbox. Replayed events are
  // harmless because the PG job has a single lease-fenced state transition.
  async function reconcileUnfinished({ olderThanSeconds = 60 } = {}) {
    if (!Number.isInteger(olderThanSeconds) || olderThanSeconds < 1 || olderThanSeconds > 86400) {
      throw new RangeError("olderThanSeconds must be an integer in [1, 86400]");
    }
    const result = await pool.query(
      "UPDATE job_outbox AS o SET published_at = NULL, redis_entry_id = NULL " +
      "FROM jobs AS j WHERE o.job_id = j.id AND o.organization_id = j.organization_id " +
      "AND o.organization_id = $1 AND o.published_at < clock_timestamp() - make_interval(secs => $2) " +
      "AND (j.status = 'queued' OR (j.status = 'running' AND " +
      "(j.lease_expires_at IS NULL OR j.lease_expires_at <= clock_timestamp()))) " +
      "RETURNING o.job_id",
      [organizationId, olderThanSeconds],
    );
    return result.rows.map((row) => row.job_id);
  }

  async function ack(redisId) {
    const count = await redis.sendCommand(["XACK", stream, GROUP, redisId]);
    if (count !== 1) throw new Error("redis_ack_failed");
  }

  async function recordRejectedSignal(redisId, reason) {
    if (rejectionRecorder) {
      await rejectionRecorder.record({organizationId,redisId,reason,workerId});
      return;
    }
    // Never store the untrusted raw Redis fields, job id, password, tenant
    // spoofing string or stream payload. The ID is server-generated metadata.
    const result = await pool.query(
      "INSERT INTO job_signal_rejections " +
      "(organization_id, redis_entry_id, reason, worker_id) " +
      "VALUES ($1, $2, $3, $4) " +
      "ON CONFLICT (organization_id, redis_entry_id) DO UPDATE " +
      "SET occurrences = job_signal_rejections.occurrences + 1, " +
      "last_seen_at = clock_timestamp() " +
      "WHERE job_signal_rejections.reason = EXCLUDED.reason " +
      "RETURNING redis_entry_id",
      [organizationId, redisId, reason, workerId],
    );
    if (!result.rows[0]) throw new Error("signal_rejection_reason_conflict");
  }

  async function inspectRejectedSignals({ limit = 20 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("rejection inspection limit must be in [1,100]");
    }
    if (rejectionRecorder) {
      return rejectionRecorder.inspect({organizationId,limit});
    }
    const result = await pool.query(
      "SELECT reason, occurrences, first_seen_at, last_seen_at " +
      "FROM job_signal_rejections WHERE organization_id = $1 " +
      "ORDER BY last_seen_at DESC, redis_entry_id DESC LIMIT $2",
      [organizationId, limit],
    );
    return result.rows.map((row) => ({
      reason: row.reason, occurrences: row.occurrences,
      firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at,
    }));
  }

  async function processEvent(event) {
    const { redisId, fields } = event;
    if (fields.organization_id !== organizationId || !IDENTIFIER.test(fields.job_id ?? "")) {
      const reason = fields.organization_id !== organizationId
        ? "tenant_mismatch" : "invalid_job_id";
      await recordRejectedSignal(redisId, reason);
      // No ACK until the durable PG reason row has committed. An outage
      // leaves the Redis PEL entry available for safe claim/retry.
      await ack(redisId);
      return { status: "rejected_invalid_signal" };
    }
    const jobId = fields.job_id;
    let record = await repository.getJob({ organizationId, id: jobId });
    if (!record) {
      await recordRejectedSignal(redisId, "missing_job");
      await ack(redisId);
      return { status: "rejected_missing_job" };
    }
    if (record.status === "completed" || record.status === "failed") {
      await ack(redisId);
      return { status: "already_terminal", jobId };
    }

    // Claim ONLY the signaled job. A generic tenant-wide claim could process
    // the wrong job then lose the original Redis event.
    const claim = await pool.query(
      "UPDATE jobs SET status = 'running', attempts = attempts + 1, " +
      "started_at = clock_timestamp(), lease_owner = $3, lease_token = gen_random_uuid(), " +
      "lease_expires_at = clock_timestamp() + make_interval(secs => $4) " +
      "WHERE organization_id = $1 AND id = $2 AND attempts < max_attempts " +
      "AND (status = 'queued' OR (status = 'running' AND " +
      "(lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp()))) " +
      "RETURNING id, lease_token, account_id, requested_by",
      [organizationId, jobId, workerId, leaseSeconds],
    );
    if (!claim.rows[0]) {
      await repository.failExpired({ organizationId });
      record = await repository.getJob({ organizationId, id: jobId });
      if (!record || ["completed", "failed"].includes(record.status)) {
        await ack(redisId);
        return { status: "already_terminal", jobId };
      }
      // A live lease belongs to a different worker; don't ACK its message.
      return { status: "deferred_active_lease", jobId };
    }
    const token = claim.rows[0].lease_token;
    await afterClaim({ organizationId, jobId, token, workerId });

    // Strictly fresh PG-side user/tenant/account checks. No SQLite-identity
    // fallback; absent or revoked users are denied. The fixture policy is
    // deliberately *only* authorized for mock_fixture refresh jobs.
    const policy = await pool.query(
      "SELECT j.account_id FROM jobs AS j " +
      "JOIN accounts AS a ON a.id = j.account_id AND a.organization_id = j.organization_id " +
      "JOIN users AS u ON u.id = j.requested_by AND u.organization_id = j.organization_id " +
      "WHERE j.id = $1 AND j.organization_id = $2 AND j.lease_token = $3 " +
      "AND j.status = 'running' AND j.lease_expires_at > clock_timestamp() " +
      "AND j.type = 'inventory_refresh' AND a.source = 'mock_fixture' " +
      "AND u.disabled = FALSE AND u.role IN ('owner','admin','operator')",
      [jobId, organizationId, token],
    );
    if (!policy.rows[0]) {
      const denied = await pool.query(
        "UPDATE jobs SET status = 'failed', error = 'synthetic_policy_denied', " +
        "completed_at = clock_timestamp(), lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL " +
        "WHERE id = $1 AND organization_id = $2 AND lease_token = $3 AND " +
        "lease_expires_at > clock_timestamp() AND status = 'running' RETURNING id",
        [jobId, organizationId, token],
      );
      if (!denied.rows[0]) return { status: "lost_lease", jobId };
      await ack(redisId);
      return { status: "policy_denied", jobId };
    }

    const completed = await repository.complete({
      organizationId,
      jobId,
      claimToken: token,
      result: {
        source: "mock_fixture",
        live: false,
        accountId: policy.rows[0].account_id,
        processedBy: "synthetic_redis_worker",
      },
    });
    if (!completed) return { status: "lost_lease", jobId };
    await ack(redisId);
    return { status: "completed", jobId };
  }

  async function consumeOne({ reclaim = false, minIdleMs = leaseSeconds * 1000 } = {}) {
    if (!Number.isInteger(minIdleMs) || minIdleMs < 0 || minIdleMs > 86_400_000) {
      throw new RangeError("minIdleMs must be a nonnegative bounded integer.");
    }
    await ensureGroup();
    const reply = reclaim
      ? await redis.sendCommand([
        "XAUTOCLAIM", stream, GROUP, workerId, String(minIdleMs), "0-0", "COUNT", "1",
      ])
      : await redis.sendCommand([
        "XREADGROUP", "GROUP", GROUP, workerId, "COUNT", "1", "STREAMS", stream, ">",
      ]);
    const entry = parseStreamReply(reply, reclaim);
    return entry ? processEvent(entry) : null;
  }

  return Object.freeze({
    stream, group: GROUP, ensureGroup, publishOne, reconcileUnfinished,
    consumeOne, inspectRejectedSignals,
  });
}
