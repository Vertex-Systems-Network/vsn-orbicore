import { createPostgresJobRepository } from "./postgres-jobs.mjs";

// ORB-004: enqueue and durable notification intent in ONE PostgreSQL
// transaction. This decorator requires a pg.Pool-like connection provider.
// It intentionally never emits a Redis event before COMMIT.
export function createTransactionalOutboxJobRepository(pool) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new TypeError("Transactional job outbox requires a PostgreSQL connection pool.");
  }
  const base = createPostgresJobRepository(pool);

  return Object.freeze({
    ...base,
    async enqueue(input) {
      const connection = await pool.connect();
      let inTransaction = false;
      try {
        await connection.query("BEGIN");
        inTransaction = true;
        const result = await createPostgresJobRepository(connection).enqueue(input);
        if (result.created) {
          // Outbox insert failure MUST roll back the newly-created job. Exactly
          // one durable intent per job; duplicate idempotency keys do not emit.
          await connection.query(
            "INSERT INTO job_outbox (job_id, organization_id) VALUES ($1, $2)",
            [result.job.id, result.job.organizationId],
          );
        }
        await connection.query("COMMIT");
        inTransaction = false;
        return result;
      } catch (error) {
        if (inTransaction) {
          try { await connection.query("ROLLBACK"); } catch { /* original error wins */ }
        }
        throw error;
      } finally {
        connection.release();
      }
    },
  });
}
