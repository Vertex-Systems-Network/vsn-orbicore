import assert from "node:assert/strict";
import {randomBytes,randomUUID} from "node:crypto";
import {Pool} from "pg";
import {createClient} from "redis";
import {createCiWakeupAttestor} from "../apps/api/ci-wakeup-attestation.mjs";
import {createCiScopedWorkerGateway} from "../apps/api/ci-scoped-worker-gateway.mjs";
import {createCiScopedSignalRecorder} from "../apps/api/ci-scoped-signal-recorder.mjs";
import {createSyntheticRedisJobRunner} from "../apps/api/synthetic-redis-worker.mjs";

if(process.env.GITHUB_ACTIONS!=="true"||
 process.env.ORBICORE_CI_SYNTHETIC_FULL_WORKER!=="1"||
 process.env.ORBICORE_CI_SYNTHETIC_SIGNAL_SCOPE!=="1"||
 process.env.ORBICORE_CI_SYNTHETIC_SIGNED_WAKEUP!=="1")
 throw new Error("ci_signed_wakeup_all_gates_required");

const dbConfig={
 host:process.env.PGHOST??"127.0.0.1",
 port:Number(process.env.PGPORT??5432),
 database:process.env.PGDATABASE??"orbicore",
 connectionTimeoutMillis:5000,
};
const admin=new Pool({...dbConfig,user:process.env.PGUSER??"orbicore",
 password:process.env.PGPASSWORD,max:3});
