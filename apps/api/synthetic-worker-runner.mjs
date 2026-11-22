import { Pool } from "pg";
import { createClient } from "redis";
import { createSyntheticRedisJobRunner } from "./synthetic-redis-worker.mjs";
import { syntheticCycleBackoffMs } from "./synthetic-worker-backoff.mjs";
import { createPostgresJobRepository } from "./postgres-jobs.mjs";

// Run separately from the HTTP API. This worker executes only *synthetic*
// fixture jobs, never live cPanel/WHM actions. No provider secrets required.
// Keep disabled until an operator explicitly opts into synthetic-only mode.
if (process.env.ORBICORE_ENABLE_SYNTHETIC_REDIS_WORKER !== "1") {
  throw new Error("synthetic_worker_opt_in_required");
}
const organizationId = process.env.ORBICORE_WORKER_ORGANIZATION_ID;
const workerId = process.env.ORBICORE_WORKER_ID ?? "synthetic-" + process.pid;
const pool = new Pool({
  host: process.env.PGHOST ?? "127.0.0.1",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "orbicore",
  database: process.env.PGDATABASE ?? "orbicore",
  password: process.env.PGPASSWORD,
  max: 3,
  connectionTimeoutMillis: 5000,
});
const redis = createClient({
  url: process.env.ORBICORE_REDIS_URL ?? "redis://127.0.0.1:6379",
  disableOfflineQueue: true,
});
redis.on("error", () => { /* error surfaced by awaited commands */ });
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failedCycles = 0;
let completedCycles = 0;
try {
  await redis.connect();
  const runner = createSyntheticRedisJobRunner({
    pool, redis, organizationId, workerId, leaseSeconds: 5,
  });
  const repository = createPostgresJobRepository(pool);
  await runner.ensureGroup();

  async function cycle() {
    // PostgreSQL is authoritative; Redis carries at-least-once notifications.
    const reconciled = await runner.reconcileUnfinished({ olderThanSeconds: 60 });
    const published = await runner.publishOne();
    const fresh = await runner.consumeOne();
    const recovered = await runner.consumeOne({ reclaim: true, minIdleMs: 5000 });
    const exhausted = await repository.failExpired({ organizationId });
    completedCycles += 1;
    return { published: Boolean(published), processed: fresh?.status ?? recovered?.status ?? null,
      reconciled: reconciled.length, exhausted };
  }

  if (process.env.ORBICORE_WORKER_ONCE === "1") {
    const result = await cycle();
    console.log(JSON.stringify({ mode: "synthetic_only", ...result }));
  } else {
    while (!stopping) {
      try {
        await cycle();
        failedCycles = 0;
      } catch {
        // Do not log raw driver errors, SQL text, credentials or job payloads.
        failedCycles += 1;
        console.error("synthetic_job_cycle_failed");
      }
      if (stopping) break;
      await delay(syntheticCycleBackoffMs(failedCycles));
    }
  }
} finally {
  if (redis.isOpen) await redis.close().catch(() => redis.destroy());
  await pool.end();
}
