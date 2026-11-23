import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../apps/api/server.mjs";

const fixture = JSON.parse(readFileSync(resolve("apps/api/fixtures/cpanel-uapi-inventory.json"), "utf8"));
const tables = (db) => db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
).all().map((row) => row.name);

test("ORB-004 failed second-account fixture rolls back every schema and seed row atomically", () => {
  const folder = mkdtempSync(join(tmpdir(), "orb-atomic-initialization-"));
  const dbPath = join(folder, "source.sqlite");
  const wrongFixture = join(folder, "bad-fixture.json");
  let db, app;
  try {
    const malformed = structuredClone(fixture);
    assert.ok(malformed.accounts.length >= 2);
    malformed.accounts[1].usedBytes = -99;
    writeFileSync(wrongFixture, JSON.stringify(malformed));
    assert.throws(
      () => createApp({ dbPath, fixturePath: wrongFixture, startWorker: false, bootstrapToken: "ci-invalid-fixture" }),
      /CHECK constraint failed/,
    );
    db = new DatabaseSync(dbPath);
    assert.deepEqual(tables(db), [], "failed seed must not expose partially-created schema or migration rows");
    db.close(); db = null;

    app = createApp({ dbPath, startWorker: false, bootstrapToken: "ci-valid-fixture" });
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, fixture.accounts.length);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get().n, 7);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM organizations").get().n, 1);
  } finally {
    app?.close(); db?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("ORB-004 failed legacy-schema repair cannot persist partial ALTER TABLE or migration metadata", () => {
  const folder = mkdtempSync(join(tmpdir(), "orb-atomic-legacy-upgrade-"));
  const dbPath = join(folder, "legacy.sqlite");
  let db;
  try {
    db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE accounts(id TEXT PRIMARY KEY)");
    db.close(); db = null;

    assert.throws(
      () => createApp({ dbPath, startWorker: false, bootstrapToken: "ci-legacy-schema" }),
      /no column named label/,
      "synthetic malformed legacy schema must fail after attempted migrations",
    );
    db = new DatabaseSync(dbPath);
    assert.deepEqual(tables(db), ["accounts"], "all newly created SQLite schema must roll back");
    assert.deepEqual(db.prepare("PRAGMA table_info(accounts)").all().map((x) => x.name), ["id"],
      "attempted organization_id/capability_profile ALTERs must roll back");
  } finally {
    db?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("ORB-004 successful clean and reopened SQLite source preserve fixture and migration idempotency", () => {
  const folder = mkdtempSync(join(tmpdir(), "orb-atomic-success-restart-"));
  const dbPath = join(folder, "source.sqlite");
  let app;
  try {
    app = createApp({ dbPath, startWorker: false, bootstrapToken: "ci-valid-fixture" });
    const firstCount = app.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n;
    const firstMigrations = app.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
    assert.deepEqual(firstMigrations.map((x) => x.version), [1, 2, 3, 4, 5, 6, 7]);
    app.close(); app = null;
    app = createApp({ dbPath, startWorker: false, bootstrapToken: "ci-valid-fixture" });
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, firstCount);
    assert.deepEqual(app.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all(), firstMigrations);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0);
  } finally {
    app?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
