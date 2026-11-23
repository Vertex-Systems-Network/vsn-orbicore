import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../apps/api/server.mjs";

const marker = "CREATE TABLE orbicore_ci_active_recovery_hold (marker TEXT)";

test("ORB-004 startup rejects CI hold before creating schema/seed rows in held partial source", () => {
  const folder = mkdtempSync(join(tmpdir(), "orb-ci-pre-schema-hold-"));
  let initial;
  try {
    const dbPath = join(folder, "source.sqlite");
    initial = new DatabaseSync(dbPath);
    initial.exec(marker);
    initial.exec("CREATE TABLE forensic_checkpoint (value TEXT NOT NULL)");
    initial.prepare("INSERT INTO forensic_checkpoint(value) VALUES(?)").run("immutable-fixture-snapshot");
    initial.close();
    initial = null;

    assert.throws(() => createApp({
      dbPath, startWorker: false, bootstrapToken: "ci-no-schema-hold",
    }), /ci_sqlite_source_recovery_hold_manual_review_required/);

    const check = new DatabaseSync(dbPath);
    try {
      const names = check.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(x => x.name);
      assert.deepEqual(names, ["forensic_checkpoint", "orbicore_ci_active_recovery_hold"]);
      assert.equal(check.prepare("SELECT value FROM forensic_checkpoint").get().value, "immutable-fixture-snapshot");
    } finally { check.close(); }
  } finally {
    initial?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("ORB-004 startup rejects held SQLite before repairing deleted migration manifest", () => {
  const folder = mkdtempSync(join(tmpdir(), "orb-ci-held-migrations-"));
  const dbPath = join(folder, "source.sqlite");
  let app, check;
  try {
    app = createApp({ dbPath, startWorker: false, bootstrapToken: "ci-migration-test" });
    app.db.prepare("DELETE FROM schema_migrations").run();
    app.close();
    app = null;
    check = new DatabaseSync(dbPath);
    check.exec(marker);
    check.close();
    check = null;

    assert.throws(() => createApp({
      dbPath, startWorker: false, bootstrapToken: "ci-migration-test",
    }), /ci_sqlite_source_recovery_hold_manual_review_required/);
    check = new DatabaseSync(dbPath);
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get().n, 0);
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, 3);
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM audit_events").get().n, 0);
  } finally {
    check?.close();
    app?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
