import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../apps/api/server.mjs";
import {
  CI_SOURCE_RECOVERY_HOLD_ERROR,
  installCiSourceHoldWriteGuards,
} from "../apps/api/sqlite-recovery-hold.mjs";

const MARKER = "CREATE TABLE orbicore_ci_active_recovery_hold (marker TEXT)";

test("ORB-004 local app SQLite connection guards every source table from late direct INSERT after a hold", () => {
  const folder = mkdtempSync(join(tmpdir(), "orb-ci-hold-triggers-"));
  let app, external;
  try {
    const dbPath = join(folder, "source.sqlite");
    app = createApp({ dbPath, startWorker: false, bootstrapToken: "ci-trigger-test-token" });
    const tables = app.db.prepare(
      "SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'orbicore_ci_active_recovery_hold' ORDER BY name",
    ).all().map((entry) => entry.name);
    assert.ok(tables.length >= 20, "protect the complete SQLite v7 source table surface");
    const triggers = app.db.prepare(
      "SELECT name, tbl_name AS tableName FROM sqlite_temp_master WHERE type='trigger' AND name LIKE 'orbicore_ci_hold_%'",
    ).all();
    assert.equal(triggers.length, tables.length * 3);
    for (const table of tables) {
      assert.equal(triggers.filter((x) => x.tableName === table).length, 3, table);
    }
    // Without a marker, normal direct SQLite operations remain available.
    app.db.prepare("UPDATE accounts SET health = health WHERE id='acct-northstar'").run();
    external = new DatabaseSync(dbPath);
    external.exec(MARKER);

    for (const table of tables) {
      const safeName = '"' + table.replaceAll('"', '""') + '"';
      assert.throws(
        () => app.db.prepare(`INSERT INTO ${safeName} DEFAULT VALUES`).run(),
        (error) => error.message.includes(CI_SOURCE_RECOVERY_HOLD_ERROR),
        `direct insert into ${table} must be denied`,
      );
    }
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0);
  } finally {
    external?.close();
    app?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("ORB-004 marker blocks UPDATE/DELETE on populated source tables even when bypassing API and worker", () => {
  const folder = mkdtempSync(join(tmpdir(), "orb-ci-hold-dml-"));
  let app, external;
  try {
    const dbPath = join(folder, "source.sqlite");
    app = createApp({ dbPath, startWorker: false, bootstrapToken: "ci-trigger-test-token" });
    const before = app.db.prepare(
      "SELECT health, used_bytes FROM accounts WHERE id='acct-northstar'",
    ).get();
    external = new DatabaseSync(dbPath);
    external.exec(MARKER);
    const attempts = [
      "UPDATE accounts SET health='offline' WHERE id='acct-northstar'",
      "DELETE FROM accounts WHERE id='acct-northstar'",
      "UPDATE schema_migrations SET name='corrupted' WHERE version=7",
      "DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events LIMIT 1)",
    ];
    for (const sql of attempts.slice(0, 3)) {
      assert.throws(
        () => app.db.exec(sql),
        (error) => error.message.includes(CI_SOURCE_RECOVERY_HOLD_ERROR),
        sql,
      );
    }
    assert.deepEqual(app.db.prepare(
      "SELECT health, used_bytes FROM accounts WHERE id='acct-northstar'",
    ).get(), before);
    assert.equal(app.db.prepare("SELECT name FROM schema_migrations WHERE version=7").get().name,
      "secret_references_and_deployment_readiness");
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, 3);
    // TEMP guards do not protect unrelated SQLite connections. Such external
    // forensic writes remain separately audited; this is not WORM storage.
    external.prepare("UPDATE accounts SET health='offline' WHERE id='acct-northstar'").run();
    assert.equal(app.db.prepare("SELECT health FROM accounts WHERE id='acct-northstar'").get().health, "offline");
  } finally {
    external?.close();
    app?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("ORB-004 connection guard installer rejects missing SQLite source before executing DDL", () => {
  assert.throws(() => installCiSourceHoldWriteGuards(null), /sqlite_source_required/);
  assert.throws(() => installCiSourceHoldWriteGuards({ prepare() {} }), /sqlite_source_required/);
});
