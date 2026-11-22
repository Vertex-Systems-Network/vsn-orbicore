// Disposable GitHub Compose test only. Use ONE Redis client connection
// for XADD, XREADGROUP (PEL mutation), and WAITAOF fsync confirmation.
import assert from "node:assert/strict";
import { createClient } from "redis";

if (process.env.GITHUB_ACTIONS !== "true") throw new Error("ci_only_redis_aof_fixture");
const redis = createClient({
  url: "redis://127.0.0.1:6379",
  disableOfflineQueue: true,
});
redis.on("error", () => {});
const stream = "orbicore:synthetic:jobs:v1:org-compose-ci";
const group = "orbicore-synthetic-v1";
try {
  await redis.connect();
  assert.equal(await redis.sendCommand(["XGROUP", "CREATE", stream, group, "0", "MKSTREAM"]), "OK");
  const streamId = await redis.sendCommand([
    "XADD", stream, "*", "organization_id", "org-compose-ci", "job_id", "job-compose",
  ]);
  assert.equal(typeof streamId, "string");
  const read = await redis.sendCommand([
    "XREADGROUP", "GROUP", group, "dead-compose-worker", "COUNT", "1", "STREAMS", stream, ">",
  ]);
  assert.ok(read, "consumer group must hold an unacked stream entry");
  const synced = await redis.sendCommand(["WAITAOF", "1", "0", "5000"]);
  assert.equal(Number(synced[0]), 1, "Redis must confirm local AOF fsync");
  const pending = await redis.sendCommand(["XPENDING", stream, group]);
  assert.equal(Number(pending[0]), 1);
  console.log(JSON.stringify({ stream, streamId, aofFsyncConfirmed: true, pendingBeforeRestart: 1 }));
} finally {
  if (redis.isOpen) await redis.close().catch(() => redis.destroy());
}
