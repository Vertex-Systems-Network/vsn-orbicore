import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { createApp } from "../apps/api/server.mjs";
import { stageSyntheticActiveJobQuarantine } from "../apps/api/ci-active-job-quarantine.mjs";
import {
  createSyntheticActiveQuarantineWitness,
  reconcileSyntheticActiveQuarantine,
} from "../apps/api/ci-active-quarantine-reconcile.mjs";

// Every process, including the forked crash actors, validates its *disposable*
// runner gates before opening a file or making a PostgreSQL connection.
if (process.env.GITHUB_ACTIONS !== "true" ||
    process.env.ORBICORE_CI_ACTIVE_QUARANTINE !== "1" ||
    process.env.ORBICORE_CI_CROSS_STORE_CRASH !== "1" ||
    process.env.ORBICORE_CI_NO_PROVIDER_CALLS !== "1" ||
    !["localhost","127.0.0.1"].includes(process.env.PGHOST ?? "127.0.0.1") ||
    String(process.env.PGPORT ?? "5432") !== "5432" ||
    (process.env.PGUSER ?? "orbicore") !== "orbicore" ||
    (process.env.PGDATABASE ?? "orbicore") !== "orbicore" ||
    process.env.PGPASSWORD !== "ci-cross-store-crash-only-password") {
  throw new Error("ci_cross_store_crash_disposable_runner_only");
}

const consent="ci_fixture_active_jobs_quarantine_no_replay";
const t0="2026-11-23T10:00:00.000Z",t1="2026-11-23T10:01:00.000Z";
const poolConfig={
  host:process.env.PGHOST ?? "127.0.0.1",port:5432,
  user:"orbicore",database:"orbicore",password:process.env.PGPASSWORD,
  max:5,connectionTimeoutMillis:5000,statement_timeout:8000,
};
const openSqlite=path=>{
  const db=new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON");
  return db;
};
function originalJobRows(sqlite) {
  return sqlite.prepare(
    "SELECT id,status,idempotency_key,started_at,error,completed_at,result_json "+
    "FROM jobs WHERE id IN ('ci-crash-queued','ci-crash-running') ORDER BY id",
  ).all();
}
function createFixture(path) {
  const app=createApp({
    dbPath:path,startWorker:false,bootstrapToken:"ci-not-a-production-token",
  });
  try {
    const db=app.db;
    const a=db.prepare(
      "SELECT id FROM accounts WHERE organization_id='org-demo' ORDER BY id LIMIT 1",
    ).get()?.id;
    assert.ok(a,"default fixture account required");
    db.prepare("INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)")
      .run("org-ci-crash-b","Disposable CI tenant B",t0);
    db.prepare(
      "INSERT INTO accounts(id,organization_id,label,provider,host,username,"+
      "health,used_bytes,quota_bytes,source) "+
      "VALUES(?,?,?,'mock','ci-crash.invalid','ci','healthy',0,1,'mock_fixture')",
    ).run("acc-ci-crash-b","org-ci-crash-b","Fixture only B");
    const user=db.prepare(
      "INSERT INTO users(id,organization_id,email,password_salt,password_hash,"+
      "role,disabled,mfa_enabled,created_at) "+
      "VALUES(?,?,?,'ci-only-not-a-credential','ci-only-not-a-credential'," +
      "'operator',0,0,?)",
    );
    user.run("usr-ci-crash-a","org-demo","crash-a@example.test",t0);
    user.run("usr-ci-crash-b","org-ci-crash-b","crash-b@example.invalid",t0);
    const insert=db.prepare(
      "INSERT INTO jobs(id,type,organization_id,account_id,requested_by,"+
      "status,idempotency_key,created_at,started_at,completed_at,result_json,error) "+
      "VALUES(@id,@type,@organization_id,@account_id,@requested_by,"+
      "@status,@idempotency_key,@created_at,@started_at,@completed_at,@result_json,@error)",
    );
    insert.run({
      id:"ci-crash-queued",type:"inventory_refresh",organization_id:"org-demo",
      account_id:a,requested_by:"usr-ci-crash-a",status:"queued",
      idempotency_key:"org-demo:ci-queue-crash-a",created_at:t0,started_at:null,
      completed_at:null,result_json:null,error:null,
    });
    insert.run({
      id:"ci-crash-running",type:"inventory_refresh",
      organization_id:"org-ci-crash-b",account_id:"acc-ci-crash-b",
      requested_by:"usr-ci-crash-b",status:"running",
      idempotency_key:"org-ci-crash-b:ci-queue-crash-b",
      created_at:t0,started_at:t1,completed_at:null,result_json:null,error:null,
    });
    return originalJobRows(db);
  } finally {
    app.close();
  }
}

