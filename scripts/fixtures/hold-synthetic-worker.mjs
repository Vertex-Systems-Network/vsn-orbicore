// CI-only crash fixture. Parent process sends SIGKILL after the real worker
// claims a PostgreSQL row but before it can complete/ACK the Redis entry.
import { Pool } from "pg";
import { createClient } from "redis";
import { createSyntheticRedisJobRunner } from "../../apps/api/synthetic-redis-worker.mjs";

if (process.env.ORBICORE_CI_CRASH_FIXTURE !== "1") throw new Error("fixture_not_enabled");
const pool = new Pool({
  host: process.env.PGHOST ?? "127.0.0.1",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "orbicore",
  database: process.env.PGDATABASE ?? "orbicore",
  password: process.env.PGPASSWORD,
  connectionTimeoutMillis: 5000,
});
const redis = createClient({
  url: "redis://127.0.0.1:6379",
  disableOfflineQueue: true,
});
redis.on("error", () => {});
await redis.connect();
const runner = createSyntheticRedisJobRunner({
  pool,
  redis,
  organizationId: process.env.ORBICORE_CI_ORG,
  workerId: "crash-fixture-child",
  leaseSeconds: 5,
  afterClaim: async ({ jobId }) => {
    if (process.send) process.send({ stage: "claimed", jobId });
    await new Promise(() => {}); // deliberately wait for parent SIGKILL
  },
});
await runner.consumeOne();
throw new Error("unexpected_worker_return");