const redis=createClient({
 url:process.env.ORBICORE_CI_REDIS_URL??"redis://127.0.0.1:6379",
 disableOfflineQueue:true,
});
redis.on("error",()=>{});
const orgA="ci-signed-a-"+randomUUID(),orgB="ci-signed-b-"+randomUUID();
const actorA="ci-signed-user-a-"+randomUUID(),actorB="ci-signed-user-b-"+randomUUID();
const accountA="ci-signed-account-a-"+randomUUID(),accountB="ci-signed-account-b-"+randomUUID();
const loginA="ci_sig_wake_a_"+randomBytes(5).toString("hex");
const loginB="ci_sig_wake_b_"+randomBytes(5).toString("hex");
const passA=randomBytes(32).toString("base64url");
const passB=randomBytes(32).toString("base64url");
const v1={id:"ci_key_v1",key:randomBytes(32)};
const v2={id:"ci_key_v2",key:randomBytes(32)};
const oldKey=createCiWakeupAttestor({active:v1});
const rotated=createCiWakeupAttestor({active:v2,previous:[v1]});
const newKeyOnly=createCiWakeupAttestor({active:v2});
const resources=[];
const scoped=async(name,password)=>{
 const pool=new Pool({...dbConfig,user:name,password,max:1});
 const client=await pool.connect();
 resources.push({pool,client});
 await client.query("SET ROLE orbicore_ci_worker_gateway");
 await client.query("SET orbicore.ci_worker_fixture='enabled'");
 await client.query("SET orbicore.ci_signal_fixture='enabled'");
 assert.deepEqual((await client.query(
  "SELECT session_user AS login,current_user AS role",
 )).rows[0],{login:name,role:"orbicore_ci_worker_gateway"});
 return client;
};
const driver=client=>({
 query:(...args)=>client.query(...args),
 connect:async()=>({query:(...args)=>client.query(...args),release:()=>{}}),
});
const job=async({org=orgA,user=actorA,account=accountA}={})=>{
 const id="ci-signed-job-"+randomUUID();
 await admin.query(
  "INSERT INTO jobs(id,organization_id,type,account_id,requested_by,"+
   "status,idempotency_key) "+
   "VALUES($1,$2,'inventory_refresh',$3,$4,'queued',$5)",
  [id,org,account,user,"ci-signed-"+randomUUID()],
 );
 await admin.query(
  "INSERT INTO job_outbox(organization_id,job_id) VALUES($1,$2)",
  [org,id],
 );
 return id;
};
const sourceRow=async jobId=>(await admin.query(
 "SELECT id::text AS id,redis_entry_id,published_at FROM job_outbox WHERE job_id=$1",
 [jobId],
)).rows[0];
const send=async(stream,fields)=>redis.sendCommand([
 "XADD",stream,"*",...Object.entries(fields).flat(),
]);
const signatureFields=({organizationId,jobId,outboxId},attestor=oldKey)=>({
 organization_id:organizationId,job_id:jobId,outbox_id:outboxId,
 ...attestor.sign({organizationId,jobId,outboxId}),
});
const pending=async r=>Number((await redis.sendCommand([
 "XPENDING",r.stream,r.group,
]))[0]);
try{
 await redis.connect();
 await admin.query(
  "INSERT INTO organizations(id,name) VALUES($1,'Signed A'),($2,'Signed B')",
  [orgA,orgB],
 );
 for(const [id,org] of [[actorA,orgA],[actorB,orgB]]){
  await admin.query(
   "INSERT INTO users(id,organization_id,email,password_salt,password_hash,role)"+
    "VALUES($1,$2,$3,'no-real-salt','no-real-verifier','owner')",
   [id,org,id+"@example.test"],
  );
 }
 for(const [id,org] of [[accountA,orgA],[accountB,orgB]]){
  await admin.query(
   "INSERT INTO accounts(id,organization_id,label,provider,host,"+
    "username,health,used_bytes,quota_bytes,source) "+
    "VALUES($1,$2,'Synthetic','mock','no-live.example.invalid',"+
    "'none','healthy',1,10,'mock_fixture')",
   [id,org],
  );
 }
 for(const [name,password,org] of [
  [loginA,passA,orgA],[loginB,passB,orgB],
 ]){
  await admin.query(
   "CREATE ROLE "+name+" LOGIN NOINHERIT NOBYPASSRLS PASSWORD '"+password+"'",
  );
  await admin.query("GRANT orbicore_ci_worker_gateway TO "+name);
  await admin.query(
   "INSERT INTO ci_worker_principal_scopes(principal_name,organization_id) "+
    "VALUES($1,$2)",[name,org],
  );
  await admin.query(
   "INSERT INTO ci_signal_writer_scopes(principal_name,organization_id) "+
    "VALUES($1,$2)",[name,org],
  );
 }
 const clientA=await scoped(loginA,passA);
 const clientB=await scoped(loginB,passB);
 const ga=createCiScopedWorkerGateway({database:clientA});
 const gb=createCiScopedWorkerGateway({database:clientB});
 const ra=createCiScopedSignalRecorder({database:clientA});
 const rb=createCiScopedSignalRecorder({database:clientB});
 const make=(org,client,gateway,recorder,attestor,workerId)=>
   createSyntheticRedisJobRunner({
    pool:driver(client),redis,organizationId:org,
    workerId,leaseSeconds:5,
    jobGateway:gateway,rejectionRecorder:recorder,
    wakeupAttestor:attestor,
   });
 const runner=make(orgA,clientA,ga,ra,oldKey,"ci-signed-A");
 await runner.ensureGroup();

 // A genuine event is signed in memory before XADD and committed with exact
 // PostgreSQL outbox_id + Redis entry ID binding.
 const validJob=await job();
 const validPublish=await runner.publishOne();
 assert.equal(validPublish.jobId,validJob);
 const validRow=await sourceRow(validJob);
 assert.equal(validRow.redis_entry_id,validPublish.redisId);
 assert.equal((await runner.consumeOne()).status,"completed");
 assert.equal((await admin.query(
  "SELECT attempts FROM jobs WHERE id=$1",[validJob],
 )).rows[0].attempts,1);

 // Forged unsigned stream notification may reference a valid queued job,
 // but MUST NOT claim it. Only redacted signature failure is stored.
 const unsignedJob=await job();
 const forgedUnsigned=await send(runner.stream,{
  organization_id:orgA,job_id:unsignedJob,
 });
 assert.equal((await runner.consumeOne()).status,"rejected_invalid_signature");
 assert.equal((await admin.query(
  "SELECT status,attempts FROM jobs WHERE id=$1",[unsignedJob],
 )).rows[0].attempts,0);
 assert.equal((await admin.query(
  "SELECT reason FROM job_signal_rejections "+
   "WHERE organization_id=$1 AND redis_entry_id=$2",
  [orgA,forgedUnsigned],
 )).rows[0].reason,"invalid_signature");

 // Old signed HMAC copied into a different XADD stream entry is valid
 // cryptographically but no longer matches the committed PG redis_entry_id.
 const validEnvelope=signatureFields({
  organizationId:orgA,jobId:validJob,outboxId:validRow.id,
 });
 const copied=await send(runner.stream,validEnvelope);
 assert.equal((await runner.consumeOne()).status,"rejected_unanchored_signal");
 assert.equal((await admin.query(
  "SELECT reason FROM job_signal_rejections WHERE redis_entry_id=$1",
  [copied],
 )).rows[0].reason,"outbox_mismatch");
 assert.equal((await admin.query(
  "SELECT attempts FROM jobs WHERE id=$1",[validJob],
 )).rows[0].attempts,1);

 // Modified and extra fields, key substitution and parser-reserved fields
 // are never accepted as valid signatures, and cannot execute queued jobs.
 for(const modified of [
  {...validEnvelope,origin_mac:randomBytes(32).toString("hex")},
  {...validEnvelope,origin_key_id:"ci_wrong_key"},
  {...validEnvelope,job_id:"ci-injected-job"},
  {...validEnvelope,__proto_payload__:"attempted-extra"},
 ]){
  await send(runner.stream,modified);
  assert.equal((await runner.consumeOne()).status,"rejected_invalid_signature");
 }
 // Even an explicit Redis "__proto__" wire key cannot pollute the object
 // used to verify the allowlisted signed event fields.
 await redis.sendCommand(["XADD",runner.stream,"*",
  ...Object.entries(validEnvelope).flat(),
  "__proto__","attempted-pollution",
 ]);
 assert.equal((await runner.consumeOne()).status,"rejected_invalid_signature");

 // An old event verified with the previous-key rotation set is accepted.
 const oldJob=await job();
 const oldPublished=await runner.publishOne();
 // The previously rejected unsigned job has older, still unpublished outbox
 // intent. Because it was never signed, publish that job FIRST instead.
 assert.equal(oldPublished.jobId,unsignedJob);
 const rotatedRunner=make(orgA,clientA,ga,ra,rotated,"ci-signed-rotated");
 assert.equal((await rotatedRunner.consumeOne()).status,"completed");
 assert.equal((await rotatedRunner.publishOne()).jobId,oldJob);
 assert.equal((await rotatedRunner.consumeOne()).status,"completed");

 // Old-key-only signed wakeup is rejected when the verifier rotates
 // WITHOUT the previous key, then a resynced outbox can be republished with
 // active v2 and processed safely. Missing key always fails closed.
 const retired=await job();
 assert.equal((await runner.publishOne()).jobId,retired);
 const strictRunner=make(orgA,clientA,ga,ra,newKeyOnly,"ci-signed-v2-only");
 assert.equal((await strictRunner.consumeOne()).status,"rejected_invalid_signature");
 assert.equal((await admin.query(
  "SELECT attempts FROM jobs WHERE id=$1",[retired],
 )).rows[0].attempts,0);
 await admin.query(
  "UPDATE job_outbox SET published_at=clock_timestamp()-interval '120 seconds' "+
  "WHERE job_id=$1",[retired],
 );
 assert.deepEqual(await strictRunner.reconcileUnfinished({olderThanSeconds:1}),
  [retired]);
 assert.equal((await strictRunner.publishOne()).jobId,retired);
 assert.equal((await strictRunner.consumeOne()).status,"completed");

 // A valid signature is also insufficient when SQL EXECUTE is revoked.
 // The PG anchor call fails closed before claim or Redis XACK; regrant and
 // reclaim the SAME redis entry succeeds without duplicate job execution.
 const gatedJob=await job();
 assert.equal((await strictRunner.publishOne()).jobId,gatedJob);
 await admin.query(
  "REVOKE EXECUTE ON FUNCTION "+
    "public.orbicore_ci_worker_validate_wakeup(text,text,uuid,text) "+
    "FROM orbicore_ci_worker_gateway",
 );
 try{
  await assert.rejects(strictRunner.consumeOne(),e=>e.code==="42501");
  assert.equal(await pending(strictRunner),1);
 }finally{
  await admin.query(
   "GRANT EXECUTE ON FUNCTION "+
    "public.orbicore_ci_worker_validate_wakeup(text,text,uuid,text) "+
    "TO orbicore_ci_worker_gateway",
  );
 }
 assert.equal((await strictRunner.consumeOne({
  reclaim:true,minIdleMs:0,
 })).status,"completed");
 assert.equal(await pending(strictRunner),0);

 // Signatures are not tenant authorization: PostgreSQL scoped mapping must
 // also match the target worker's tenant and its own Redis entry.
 const otherRunner=make(orgB,clientB,gb,rb,oldKey,"ci-signed-B");
 await otherRunner.ensureGroup();
 const fromA=await send(otherRunner.stream,validEnvelope);
 assert.equal((await otherRunner.consumeOne()).status,
  "rejected_unanchored_signal");
 assert.equal((await admin.query(
  "SELECT reason FROM job_signal_rejections WHERE "+
  "organization_id=$1 AND redis_entry_id=$2",
  [orgB,fromA],
 )).rows[0].reason,"outbox_mismatch");
 await assert.rejects(gb.verifyPublishedOutbox({
  organizationId:orgA,jobId:validJob,outboxId:validRow.id,
  redisId:validPublish.redisId,
 }),e=>e.code==="42501");
 assert.equal((await rb.inspect({organizationId:orgB})).length,1);

 const statuses=(await admin.query(
  "SELECT count(*)::int AS total,sum(attempts)::int AS attempts FROM jobs "+
    "WHERE organization_id=$1",
  [orgA],
 )).rows[0];
 assert.equal(statuses.total>=5,true);
 console.log(JSON.stringify({
  check:"orb-004-signed-pg-anchored-redis-wakeups",
  actualPg16AndRedis7:true,realNonownerLoginScopes:2,
  hmacBeforeAnyJobClaim:true,unknownAndTamperedSignerDenied:true,
  redactedRejectionOnly:true,extraFieldsAndPrototypePayloadDenied:true,
  replayedMacDifferentRedisEntryDenied:true,
  activePlusPreviousKeyRotation:true,retiredKeyFailsClosed:true,
  redisReconciliationForRetiredKey:true,
  pgPrivilegeLossRetainsPendingEntry:true,grantRestoreReclaims:true,
  crossTenantSignedReplayDenied:true,
  realProviderActions:false,productionAuthAuthorityMoved:false,
  externalKmsOrRedisAclVerified:false,
 })+"\n");
}finally{
 for(const h of resources){h.client.release();await h.pool.end()}
 if(redis.isOpen)await redis.close().catch(()=>redis.destroy());
 await admin.end();
}