// In the precommit actor, hold the exact private PG transaction open after
// two validated INSERTs, before COMMIT can reach the server. The parent sends
// SIGKILL to the actor and PG rolls back the abandoned server transaction.
async function crashActor(stage,path) {
  const sqlite=openSqlite(path),pg=new Pool(poolConfig);
  try {
    if(stage==="precommit"){
      const intercepted={
        connect:async()=>{
          const client=await pg.connect();
          return {
            query:(sql,params)=>{
              if(sql==="COMMIT"){
                process.send?.({stage:"precommit",checkpoint:"pg_inserted_uncommitted"});
                return new Promise(()=>{});
              }
              return client.query(sql,params);
            },
            release:()=>client.release(),
          };
        },
      };
      await stageSyntheticActiveJobQuarantine({sqlite,postgres:intercepted,consent});
      throw new Error("unexpected_precommit_stage_return");
    }else if(stage==="postcommit"){
      const result=await stageSyntheticActiveJobQuarantine({sqlite,postgres:pg,consent});
      assert.equal(result.count,2);
      assert.equal(result.replayed,false);
      process.send?.({stage:"postcommit",checkpoint:"pg_committed_source_not_acknowledged"});
      await new Promise(()=>{});
    }else throw new Error("unrecognized_crash_actor_mode");
  } finally {
    sqlite.close();
    await pg.end();
  }
}

async function forkAndKillAt(stage,path) {
  const actor=fork(fileURLToPath(import.meta.url),["--actor",stage,path],{
    env:process.env,stdio:["ignore","ignore","pipe","ipc"],
  });
  // Avoid printing any CLI payloads, source contents or credentials on failure.
  let settled=false,diagnostic="";
  actor.stderr.on("data",chunk=>{ diagnostic=(diagnostic+chunk.toString()).slice(-1000); });
  const checkpoint=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{
      if(settled)return;
      settled=true;reject(new Error("ci_cross_store_actor_checkpoint_timeout"));
    },25000);
    actor.on("message",value=>{
      if(settled || value?.stage!==stage)return;
      settled=true;clearTimeout(timer);resolve(value);
    });
    actor.once("exit",(code,signal)=>{
      if(settled)return;
      settled=true;clearTimeout(timer);
      reject(new Error("ci_cross_store_actor_exited_before_checkpoint:"+String(code)+":"+String(signal)+
        (diagnostic.includes("Error")?":child_failed":"")));
    });
    actor.once("error",()=>{if(!settled){settled=true;clearTimeout(timer);
      reject(new Error("ci_cross_store_actor_spawn_failed"));}});
  });
  try {
    const marked=await checkpoint;
    const exit=once(actor,"exit");
    assert.equal(actor.kill("SIGKILL"),true,"actor must be terminable");
    const [code,signal]=await exit;
    assert.equal(code,null);
    assert.equal(signal,"SIGKILL");
    return marked;
  }finally{
    if(actor.exitCode===null && actor.signalCode===null)actor.kill("SIGKILL");
  }
}
async function quarantineCount(pg) {
  return Number((await pg.query(
    "SELECT COUNT(*)::int AS total FROM orbicore_ci_quarantine.active_jobs",
  )).rows[0].total);
}
async function assertNoRuntimeJobWrites(pg) {
  const result=await pg.query(
    "SELECT (SELECT COUNT(*)::int FROM public.jobs) AS jobs, "+
    "(SELECT COUNT(*)::int FROM public.job_outbox) AS outbox, "+
    "(SELECT COUNT(*)::int FROM public.organizations) AS organizations, "+
    "(SELECT COUNT(*)::int FROM public.users) AS users, "+
    "(SELECT COUNT(*)::int FROM public.accounts) AS accounts",
  );
  assert.deepEqual(result.rows,[{
    jobs:0,outbox:0,organizations:0,users:0,accounts:0,
  }]);
}

