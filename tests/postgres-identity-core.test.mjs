import assert from "node:assert/strict";
import { test } from "node:test";
import {
  copySyntheticIdentitySnapshot, createPostgresIdentityCoreReader,
} from "../apps/api/postgres-identity-core.mjs";

test("ORB-005: PostgreSQL session lookup uses bound SHA-256 hash and expiration", async () => {
  const calls = [];
  const client = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      return { rows: [{
        id: "user-1", organizationId: "org-one",
        email: "fixture@example.test", role: "owner", mfaEnabled: false,
      }] };
    },
  };
  const reader = createPostgresIdentityCoreReader(client);
  const tokenHash = "a".repeat(64);
  const at = new Date("2026-11-22T00:00:00.000Z");
  const result = await reader.actorForSession({ tokenHash, at });
  assert.equal(result.organizationId, "org-one");
  assert.deepEqual(calls[0].parameters, [tokenHash, at.toISOString()]);
  assert.match(calls[0].sql, /s\.organization_id/);
  assert.match(calls[0].sql, /u\.disabled = FALSE/);
  assert.match(calls[0].sql, /s\.mfa_verified = TRUE/);
});

test("ORB-005: invalid session digests and tenant identifiers fail before SQL", async () => {
  let queries = 0;
  const reader = createPostgresIdentityCoreReader({
    async query() { queries += 1; return { rows: [] }; },
  });
  await assert.rejects(reader.actorForSession({ tokenHash: "raw-session-token" }), /SHA-256/);
  await assert.rejects(reader.actorForSession({
    tokenHash: "f".repeat(64), at: new Date("invalid"),
  }), /valid Date/);
  await assert.rejects(reader.accountForTenant({
    organizationId: "org' OR TRUE --", accountId: "acct",
  }), /identifiers/);
  assert.equal(queries, 0);
});

test("ORB-005: snapshot copy refuses missing explicit fixture-only authorization", async () => {
  await assert.rejects(copySyntheticIdentitySnapshot({
    sqlite: { prepare() { throw new Error("source_accessed"); } },
    postgres: { connect() { throw new Error("pg_accessed"); } },
  }), /explicit_synthetic_offline_copy_required/);
  assert.throws(() => createPostgresIdentityCoreReader({}), /query/);
});
