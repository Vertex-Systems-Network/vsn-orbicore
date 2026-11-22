import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createClient } from "redis";
import { createCiScopedWorkerGateway } from "../apps/api/ci-scoped-worker-gateway.mjs";
import { createCiScopedSignalRecorder } from "../apps/api/ci-scoped-signal-recorder.mjs";
import { createSyntheticRedisJobRunner } from "../apps/api/synthetic-redis-worker.mjs";

if(process.env.GITHUB_ACTIONS!=="true" ||
   process.env.ORBICORE_CI_SYNTHETIC_FULL_WORKER!=="1" ||
   process.env.ORBICORE_CI_SYNTHETIC_SIGNAL_SCOPE!=="1")
  throw new Error("ci_full_worker_hosted_fixture_gate_required");

const cfg={
  host:process.env.PGHOST??"127.0.0.1",
  port:Number(process.env.PGPORT??5432),
  database:process.env.PGDATABASE??"orbicore",
  connectionTimeoutMillis:5000,
};
const admin=new Pool({
  ...cfg,user:process.env.PGUSER??"orbicore",
  password:process.env.PGPASSWORD,max:4,
});
const redis=createClient({
  url:process.env.ORBICORE_CI_REDIS_URL??"redis://127.0.0.1:6379",
  disableOfflineQueue:true,
});
redis.on("error",()=>{});
const tenantA="ci-fw-a-"+randomUUID(),tenantB="ci-fw-b-"+randomUUID();
const accountA="ci-fw-account-a-"+randomUUID(),accountB="ci-fw-account-b-"+randomUUID();
const actorA="ci-fw-owner-"+randomUUID(),viewerA="ci-fw-viewer-"+randomUUID();
const actorB="ci-fw-owner-b-"+randomUUID();
const loginA="ci_fw_a_"+randomBytes(5).toString("hex");
const loginB="ci_fw_b_"+randomBytes(5).toString("hex");
const anon="ci_fw_anon_"+randomBytes(5).toString("hex");
const passwordA=randomBytes(32).toString("base64url");
const passwordB=randomBytes(32).toString("base64url");
const passwordAnon=randomBytes(32).toString("base64url");
const handles=[];
async function connectRestricted(login,password){
  const pool=new Pool({...cfg,user:login,password,max:1});
  const client=await pool.connect();
  handles.push({pool,client});
  await client.query("SET ROLE orbicore_ci_worker_gateway");
  await client.query("SET orbicore.ci_worker_fixture='enabled'");
  await client.query("SET orbicore.ci_signal_fixture='enabled'");
  const who=(await client.query(
    "SELECT session_user AS authenticated,current_user AS role",
  )).rows[0];
  assert.equal(who.authenticated,login);
  assert.equal(who.role,"orbicore_ci_worker_gateway");
  return client;
}
function restrictedDriver(client){
  // The entire runner sees only this actual non-superuser session. No
  // privileged PG Pool is exposed to the consumer anywhere in this test.
  return {query:(...args)=>client.query(...args),
    connect:async()=>({
      query:(...args)=>client.query(...args),
      release:()=>{},
    })};
}
const freshJob=async({
  tenant=tenantA,account=accountA,actor=actorA,
  status="queued",attempts=0,maxAttempts=3,
}={})=>{
  const id="ci-fw-job-"+randomUUID();
  await admin.query(
    "INSERT INTO jobs(id,organization_id,type,account_id,requested_by,"+
      "status,attempts,max_attempts,idempotency_key) "+
      "VALUES($1,$2,'inventory_refresh',$3,$4,$5,$6,$7,$8)",
    [id,tenant,account,actor,status,attempts,maxAttempts,"ci-fw-"+randomUUID()],
  );
  await admin.query(
    "INSERT INTO job_outbox(organization_id,job_id) VALUES($1,$2)",
    [tenant,id],
  );
  return id;
};
async function streamPending(runner){
  const result=await redis.sendCommand(["XPENDING",runner.stream,runner.group]);
  return Number(result[0]);
}
try{
  await redis.connect();
  await admin.query(
    "INSERT INTO organizations(id,name) VALUES($1,'CI worker tenant A'),($2,'CI worker tenant B')",
    [tenantA,tenantB],
  );
  for(const [id,tenant,role] of [
    [actorA,tenantA,"owner"],[viewerA,tenantA,"viewer"],
    [actorB,tenantB,"owner"],
  ]){
    await admin.query(
      "INSERT INTO users(id,organization_id,email,password_salt,password_hash,role) "+
      "VALUES($1,$2,$3,'ci-only-not-a-real-salt','ci-only-not-a-verifier',$4)",
      [id,tenant,id+"@example.test",role],
    );
  }
  for(const [id,tenant] of [[accountA,tenantA],[accountB,tenantB]]){
    await admin.query(
      "INSERT INTO accounts(id,organization_id,label,provider,host,username,"+
        "health,used_bytes,quota_bytes,source) "+
        "VALUES($1,$2,'Mock site','mock','no-provider.example.invalid',"+
        "'no-access','healthy',0,100,'mock_fixture')",
      [id,tenant],
    );
  }
  // Only admin-managed mapping can assign a PG login to a tenant.
  for(const [name,password,tenant] of [
    [loginA,passwordA,tenantA],[loginB,passwordB,tenantB],
    [anon,passwordAnon,null],
  ]){
    await admin.query(
      "CREATE ROLE "+name+" LOGIN NOINHERIT NOBYPASSRLS PASSWORD '"+password+"'",
    );
    if(tenant){
      await admin.query("GRANT orbicore_ci_worker_gateway TO "+name);
      await admin.query(
        "INSERT INTO ci_worker_principal_scopes(principal_name,organization_id) VALUES($1,$2)",
        [name,tenant],
      );
      await admin.query(
        "INSERT INTO ci_signal_writer_scopes(principal_name,organization_id) VALUES($1,$2)",
        [name,tenant],
      );
    }
  }
  const clientA=await connectRestricted(loginA,passwordA);
  const clientB=await connectRestricted(loginB,passwordB);
  const gatewayA=createCiScopedWorkerGateway({database:clientA});
  const gatewayB=createCiScopedWorkerGateway({database:clientB});
  const recorderA=createCiScopedSignalRecorder({database:clientA});
  const recorderB=createCiScopedSignalRecorder({database:clientB});

  const anonPool=new Pool({...cfg,user:anon,password:passwordAnon,max:1});
  const anonClient=await anonPool.connect();
  handles.push({pool:anonPool,client:anonClient});
  await assert.rejects(
    anonClient.query(
      "SELECT public.orbicore_ci_worker_job_status($1,$2)",
      [tenantA,"ci-test-job"],
    ),
    (e)=>e.code==="42501",
  );
  // Direct job/outbox/users/secret/rejection/scope access is forbidden, even
  // for a real authenticated nonowner with the restricted function role.
  for(const cl of [clientA,clientB]){
    for(const stmt of [
      "SELECT 1 FROM public.jobs",
      "SELECT 1 FROM public.job_outbox",
      "SELECT 1 FROM public.users",
      "SELECT 1 FROM public.accounts",
      "SELECT 1 FROM public.secret_references",
      "SELECT 1 FROM public.ci_worker_principal_scopes",
      "SELECT 1 FROM public.job_signal_rejections",
      "UPDATE public.jobs SET status='completed'",
      "DELETE FROM public.job_outbox",
      "SELECT public.orbicore_ci_worker_require_scope('bad-tenant')",
      "SET ROLE orbicore",
    ]){
      await assert.rejects(cl.query(stmt),(e)=>e.code==="42501");
    }
  }
  const own=(await clientA.query(
    "SELECT has_function_privilege('orbicore_ci_worker_gateway',"+
      "'public.orbicore_ci_worker_finalize(text,text,uuid)','EXECUTE') AS can_finalize",
  )).rows[0];
  assert.equal(own.can_finalize,true);
  await clientA.query("SET orbicore.tenant_id='"+tenantB+"'");
  await assert.rejects(
    gatewayA.getJob({organizationId:tenantB,jobId:"ci-foreign"}),
    (e)=>e.code==="42501",
  );
  await assert.rejects(
    gatewayB.failExpired({organizationId:tenantA}),
    (e)=>e.code==="42501",
  );
  await assert.rejects(
    gatewayB.publishOne({
      organizationId:tenantA,redis,
      stream:"orbicore:synthetic:jobs:v1:"+tenantA,
    }),
    (e)=>e.code==="42501",
  );
  assert.equal((await gatewayA.getJob({
    organizationId:tenantA,jobId:"ci-not-exist",
  })),null);
  assert.equal((await recorderB.inspect({organizationId:tenantB})).length,0);

  const runnerA=createSyntheticRedisJobRunner({
    pool:restrictedDriver(clientA),redis,organizationId:tenantA,
    workerId:"ci-scoped-full-worker",leaseSeconds:5,
    jobGateway:gatewayA,rejectionRecorder:recorderA,
  });
  await runnerA.ensureGroup();
  const job1=await freshJob();
  const firstPublish=await runnerA.publishOne();
  assert.equal(firstPublish.jobId,job1);
  assert.equal((await runnerA.consumeOne()).status,"completed");
  const completed=(await admin.query(
    "SELECT status,attempts,result_json,error FROM jobs WHERE id=$1",[job1],
  )).rows[0];
  assert.equal(completed.status,"completed");
  assert.equal(completed.attempts,1);
  assert.equal(completed.result_json.live,false);
  assert.equal(completed.result_json.accountId,accountA);
  assert.equal(completed.error,null);

  // Duplicate delivery is acked but must not execute another attempt.
  await redis.sendCommand([
    "XADD",runnerA.stream,"*","organization_id",tenantA,"job_id",job1,
  ]);
  assert.equal((await runnerA.consumeOne()).status,"already_terminal");
  assert.equal((await admin.query(
    "SELECT attempts FROM jobs WHERE id=$1",[job1],
  )).rows[0].attempts,1);

  const viewerJob=await freshJob({actor:viewerA});
  assert.equal((await runnerA.publishOne()).jobId,viewerJob);
  assert.equal((await runnerA.consumeOne()).status,"policy_denied");
  assert.equal((await admin.query(
    "SELECT status,error FROM jobs WHERE id=$1",[viewerJob],
  )).rows[0].error,"synthetic_policy_denied");

  const disabledJob=await freshJob();
  assert.equal((await runnerA.publishOne()).jobId,disabledJob);
  await admin.query("UPDATE users SET disabled=true WHERE id=$1",[actorA]);
  assert.equal((await runnerA.consumeOne()).status,"policy_denied");
  await admin.query("UPDATE users SET disabled=false WHERE id=$1",[actorA]);

  // PostgreSQL cannot be told to publish/claim/cross-finalize tenant B.
  const bJob=await freshJob({tenant:tenantB,account:accountB,actor:actorB});
  await assert.rejects(
    gatewayA.claimSignaled({
      organizationId:tenantB,jobId:bJob,
      workerId:"ci-worker-a",leaseSeconds:5,
    }),(e)=>e.code==="42501",
  );
  assert.equal((await gatewayA.getJob({
    organizationId:tenantA,jobId:bJob,
  })),null);
  const bRunner=createSyntheticRedisJobRunner({
    pool:restrictedDriver(clientB),redis,organizationId:tenantB,
    workerId:"ci-scoped-b",jobGateway:gatewayB,rejectionRecorder:recorderB,
  });
  await bRunner.ensureGroup();
  assert.equal((await bRunner.publishOne()).jobId,bJob);
  assert.equal((await bRunner.consumeOne()).status,"completed");
  assert.equal((await recorderA.inspect({organizationId:tenantA})).length,0);

  // A Redis outage must not commit published_at on the scoped outbox row.
  const publishFaultJob=await freshJob();
  await assert.rejects(
    gatewayA.publishOne({
      organizationId:tenantA,stream:runnerA.stream,
      redis:{async sendCommand(){throw new Error("ci_redis_publish_down")}},
    }),/ci_redis_publish_down/,
  );
  assert.equal((await admin.query(
    "SELECT published_at FROM job_outbox WHERE job_id=$1",[publishFaultJob],
  )).rows[0].published_at,null);
  assert.equal((await runnerA.publishOne()).jobId,publishFaultJob);
  assert.equal((await runnerA.consumeOne()).status,"completed");

  // Lose an already-published Redis signal; PG outbox reconciliation should
  // make it publishable again without escaping the role's tenant.
  const lostSignalJob=await freshJob();
  const lostSignal=await runnerA.publishOne();
  assert.equal(lostSignal.jobId,lostSignalJob);
  assert.equal(await redis.sendCommand([
    "XDEL",runnerA.stream,lostSignal.redisId,
  ]),1);
  await admin.query(
    "UPDATE job_outbox SET published_at=clock_timestamp()-interval '120 seconds' WHERE job_id=$1",
    [lostSignalJob],
  );
  assert.deepEqual(
    await runnerA.reconcileUnfinished({olderThanSeconds:1}),
    [lostSignalJob],
  );
  assert.equal((await runnerA.publishOne()).jobId,lostSignalJob);
  assert.equal((await runnerA.consumeOne()).status,"completed");

  // A real, fresh claim token cannot be reused after lease replacement.
  const fencingJob=await freshJob();
  const stale=await gatewayA.claimSignaled({
    organizationId:tenantA,jobId:fencingJob,
    workerId:"ci-old-worker",leaseSeconds:5,
  });
  await admin.query(
    "UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [fencingJob],
  );
  const current=await gatewayA.claimSignaled({
    organizationId:tenantA,jobId:fencingJob,
    workerId:"ci-new-worker",leaseSeconds:5,
  });
  assert.notEqual(stale,current);
  assert.equal(await gatewayA.finalize({
    organizationId:tenantA,jobId:fencingJob,claimToken:stale,
  }),"lost_lease");
  assert.equal(await gatewayA.finalize({
    organizationId:tenantA,jobId:fencingJob,claimToken:current,
  }),"completed");

  // Inject SQL permission loss DURING a real Redis consumer claim. The
  // XACK must not happen, and after regrant + expired lease, replay completes.
  const revokeJob=await freshJob();
  assert.equal((await runnerA.publishOne()).jobId,revokeJob);
  await admin.query(
    "REVOKE EXECUTE ON FUNCTION public.orbicore_ci_worker_finalize(text,text,uuid) "+
      "FROM orbicore_ci_worker_gateway",
  );
  try{
    await assert.rejects(runnerA.consumeOne(),(e)=>e.code==="42501");
    assert.equal(await streamPending(runnerA),1);
  }finally{
    await admin.query(
      "GRANT EXECUTE ON FUNCTION public.orbicore_ci_worker_finalize(text,text,uuid) "+
        "TO orbicore_ci_worker_gateway",
    );
  }
  await admin.query(
    "UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [revokeJob],
  );
  assert.equal((await runnerA.consumeOne({
    reclaim:true,minIdleMs:0,
  })).status,"completed");
  assert.equal(await streamPending(runnerA),0);
  assert.equal((await admin.query(
    "SELECT attempts FROM jobs WHERE id=$1",[revokeJob],
  )).rows[0].attempts,2);

  // Expired, attempt-exhausted jobs fail via scoped fixed function.
  const expiredJob=await freshJob({status:"running",attempts:3,maxAttempts:3});
  await admin.query(
    "UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [expiredJob],
  );
  assert.equal(await runnerA.failExpired(),1);
  assert.equal((await admin.query(
    "SELECT status,error FROM jobs WHERE id=$1",[expiredJob],
  )).rows[0].error,"lease_retry_exhausted");

  // Poison signals are also recorded through the SAME nonowner PG session
  // without direct table privileges, and not acknowledged on SQL failure.
  const spoofedId=await redis.sendCommand([
    "XADD",runnerA.stream,"*","organization_id",tenantB,
    "job_id","synthetic-spoofed-tenant-job",
  ]);
  assert.equal((await runnerA.consumeOne()).status,"rejected_invalid_signal");
  assert.equal((await recorderA.inspect({organizationId:tenantA})).length,1);
  assert.equal((await recorderB.inspect({organizationId:tenantB})).length,0);
  assert.equal((await admin.query(
    "SELECT reason FROM job_signal_rejections WHERE organization_id=$1 AND redis_entry_id=$2",
    [tenantA,spoofedId],
  )).rows[0].reason,"tenant_mismatch");
  const privateColumns=(await admin.query(
    "SELECT column_name FROM information_schema.columns "+
      "WHERE table_name='ci_worker_principal_scopes' ORDER BY column_name",
  )).rows.map(x=>x.column_name);
  assert.deepEqual(privateColumns.sort(),[
    "organization_id","principal_name","registered_at",
  ]);
  console.log(JSON.stringify({
    check:"orb-004-ci-full-nonowner-worker-gateway",
    realPg16AndRedis7:true,authenticatedPgLogins:3,
    rawJobsAndSecretsUnreadable:true,tenantScopeBindsSessionUser:true,
    crossTenantWorkAndRoleEscalationDenied:true,
    outboxRedisFailureRollsBack:true,reconcileLostRedisSignal:true,
    syntheticCompleteWithoutProvider:true,
    staleLeaseFencing:true,actorRevocationPolicyDenied:true,
    permissionLossPreservesPel:true,permissionRecoveryReclaims:true,
    poisonSignalsRecordedWithoutPrivilegedPool:true,
    publisherProvenanceSigned:false,
    productionWorkerEnabled:false,productionLoginCutover:false,
  })+"\n");
}finally{
  for(const h of handles){h.client.release();await h.pool.end()}
  if(redis.isOpen)await redis.close().catch(()=>redis.destroy());
  await admin.end();
}
