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

test("ORB-004 persistent SQLite guards every source table from late direct INSERT after a hold", () => {
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
      "SELECT name, tbl_name AS tableName FROM main.sqlite_master WHERE type='trigger' AND name LIKE 'orbicore_ci_hold_%'",
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
    // Main-schema triggers must also stop this independent SQLite connection.
    assert.throws(
      () => external.prepare("UPDATE accounts SET health='offline' WHERE id='acct-northstar'").run(),
      (error) => error.message.includes(CI_SOURCE_RECOVERY_HOLD_ERROR),
      "a second connection must not bypass a durable source hold",
    );
    assert.equal(app.db.prepare("SELECT health FROM accounts WHERE id='acct-northstar'").get().health,
      before.health);

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

test("ORB-004 persistent hold triggers survive app restart and reject separate connections without app runtime", () => {
  const folder = mkdtempSync(join(tmpdir(), "orb-ci-cross-connection-"));
  const dbPath = join(folder, "source.sqlite");
  let app, source, separate;
  try {
    app = createApp({ dbPath, startWorker: false, bootstrapToken: "ci-durable-hold-test" });
    const expectedTriggers = app.db.prepare(
      "SELECT COUNT(*) AS n FROM main.sqlite_master WHERE type='trigger' AND name LIKE 'orbicore_ci_hold_%'",
    ).get().n;
    assert.ok(expectedTriggers >= 60);
    app.close(); app = null;

    source = new DatabaseSync(dbPath);
    assert.equal(source.prepare(
      "SELECT COUNT(*) AS n FROM main.sqlite_master WHERE type='trigger' AND name LIKE 'orbicore_ci_hold_%'",
    ).get().n, expectedTriggers);
    source.exec(MARKER);
    separate = new DatabaseSync(dbPath);
    const attemptedDml = [
      "INSERT INTO organizations (id, name, created_at) VALUES ('ci-new', 'bad', '2026-11-23')",
      "UPDATE accounts SET health='offline' WHERE id='acct-northstar'",
      "DELETE FROM schema_migrations WHERE version=7",
    ];
    for (const sql of attemptedDml) {
      assert.throws(
        () => separate.exec(sql),
        (err) => err.message.includes(CI_SOURCE_RECOVERY_HOLD_ERROR),
        sql,
      );
    }
    assert.equal(separate.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, 3);
    assert.equal(separate.prepare("SELECT COUNT(*) AS n FROM organizations").get().n, 1);
    assert.equal(separate.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get().n, 7);
    assert.throws(
      () => createApp({ dbPath, startWorker: false, bootstrapToken: "ci-reopen" }),
      /ci_sqlite_source_recovery_hold_manual_review_required/,
    );
  } finally {
    separate?.close(); source?.close(); app?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("ORB-004 stable persistent trigger names and counts survive idempotent restart", () => {
  const folder = mkdtempSync(join(tmpdir(), "orb-ci-stable-trigger-names-"));
  const dbPath = join(folder, "source.sqlite");
  let app, other;
  try {
    app = createApp({ dbPath, startWorker: false, bootstrapToken: "ci-guard-names" });
    const list = () => app.db.prepare(
      "SELECT name, tbl_name AS tableName FROM main.sqlite_master WHERE type='trigger' AND name LIKE 'orbicore_ci_hold_%' ORDER BY name",
    ).all();
    const first = list();
    assert.equal(first.length, new Set(first.map(x => x.tableName)).size * 3);
    app.close(); app = null;
    // A new table alphabetically ahead of all existing tables should not
    // change the old tables' trigger names or accidentally skip a guard.
    other = new DatabaseSync(dbPath);
    other.exec("CREATE TABLE aa_new_source_table(id TEXT)");
    other.close(); other = null;
    app = createApp({ dbPath, startWorker: false, bootstrapToken: "ci-guard-names" });
    const second = list();
    for (const old of first) assert.ok(second.some(x => x.name === old.name && x.tableName === old.tableName));
    assert.equal(second.length, first.length + 3);
    assert.equal(second.filter(x => x.tableName === "aa_new_source_table").length, 3);
  } finally {
    other?.close(); app?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("ORB-004 malformed persisted guard is not silently accepted during clean restart", () => {
  const folder = mkdtempSync(join(tmpdir(), "orb-ci-mismatched-guard-"));
  const dbPath = join(folder, "source.sqlite");
  let app, external;
  try {
    app = createApp({ dbPath, startWorker: false, bootstrapToken: "ci-guard-integrity" });
    const accountTrigger = app.db.prepare(
      "SELECT name FROM main.sqlite_master WHERE type='trigger' AND tbl_name='accounts' AND name LIKE 'orbicore_ci_hold_%_insert'",
    ).get();
    assert.ok(accountTrigger?.name);
    app.close(); app = null;
    external = new DatabaseSync(dbPath);
    const triggerName = '"' + accountTrigger.name.replaceAll('"', '""') + '"';
    external.exec(`DROP TRIGGER ${triggerName}`);
    external.exec(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON accounts BEGIN SELECT 1; END`);
    external.close(); external = null;
    assert.throws(
      () => createApp({ dbPath, startWorker: false, bootstrapToken: "ci-guard-integrity" }),
      /ci_sqlite_source_guard_conflict/,
    );
    external = new DatabaseSync(dbPath);
    assert.equal(external.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, 3);
    assert.equal(external.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get().n, 7);
  } finally {
    external?.close(); app?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("ORB-004 rejects altered guard predicates and event types even with original denial text", () => {
  const folder = mkdtempSync(join(tmpdir(), "orb-ci-exact-guard-"));
  try {
    const alterations = [
      sql => sql.replace("WHEN EXISTS", "WHEN 0 AND EXISTS"),
      sql => sql.replace("BEFORE INSERT", "BEFORE UPDATE"),
    ];
    for (const [i, alter] of alterations.entries()) {
      const dbPath = join(folder, `source-${i}.sqlite`);
      const options = { dbPath, startWorker: false, bootstrapToken: "ci-exact-guard" };
      const app = createApp(options);
      const original = app.db.prepare(
        "SELECT name, sql FROM main.sqlite_master WHERE type='trigger' AND tbl_name='accounts' AND name LIKE 'orbicore_ci_hold_%_insert'",
      ).get();
      app.close();
      const external = new DatabaseSync(dbPath);
      try {
        const changed = alter(original.sql);
        assert.notEqual(changed, original.sql);
        external.exec(`DROP TRIGGER "${original.name}"`);
        external.exec(changed);
      } finally {
        external.close();
      }
      assert.throws(() => createApp(options), /ci_sqlite_source_guard_conflict/);
      const check = new DatabaseSync(dbPath);
      try {
        assert.equal(check.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, 3);
        assert.equal(check.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get().n, 7);
      } finally {
        check.close();
      }
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("ORB-004 rejects case-variant SQLite trigger name collisions on restart", () => {
  const folder = mkdtempSync(join(tmpdir(), "orb-ci-guard-case-"));
  const dbPath = join(folder, "source.sqlite");
  const options = { dbPath, startWorker: false, bootstrapToken: "ci-case-guard" };
  try {
    const app = createApp(options);
    const original = app.db.prepare(
      "SELECT name FROM main.sqlite_master WHERE type='trigger' AND tbl_name='accounts' AND name LIKE 'orbicore_ci_hold_%_insert'",
    ).get();
    app.close();
    const external = new DatabaseSync(dbPath);
    try {
      external.exec(`DROP TRIGGER "${original.name}"`);
      external.exec(`CREATE TRIGGER "${original.name.toUpperCase()}" BEFORE INSERT ON accounts BEGIN SELECT 1; END`);
    } finally {
      external.close();
    }
    assert.throws(() => createApp(options), /ci_sqlite_source_guard_conflict/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
