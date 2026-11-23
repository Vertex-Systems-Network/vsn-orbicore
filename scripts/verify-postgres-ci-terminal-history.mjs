import assert from "node:assert/strict";
import { Pool } from "pg";
import { createApp } from "../apps/api/server.mjs";
import { copySyntheticTerminalJobHistorySnapshot } from "../apps/api/postgres-identity-core.mjs";

// The source SQLite and target PG instances must be disposable CI fixtures.
if (process.env.GITHUB_ACTIONS !== "true" ||
    process.env.ORBICORE_CI_SYNTHETIC_AUTH_IMPORT !== "1" ||
    process.env.ORBICORE_CI_TERMINAL_JOBS !== "1") {
  throw new Error("synthetic_terminal_job_history_ci_only");
}
const pool = new Pool({
  host:process.env.PGHOST ?? "127.0.0.1",
  port:Number(process.env.PGPORT ?? 5432),
  user:process.env.PGUSER ?? "orbicore",
  database:process.env.PGDATABASE ?? "orbicore",
  password:process.env.PGPASSWORD,
  connectionTimeoutMillis:5000,
});
const app = createApp({
  dbPath:":memory:",startWorker:false,
  bootstrapToken:"ci-terminal-job-history-bootstrap-token",
});
const now = "2026-11-23T09:00:00.000Z";
const start = "2026-11-23T09:01:00.000Z";
const done = "2026-11-23T09:02:00.000Z";
const copy = () => copySyntheticTerminalJobHistorySnapshot({
  sqlite:app.db, postgres:pool, consent:"fixture_only_terminal_jobs_offline_copy",
});
const pgCount = async (table) =>
  Number((await pool.query("SELECT COUNT(*)::int AS n FROM " + table)).rows[0].n);
async function readTenant(tenant) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE orbicore_tenant_readonly");
    if (tenant !== null) await client.query("SELECT set_config('orbicore.tenant_id',$1,true)",[tenant]);
    return (await client.query("SELECT organization_id, id FROM jobs ORDER BY id")).rows;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

