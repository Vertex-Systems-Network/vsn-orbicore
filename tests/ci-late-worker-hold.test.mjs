import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../apps/api/server.mjs";

const marker = "CREATE TABLE orbicore_ci_active_recovery_hold (dummy TEXT)";
function fixtureJob(app, id) {
  const accountId = app.db.prepare(
    "SELECT id FROM accounts WHERE organization_id='org-demo' ORDER BY id LIMIT 1",
  ).get().id;
  app.db.prepare(
    "INSERT INTO jobs(id,type,organization_id,account_id,status,created_at,idempotency_key) " +
    "VALUES(?,'inventory_refresh','org-demo',?,'queued',?,?)",
  ).run(id, accountId, "2026-11-23T10:00:00.000Z", "org-demo:" + id);
}
function assertUnchanged(app, id) {
  const job = app.db.prepare(
    "SELECT status,started_at,completed_at,result_json,error FROM jobs WHERE id=?",
  ).get(id);
  assert.equal(job.status, "queued");
  assert.equal(job.started_at, null);
  assert.equal(job.completed_at, null);
  assert.equal(job.result_json, null);
  assert.equal(job.error, null);
  assert.equal(app.db.prepare(
    "SELECT COUNT(*) AS n FROM audit_events WHERE action IN ('job.crash_recovery','inventory.refresh')",
  ).get().n, 0);
}

test("ORB-004 existing worker refuses late source hold before claim and audit writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orb-late-hold-"));
  const dbPath = join(dir, "source.sqlite");
  let app, external;
  try {
    app = createApp({ dbPath, startWorker: false, bootstrapToken: "ci-late-hold" });
    fixtureJob(app, "ci-hold-queued");
    external = new DatabaseSync(dbPath);
    external.exec(marker);
    await assert.rejects(app.processNextJob(), /ci_sqlite_source_recovery_hold_manual_review_required/);
    assertUnchanged(app, "ci-hold-queued");
  } finally {
    external?.close();
    app?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ORB-004 running local timer stops safely on a post-start hold without executing queued work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orb-late-timer-hold-"));
  const dbPath = join(dir, "source.sqlite");
  let app, external;
  try {
    app = createApp({ dbPath, startWorker: true, bootstrapToken: "ci-late-timer-hold" });
    fixtureJob(app, "ci-timer-queued");
    external = new DatabaseSync(dbPath);
    external.exec(marker);
    // The existing interval is 250ms. Its catch handler must stop the
    // timer rather than produce an unhandled rejection after the late hold.
    await new Promise((resolve) => setTimeout(resolve, 550));
    assertUnchanged(app, "ci-timer-queued");
    await assert.rejects(app.processNextJob(), /ci_sqlite_source_recovery_hold_manual_review_required/);
  } finally {
    external?.close();
    app?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
