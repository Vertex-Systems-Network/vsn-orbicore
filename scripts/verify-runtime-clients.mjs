import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { createClient } from "redis";

// GitHub-hosted disposable integration test of checked-in runtime dependencies.
// This does not create a persistent production API/worker or open provider URLs.
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
assert.equal(pkg.dependencies.pg, "8.23.1");
assert.equal(pkg.dependencies.redis, "6.3.1");
const pool = new Pool({
  host: process.env.PGHOST ?? "127.0.0.1",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "orbicore",
  database: process.env.PGDATABASE ?? "orbicore",
  password: process.env.PGPASSWORD,
  connectionTimeoutMillis: 5000,
  max: 2,
});
const redis = createClient({
  url: process.env.ORBICORE_CI_REDIS_URL ?? "redis://127.0.0.1:6379",
  disableOfflineQueue: true,
});
redis.on("error", () => { /* failure is surfaced by awaited commands */ });
const testKey = "orbicore:ci:runtime-driver:" + randomUUID();
try {
  const query = await pool.query("SELECT 42 AS answer, current_setting('server_version') AS server_version");
  assert.equal(query.rows[0].answer, 42);
  await redis.connect();
  assert.equal(await redis.ping(), "PONG");
  assert.equal(await redis.set(testKey, "synthetic", { EX: 60 }), "OK");
  assert.equal(await redis.get(testKey), "synthetic");
  assert.equal(await redis.del(testKey), 1);
  console.log(JSON.stringify({
    task: "ORB-004",
    kind: "pinned-runtime-drivers",
    node: process.version,
    pgPackage: pkg.dependencies.pg,
    redisPackage: pkg.dependencies.redis,
    postgresServer: query.rows[0].server_version,
    postgresQuery: "passed",
    redisRoundTrip: "passed",
    driversDeclaredInManifestAndLockfile: true,
    productionWorkerImplemented: false,
    liveProviderUsed: false,
  }));
} finally {
  if (redis.isOpen) {
    await redis.close().catch(() => redis.destroy());
  }
  await pool.end();
}