async function parentScenario() {
  const scratch=mkdtempSync(join(tmpdir(),"orb-ci-sqlite-pg-crash-"));
  const sourcePath=join(scratch,"source-v7.sqlite");
  const pg=new Pool(poolConfig);
  let sqlite=null;
  try {
    const before=createFixture(sourcePath);
    sqlite=openSqlite(sourcePath);
    const signerKey=randomBytes(32);
    const witness=createSyntheticActiveQuarantineWitness({
      sqlite,key:signerKey,consent,
    });
    assert.equal(witness.count,2);
    sqlite.close();sqlite=null;

    // Window A: source SQLite snapshot and PG inserts were prepared; the PG
    // transaction never commits. The dead actor cannot leave partial target.
    const pre=await forkAndKillAt("precommit",sourcePath);
    assert.equal(pre.checkpoint,"pg_inserted_uncommitted");
    const locker=await pg.connect();
    try {
      await locker.query("BEGIN");
      // A new PG transaction must acquire the staging lock after the killed
      // actor; a lingering uncommitted transaction cannot be accepted.
      await locker.query("SELECT pg_advisory_xact_lock(564221,6)");
      assert.equal(Number((await locker.query(
        "SELECT COUNT(*)::int AS n FROM orbicore_ci_quarantine.active_jobs",
      )).rows[0].n),0);
      await locker.query("COMMIT");
    }finally{locker.release();}
    sqlite=openSqlite(sourcePath);
    assert.deepEqual(originalJobRows(sqlite),before);
    sqlite.close();sqlite=null;
    await assertNoRuntimeJobWrites(pg);

    // Window B: PG commit succeeds, but the actor never reaches any durable
    // source-side acknowledgment; SIGKILL leaves a committed private target.
    const post=await forkAndKillAt("postcommit",sourcePath);
    assert.equal(post.checkpoint,"pg_committed_source_not_acknowledged");
    assert.equal(await quarantineCount(pg),2);
    sqlite=openSqlite(sourcePath);
    assert.deepEqual(originalJobRows(sqlite),before,
      "staging must not change SQLite even after PG committed");
    const reconciled=await reconcileSyntheticActiveQuarantine({
      sqlite,postgres:pg,witness,key:signerKey,consent,
    });
    assert.equal(reconciled.matched,2);
    assert.equal(reconciled.executable,false);
    assert.equal(reconciled.replayed,false);
    await assert.rejects(
      stageSyntheticActiveJobQuarantine({sqlite,postgres:pg,consent}),
      /nonempty_quarantine_target_refused/,
      "after ambiguous crash, reimport must never create another active job",
    );
    assert.equal(await quarantineCount(pg),2);

    // File-backed SQLite source can commit separately after PG staging. Even a
    // syntactically valid changed fixture key invalidates the old witness.
    sqlite.prepare("UPDATE jobs SET idempotency_key=? WHERE id=?")
      .run("org-demo:ci-queue-crash-edited","ci-crash-queued");
    const neverPg={connect(){throw new Error("postgres_must_not_be_accessed_on_source_drift");}};
    await assert.rejects(reconcileSyntheticActiveQuarantine({
      sqlite,postgres:neverPg,witness,key:signerKey,consent,
    }),/ci_quarantine_source_checkpoint_mismatch/);
    sqlite.prepare("UPDATE jobs SET idempotency_key=? WHERE id=?")
      .run("org-demo:ci-queue-crash-a","ci-crash-queued");
    assert.equal((await reconcileSyntheticActiveQuarantine({
      sqlite,postgres:pg,witness,key:signerKey,consent,
    })).matched,2);
    sqlite.close();sqlite=null;

    // Real app start has its own SQLite crash recovery: running -> queued and
    // 'recovered_after_restart' error. That row can no longer pass the strict
    // pristine active-job quarantine shape; signed PG metadata stays isolated.
    const restarted=createApp({
      dbPath:sourcePath,startWorker:false,bootstrapToken:"ci-not-a-production-token",
    });
    try {
      sqlite=restarted.db;
      const recovery=sqlite.prepare(
        "SELECT status,error FROM jobs WHERE id='ci-crash-running'",
      ).get();
      assert.equal(recovery.status,"queued");
      assert.equal(recovery.error,"recovered_after_restart");
      await assert.rejects(reconcileSyntheticActiveQuarantine({
        sqlite,postgres:neverPg,witness,key:signerKey,consent,
      }),/unsafe_active_job_shape_refused/);
      await assertNoRuntimeJobWrites(pg);
      assert.equal(await quarantineCount(pg),2);
    }finally{
      sqlite=null;restarted.close();
    }
    console.log(JSON.stringify({
      tasks:["ORB-004","ORB-005","ORB-016","ORB-017"],
      scope:"ci_only_sqlite_v7_pg16_cross_store_crash_windows",
      preCommitActorSigkilled:true,pgTransactionRolledBack:true,
      sourceJobRowsPreservedUntilRestart:true,
      postCommitActorSigkilled:true,privatePgRowsCommitted:2,
      independentSourceReopenAndSignatureReconciled:true,
      duplicateStagingDenied:true,
      persistentSourceDriftDeniedBeforePg:true,
      sqliteStartupRunningJobRequeued:true,
      recoveredJobRequarantineDenied:true,
      publicJobs:0,publicOutbox:0,providerCalls:0,redisSignals:0,
      runtimeReplayAuthorized:false,crossStoreAtomicCommitProven:false,
      productionUpgradeReady:false,
    }));
  }finally{
    if(sqlite)sqlite.close();
    await pg.end();
    rmSync(scratch,{force:true,recursive:true});
  }
}

if(process.argv[2]==="--actor"){
  if(!["precommit","postcommit"].includes(process.argv[3]) ||
      typeof process.argv[4]!=="string")throw new Error("ci_cross_store_actor_mode_invalid");
  await crashActor(process.argv[3],process.argv[4]);
}else if(process.argv.length===2){
  await parentScenario();
}else{
  throw new Error("ci_cross_store_crash_invalid_arguments");
}
