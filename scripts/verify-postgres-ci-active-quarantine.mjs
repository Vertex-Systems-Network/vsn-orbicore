import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { createApp } from "../apps/api/server.mjs";
import { stageSyntheticActiveJobQuarantine } from "../apps/api/ci-active-job-quarantine.mjs";
import {
  createSyntheticActiveQuarantineWitness, reconcileSyntheticActiveQuarantine,
} from "../apps/api/ci-active-quarantine-reconcile.mjs";

if (process.env.GITHUB_ACTIONS !== "true" ||
    process.env.ORBICORE_CI_ACTIVE_QUARANTINE !== "1") {
  throw new Error("ci_active_job_quarantine_hosted_only");
}
const pool=new Pool({
  host:process.env.PGHOST ?? "127.0.0.1",port:Number(process.env.PGPORT ?? 5432),
  user:process.env.PGUSER ?? "orbicore",
  database:process.env.PGDATABASE ?? "orbicore",password:process.env.PGPASSWORD,
  connectionTimeoutMillis:5000,
});
const app=createApp({dbPath:":memory:",startWorker:false,bootstrapToken:"ci-quarantine-bootstrap-not-used"});
const sql=app.db;
const created="2026-11-23T10:00:00.000Z", started="2026-11-23T10:01:00.000Z";
const consent="ci_fixture_active_jobs_quarantine_no_replay";
const copy=()=>stageSyntheticActiveJobQuarantine({sqlite:sql,postgres:pool,consent});
const count=async table=>Number((await pool.query(
  "SELECT COUNT(*)::int AS n FROM "+table,
)).rows[0].n);
try {
  const account=sql.prepare("SELECT id FROM accounts WHERE organization_id='org-demo' ORDER BY id LIMIT 1").get().id;
  const org2="org-ci-quarantine-b";
  sql.prepare("INSERT INTO organizations(id,name,created_at) VALUES (?,?,?)")
    .run(org2,"Second mock tenant",created);
  sql.prepare("INSERT INTO accounts(id,organization_id,label,provider,host,username,health,used_bytes,quota_bytes,source) " +
    "VALUES(?,?,?,'mock','ci-mock.example.invalid','ci','healthy',0,1,'mock_fixture')")
    .run("acc-ci-quarantine-b",org2,"CI-only fake account");
  const addUser=sql.prepare("INSERT INTO users(id,organization_id,email,password_salt,password_hash,role,disabled,mfa_enabled,created_at) " +
    "VALUES(?,?,?,'ci-only-not-a-credential','ci-only-not-a-credential','operator',0,0,?)");
  addUser.run("usr-ci-quarantine-a","org-demo","ci-queue-a@example.test",created);
  addUser.run("usr-ci-quarantine-b",org2,"ci-queue-b@example.invalid",created);

  const queued={id:"job-ci-queued",organization_id:"org-demo",account_id:account,
    requested_by:"usr-ci-quarantine-a",type:"inventory_refresh",
    status:"queued",idempotency_key:"org-demo:ci-queue-first",
    created_at:created,started_at:null,completed_at:null,result_json:null,error:null};
  const running={...queued,id:"job-ci-running",organization_id:org2,
    account_id:"acc-ci-quarantine-b",requested_by:"usr-ci-quarantine-b",
    status:"running",idempotency_key:"org-ci-quarantine-b:ci-queue-second",
    started_at:started};
  const addJob=sql.prepare("INSERT INTO jobs(id,type,organization_id,account_id,requested_by,status,idempotency_key," +
    "created_at,started_at,completed_at,result_json,error) VALUES (" +
    "@id,@type,@organization_id,@account_id,@requested_by,@status,@idempotency_key," +
    "@created_at,@started_at,@completed_at,@result_json,@error)");
  addJob.run(queued);addJob.run(running);
  const original=sql.prepare("SELECT * FROM jobs ORDER BY id").all();

  // Distinct consent and two independent environment preconditions are checked.
  await assert.rejects(stageSyntheticActiveJobQuarantine({
    sqlite:sql,postgres:pool,consent:"fixture_only_terminal_jobs_offline_copy",
  }),/ci_active_quarantine_explicit_gate_required/);

  sql.prepare("UPDATE jobs SET requested_by=? WHERE id=?")
    .run(running.requested_by,queued.id);
  await assert.rejects(copy(),/active_job_tenant_or_actor_refused/);
  sql.prepare("UPDATE jobs SET requested_by=? WHERE id=?")
    .run(queued.requested_by,queued.id);

  sql.prepare("UPDATE jobs SET result_json=? WHERE id=?")
    .run('{"apiToken":"synthetic-injection-not-stored"}',queued.id);
  await assert.rejects(copy(),/unsafe_active_job_shape_refused/);
  sql.prepare("UPDATE jobs SET result_json=NULL WHERE id=?").run(queued.id);

  const oldName=sql.prepare("SELECT name FROM schema_migrations WHERE version=7").get().name;
  sql.prepare("UPDATE schema_migrations SET name=? WHERE version=7").run("unknown_ci_migration");
  await assert.rejects(copy(),/sqlite_v7_migration_manifest_mismatch/);
  sql.prepare("UPDATE schema_migrations SET name=? WHERE version=7").run(oldName);
  assert.equal(await count("orbicore_ci_quarantine.active_jobs"),0);
  assert.equal(await count("public.jobs"),0);

  // Refuse partially populated target, even if quarantine relation is empty.
  await pool.query("INSERT INTO public.organizations(id,name) VALUES ('ci-unexpected-target','CI')");
  await assert.rejects(copy(),/nonempty_quarantine_target_refused/);
  await pool.query("DELETE FROM public.organizations WHERE id='ci-unexpected-target'");

  // A trigger faults the second insert: no partial quarantined rows may remain.
  await pool.query("CREATE FUNCTION orbicore_ci_quarantine.deny_running() RETURNS trigger " +
    "LANGUAGE plpgsql AS $$ BEGIN IF NEW.source_status='running' THEN " +
    "RAISE EXCEPTION 'ci_injected_active_job_failure'; END IF; RETURN NEW; END $$");
  await pool.query("CREATE TRIGGER ci_fail_second BEFORE INSERT ON orbicore_ci_quarantine.active_jobs " +
    "FOR EACH ROW EXECUTE FUNCTION orbicore_ci_quarantine.deny_running()");
  await assert.rejects(copy(),/ci_injected_active_job_failure/);
  assert.equal(await count("orbicore_ci_quarantine.active_jobs"),0,
    "failure cannot leave partial quarantined job metadata");
  for(const table of ["public.organizations","public.users","public.accounts","public.jobs","public.job_outbox"]) {
    assert.equal(await count(table),0,"quarantine touched runtime table "+table);
  }
  await pool.query("DROP TRIGGER ci_fail_second ON orbicore_ci_quarantine.active_jobs");
  await pool.query("DROP FUNCTION orbicore_ci_quarantine.deny_running()");

  // Sign a detached witness before the PG import, with a fresh process-local
  // key that never appears in source, PostgreSQL or the uploaded artifact.
  const witnessKey=randomBytes(32);
  const detachedDir=mkdtempSync(join(tmpdir(),"orb-ci-active-witness-"));
  let detachedWitness;
  try {
    const originalWitness=createSyntheticActiveQuarantineWitness({
      sqlite:sql,consent,key:witnessKey,
    });
    const detachedPath=join(detachedDir,"signed-checkpoint.json");
    writeFileSync(detachedPath,JSON.stringify(originalWitness),{mode:0o600});
    detachedWitness=JSON.parse(readFileSync(detachedPath,"utf8"));
  } finally {
    rmSync(detachedDir,{force:true,recursive:true});
  }
  const reconcile=(witness=detachedWitness,key=witnessKey,pg=pool)=>
    reconcileSyntheticActiveQuarantine({
      sqlite:sql,postgres:pg,witness,key,consent,
    });

  const result=await copy();
  assert.equal(result.scope,"ci_only_active_job_quarantine_metadata");
  assert.equal(result.count,2);
  assert.equal(result.executable,false);
  assert.equal(result.replayed,false);
  assert.equal(await count("orbicore_ci_quarantine.active_jobs"),2);
  for(const table of ["public.organizations","public.users","public.accounts","public.jobs","public.job_outbox"]) {
    assert.equal(await count(table),0,"staging leaked into runtime table "+table);
  }
  const staged=(await pool.query("SELECT source_job_id,organization_id,source_status,metadata_sha256 " +
    "FROM orbicore_ci_quarantine.active_jobs ORDER BY source_job_id")).rows;
  assert.deepEqual(staged.map(x=>x.source_status),["queued","running"]);
  assert.deepEqual(staged.map(x=>x.organization_id),["org-demo",org2]);
  assert.ok(staged.every(x=>/^[0-9a-f]{64}$/.test(x.metadata_sha256)));
  assert.deepEqual(sql.prepare("SELECT * FROM jobs ORDER BY id").all(),original,
    "SQLite source must remain bitwise unchanged at job row level");

  const certified=await reconcile();
  assert.equal(certified.matched,2);
  assert.equal(certified.sourceDigest,detachedWitness.digest);
  assert.equal(certified.postgresWrites,0);
  assert.equal(certified.replayed,false);

  // Independent checkpoint integrity is checked before either SQLite or PG IO.
  const pgMustNeverConnect={connect(){throw Error("pg touched before MAC verification");}};
  await assert.rejects(reconcile({...detachedWitness,count:1},witnessKey,pgMustNeverConnect),
    /ci_quarantine_witness_mac_mismatch/);
  await assert.rejects(reconcile(detachedWitness,randomBytes(32),pgMustNeverConnect),
    /ci_quarantine_witness_mac_mismatch/);

  // The signed expected source is independent of PG staging; any later SQLite
  // source job metadata change must fail closed before PostgreSQL connection.
  sql.prepare("UPDATE jobs SET idempotency_key=? WHERE id=?")
    .run("org-demo:ci-queue-renamed",queued.id);
  await assert.rejects(reconcile(detachedWitness,witnessKey,pgMustNeverConnect),
    /ci_quarantine_source_checkpoint_mismatch/);
  sql.prepare("UPDATE jobs SET idempotency_key=? WHERE id=?")
    .run(queued.idempotency_key,queued.id);

  // A privileged PG edit cannot become trusted by recomputing its row digest.
  const before=(await pool.query(
    "SELECT metadata_sha256 FROM orbicore_ci_quarantine.active_jobs WHERE source_job_id=$1",
    [queued.id],
  )).rows[0].metadata_sha256;
  const alteredAccount="ci-attacker-account";
  const forgedDigest=createHash("sha256").update(JSON.stringify({
    id:queued.id,organizationId:queued.organization_id,accountId:alteredAccount,
    requestedBy:queued.requested_by,status:queued.status,
    idempotencyKey:queued.idempotency_key,createdAt:queued.created_at,startedAt:null,
  })).digest("hex");
  await pool.query(
    "UPDATE orbicore_ci_quarantine.active_jobs " +
    "SET account_id=$1, metadata_sha256=$2 WHERE source_job_id=$3",
    [alteredAccount,forgedDigest,queued.id],
  );
  await assert.rejects(reconcile(),/ci_quarantine_postgres_parity_mismatch/);
  await pool.query(
    "UPDATE orbicore_ci_quarantine.active_jobs " +
    "SET account_id=$1, metadata_sha256=$2 WHERE source_job_id=$3",
    [queued.account_id,before,queued.id],
  );

  // Added/removed quarantine rows and public runtime mutation are separately
  // detected; no automatic reconcile/heal/replay is ever attempted.
  await pool.query(
    "INSERT INTO orbicore_ci_quarantine.active_jobs " +
    "(source_job_id,organization_id,account_id,requested_by,source_status," +
    "idempotency_key,created_at,started_at,metadata_sha256) " +
    "SELECT 'ci-ghost-job',organization_id,account_id,requested_by,source_status," +
    "'ci-queue-ghost',created_at,started_at,metadata_sha256 " +
    "FROM orbicore_ci_quarantine.active_jobs WHERE source_job_id=$1",
    [queued.id],
  );
  await assert.rejects(reconcile(),/ci_quarantine_postgres_parity_mismatch/);
  await pool.query("DELETE FROM orbicore_ci_quarantine.active_jobs WHERE source_job_id='ci-ghost-job'");

  await pool.query("INSERT INTO public.organizations(id,name) VALUES ('ci-contaminant','CI only')");
  await assert.rejects(reconcile(),/ci_quarantine_public_tables_not_empty/);
  await pool.query("DELETE FROM public.organizations WHERE id='ci-contaminant'");
  assert.equal((await reconcile()).matched,2);

  const restricted=await pool.connect();
  try {
    await restricted.query("BEGIN");
    await restricted.query("SET LOCAL ROLE orbicore_tenant_readonly");
    await assert.rejects(
      restricted.query("SELECT source_job_id FROM orbicore_ci_quarantine.active_jobs"),
      error=>error.code==="42501","runtime tenant role read quarantine metadata",
    );
  } finally {
    await restricted.query("ROLLBACK");
    restricted.release();
  }
  await assert.rejects(copy(),/nonempty_quarantine_target_refused/,
    "quarantine must not permit replay or duplicate staging");
  console.log(JSON.stringify({
    tasks:["ORB-004","ORB-005","ORB-016","ORB-017"],
    mode:"ci_only_metadata_quarantine_no_replay",
    quarantined:result.count,activeSourceStates:["queued","running"],
    syntheticOnly:true,missingConsentDenied:true,tamperedSourceDenied:true,
    invalidTenantDenied:true,unsafePayloadDenied:true,
    dirtyTargetDenied:true,forcedLatePgRollbackVerified:true,
    restrictedTenantRoleReadDenied:true,sourceJobsUnchanged:true,
    detachedSignedWitnessVerified:true,wrongKeyDeniedBeforePgIo:true,
    sourceDriftDeniedBeforePgIo:true,forgedPostgresDigestDenied:true,
    extraQuarantineRowDenied:true,dirtyRuntimeStateDenied:true,
    readOnlyReconciliation:true,witnessKeyPersisted:false,
    productionJobs:0,productionOutbox:0,
    executionEnabled:false,workReplayed:false,productionMigration:false,
  }));
} finally {
  app.close();
  await pool.end();
}
