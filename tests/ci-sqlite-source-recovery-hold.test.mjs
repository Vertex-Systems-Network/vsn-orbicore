import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { createApp } from "../apps/api/server.mjs";
import { rejectCiSourceRecoveryHold } from "../apps/api/sqlite-recovery-hold.mjs";
import { establishCiSyntheticSourceRecoveryHold } from "../apps/api/ci-sqlite-source-recovery-hold.mjs";

test("ORB-004 SQLite startup refuses any CI recovery hold before automatic requeue or audit",()=>{
  const folder=mkdtempSync(join(tmpdir(),"orb-ci-source-hold-"));
  const path=join(folder,"fixture.sqlite");
  try {
    const initial=createApp({dbPath:path,startWorker:false,bootstrapToken:"ci-unit-test"});
    const account=initial.db.prepare(
      "SELECT id FROM accounts WHERE organization_id='org-demo' ORDER BY id LIMIT 1",
    ).get().id;
    initial.db.prepare(
      "INSERT INTO jobs(id,type,organization_id,account_id,status,created_at,started_at,idempotency_key) "+
      "VALUES('ci-hold-running','inventory_refresh','org-demo',?,'running',?,?,?)",
    ).run(account,"2026-11-23T10:00:00.000Z","2026-11-23T10:01:00.000Z",
      "org-demo:ci-queue-hold-running");
    initial.db.exec("CREATE TABLE orbicore_ci_active_recovery_hold(dummy TEXT)");
    initial.close();

    assert.throws(()=>createApp({dbPath:path,startWorker:false,bootstrapToken:"ci-unit-test"}),
      /ci_sqlite_source_recovery_hold_manual_review_required/);
    assert.throws(()=>createApp({dbPath:path,startWorker:true,bootstrapToken:"ci-unit-test"}),
      /ci_sqlite_source_recovery_hold_manual_review_required/);
    const inspection=new DatabaseSync(path);
    assert.throws(()=>rejectCiSourceRecoveryHold(inspection),
      /ci_sqlite_source_recovery_hold_manual_review_required/);
    const row=inspection.prepare(
      "SELECT status,error FROM jobs WHERE id='ci-hold-running'",
    ).get();
    assert.equal(row.status,"running");
    assert.equal(row.error,null);
    assert.equal(inspection.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE action='job.crash_recovery'",
    ).get().n,0);
    // Test-only simulated manual database cleanup; the product provides
    // *no* release API, so a real production hold is never auto-cleared.
    inspection.exec("DROP TABLE orbicore_ci_active_recovery_hold");
    inspection.close();
    const resumed=createApp({dbPath:path,startWorker:false,bootstrapToken:"ci-unit-test"});
    try {
      const changed=resumed.db.prepare(
        "SELECT status,error FROM jobs WHERE id='ci-hold-running'",
      ).get();
      assert.equal(changed.status,"queued");
      assert.equal(changed.error,"recovered_after_restart");
    }finally{resumed.close();}
  }finally{rmSync(folder,{force:true,recursive:true});}
});
test("ORB-004 source marker writer refuses absent/foreign CI consent before SQLite access",()=>{
  const db={
    exec(){throw new Error("sqlite_was_accessed_without_gate");},
    prepare(){throw new Error("sqlite_was_accessed_without_gate");},
  };
  const fake={version:1,scope:"not_a_real_signed_witness"};
  assert.throws(()=>establishCiSyntheticSourceRecoveryHold({
    sqlite:db,witness:fake,key:randomBytes(32),consent:"no",
  }),/ci_source_hold_explicit_disposable_gate_required/);
  assert.throws(()=>rejectCiSourceRecoveryHold(null),/sqlite_source_required/);
});