try {
  await new Promise((resolve,reject) => {
    app.server.once("error",reject);
    app.server.listen(0,"127.0.0.1",resolve);
  });
  const boot = await fetch("http://127.0.0.1:" + app.server.address().port + "/api/auth/bootstrap",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({
      token:"ci-terminal-job-history-bootstrap-token",
      email:"ci-terminal-owner@example.test",
      password:"fixture-only-password-not-used-live-2026",
    }),
  });
  assert.equal(boot.status,201);
  const owner = app.db.prepare("SELECT id FROM users WHERE email='ci-terminal-owner@example.test'").get().id;
  const first = app.db.prepare("SELECT id FROM accounts WHERE organization_id='org-demo' ORDER BY id LIMIT 1").get().id;
  const otherOrg = "org-ci-terminal-other";
  const otherAccount = "acct-ci-terminal-other";
  const otherUser = "user-ci-terminal-other";
  app.db.prepare("INSERT INTO organizations(id,name,created_at) VALUES (?,?,?)")
    .run(otherOrg,"Synthetic second tenant",now);
  app.db.prepare("INSERT INTO users(id,organization_id,email,password_salt,password_hash,role,created_at) " +
    "VALUES (?,?,?,'ci-salt-not-a-real-user','ci-hash-not-a-real-user','viewer',?)")
    .run(otherUser,otherOrg,"ci-other-terminal@example.invalid",now);
  app.db.prepare("INSERT INTO accounts(id,organization_id,label,provider,host,username,health,used_bytes,quota_bytes,source) " +
    "VALUES (?,?,?,'mock','fixture.example.invalid','fixture','healthy',0,1,'mock_fixture')")
    .run(otherAccount,otherOrg,"Synthetic fixture-only account");

  const complete = {
    id:"ci-terminal-job-success",type:"inventory_refresh",
    organization_id:"org-demo",account_id:first,requested_by:owner,
    status:"completed",idempotency_key:"ci-terminal-completed",
    created_at:now,started_at:start,completed_at:done,
    result_json:JSON.stringify({
      source:"mock_fixture",live:false,ciFixture:true,accountId:first,sites:2,
    }),
    error:null,
  };
  const failed = {
    id:"ci-terminal-job-failed",type:"inventory_refresh",
    organization_id:otherOrg,account_id:otherAccount,requested_by:otherUser,
    status:"failed",idempotency_key:"ci-terminal-failed",
    created_at:now,started_at:start,completed_at:done,
    result_json:null,error:"ci_fixture_failure",
  };
  const insert = app.db.prepare(
    "INSERT INTO jobs(id,type,organization_id,account_id,requested_by,status,idempotency_key," +
    "created_at,started_at,completed_at,result_json,error) VALUES " +
    "(@id,@type,@organization_id,@account_id,@requested_by,@status,@idempotency_key," +
    "@created_at,@started_at,@completed_at,@result_json,@error)",
  );
  insert.run(complete);
  insert.run(failed);
  const original = app.db.prepare("SELECT * FROM jobs ORDER BY id").all();
  // A legacy/retry-running workload cannot migrate as immutable terminal history.
  const active = {...complete,id:"ci-terminal-active",status:"queued",
    idempotency_key:"ci-terminal-active",started_at:null,completed_at:null,result_json:null};
  insert.run(active);
  await assert.rejects(copy(),/unsupported_nonterminal_or_nonfixture_job/);
  app.db.prepare("DELETE FROM jobs WHERE id=?").run(active.id);

  // Reject any source result that includes a synthetic credential-like key.
  app.db.prepare("UPDATE jobs SET result_json=? WHERE id=?")
    .run(JSON.stringify({...JSON.parse(complete.result_json),apiToken:"should-never-copy"}),complete.id);
  await assert.rejects(copy(),/terminal_job_result_not_fixture_safe/);
  app.db.prepare("UPDATE jobs SET result_json=? WHERE id=?").run(complete.result_json,complete.id);

  // SQLite's requested_by is not tenant-FK protected. The offline importer is.
  app.db.prepare("UPDATE jobs SET requested_by=? WHERE id=?").run(otherUser,complete.id);
  await assert.rejects(copy(),/terminal_job_tenant_actor_mismatch/);
  app.db.prepare("UPDATE jobs SET requested_by=? WHERE id=?").run(owner,complete.id);

  assert.equal(await pgCount("jobs"),0);
  assert.equal(await pgCount("organizations"),0);

  // Fail after identity, feature, and first job were inserted; whole PG
  // transaction must roll back, rather than leaving a partial authority.
  await pool.query(
    "CREATE FUNCTION ci_deny_failed_job() RETURNS trigger LANGUAGE plpgsql AS $$ " +
    "BEGIN IF NEW.status='failed' THEN RAISE EXCEPTION 'ci_injected_terminal_job_failure'; " +
    "END IF; RETURN NEW; END; $$",
  );
  await pool.query(
    "CREATE TRIGGER ci_deny_failed_job BEFORE INSERT ON jobs " +
    "FOR EACH ROW EXECUTE FUNCTION ci_deny_failed_job()",
  );
  await assert.rejects(copy(),/ci_injected_terminal_job_failure/);
  for (const table of ["organizations","users","accounts","audit_events","jobs","job_outbox"]) {
    assert.equal(await pgCount(table),0,"rollback left partially imported "+table);
  }
  await pool.query("DROP TRIGGER ci_deny_failed_job ON jobs");
  await pool.query("DROP FUNCTION ci_deny_failed_job()");

  const imported = await copy();
  assert.equal(imported.scope,"synthetic_terminal_job_history_only");
  assert.equal(imported.counts.jobs,2);
  assert.equal(await pgCount("jobs"),2);
  assert.equal(await pgCount("job_outbox"),0,"history migration must never enqueue work");
  assert.deepEqual(app.db.prepare("SELECT * FROM jobs ORDER BY id").all(),original,
    "source SQLite ledger must remain unchanged");
  const values = (await pool.query("SELECT id,status,result_json,attempts,created_at,started_at,completed_at " +
    "FROM jobs ORDER BY id")).rows;
  assert.equal(values.length,2);
  const succeeded = values.find(x=>x.id===complete.id);
  assert.equal(succeeded.result_json.ciFixture,true);
  assert.equal(succeeded.result_json.accountId,first);
  assert.equal(succeeded.attempts,0,"history import cannot acquire a live worker lease");
  assert.equal(succeeded.started_at.toISOString(),start);
  assert.equal(succeeded.completed_at.toISOString(),done);

  assert.deepEqual((await readTenant("org-demo")).map(x=>x.id),[complete.id]);
  assert.deepEqual((await readTenant(otherOrg)).map(x=>x.id),[failed.id]);
  assert.deepEqual(await readTenant(null),[],"missing tenant context exposes jobs");
  await assert.rejects(copy(),/nonempty_postgres_target_refused/);

  console.log(JSON.stringify({
    tasks:["ORB-004","ORB-005","ORB-016","ORB-017"],
    kind:"ci_only_terminal_synthetic_sqlite_to_postgres_history",
    sourceUnmodified:true,terminalJobs:imported.counts.jobs,
    copiedJobs:[complete.id,failed.id],
    rejectedQueuedAndRunning:true,rejectedUnsafePayload:true,
    rejectedCrossTenantRequestedBy:true,
    rollbackOnPostgresFailure:true,tenantRlsReadProved:true,
    postgresJobOutboxRows:0,
    reimportBlocked:true,
    liveProviderCalls:0,productionHttpAuthority:false,productionQueueCutover:false,
  }));
} finally {
  app.close();
  await pool.end();
}
