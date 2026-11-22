import assert from "node:assert/strict";
import { test } from "node:test";
import {
  copySyntheticIdentityWithAuthSnapshot,
} from "../apps/api/postgres-identity-core.mjs";

test("ORB-005: extended auth copy demands distinct explicit consent", async () => {
  const sqlite = { prepare() { throw new Error("source_read"); } };
  const postgres = { connect() { throw new Error("pg_connected"); } };
  await assert.rejects(
    copySyntheticIdentityWithAuthSnapshot({ sqlite, postgres }),
    /explicit_synthetic_offline_copy_required/,
  );
  await assert.rejects(
    copySyntheticIdentityWithAuthSnapshot({
      sqlite, postgres, consent: "fixture_only_offline_copy",
    }),
    /explicit_synthetic_offline_copy_required/,
  );
});

test("ORB-005: extended importer validates original adapter types before storage access", async () => {
  await assert.rejects(
    copySyntheticIdentityWithAuthSnapshot({
      sqlite: {}, postgres: { connect() {} },
      consent: "fixture_only_auth_offline_copy",
    }),
    /SQLite DatabaseSync/,
  );
  await assert.rejects(
    copySyntheticIdentityWithAuthSnapshot({
      sqlite: { prepare() {}, exec() {} }, postgres: {},
      consent: "fixture_only_auth_offline_copy",
    }),
    /PostgreSQL Pool/,
  );
});
