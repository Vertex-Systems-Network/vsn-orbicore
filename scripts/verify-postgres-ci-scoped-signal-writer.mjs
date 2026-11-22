import assert from "node:assert/strict";
import { randomBytes,randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createClient } from "redis";
import { createCiScopedSignalRecorder } from "../apps/api/ci-scoped-signal-recorder.mjs";
import { createSyntheticRedisJobRunner } from "../apps/api/synthetic-redis-worker.mjs";

if(process.env.GITHUB_ACTIONS!=="true"||
   process.env.ORBICORE_CI_SYNTHETIC_SIGNAL_SCOPE!=="1")
 throw new Error("ci_signal_scope_hosted_gate_required");
const pgConfig={
 host:process.env.PGHOST??"127.0.0.1",
 port:Number(process.env.PGPORT??5432),
 database:process.env.PGDATABASE??"orbicore",
 connectionTimeoutMillis:5000,
};
const admin=new Pool({...pgConfig,user:process.env.PGUSER??"orbicore",password:process.env.PGPASSWORD,max:3});
const redis=createClient({
 url:process.env.ORBICORE_CI_REDIS_URL??"redis://127.0.0.1:6379",
 disableOfflineQueue:true,
});
redis.on("error",()=>{});
const orgA="ci-signal-a-"+randomUUID();
const orgB="ci-signal-b-"+randomUUID();
const roleName=(prefix)=>"ci_sig_"+prefix+"_"+randomBytes(4).toString("hex");
const nameA=roleName("a"),nameB=roleName("b");
const passwordA=randomBytes(32).toString("base64url");
const passwordB=randomBytes(32).toString("base64url");
const pools=[],clients=[];
const getScoped=async(name,password)=>{
 const p=new Pool({...pgConfig,user:name,password,max:1});
 pools.push(p);
 const client=await p.connect();
 clients.push(client);
 await client.query("SET ROLE orbicore_ci_signal_recorder");
 // Only a CI fixture flag. This GUC alone is never authorization.
 await client.query("SET orbicore.ci_signal_fixture='enabled'");
 const who=(await client.query(
  "SELECT session_user AS login,current_user AS role",
 )).rows[0];
 assert.equal(who.login,name);
 assert.equal(who.role,"orbicore_ci_signal_recorder");
 return client;
};
const pending=async(runner)=>Number((await redis.sendCommand([
 "XPENDING",runner.stream,runner.group,
]))[0]);
try{
 await redis.connect();
 await admin.query(
  "INSERT INTO organizations(id,name) VALUES ($1,'Scoped A'),($2,'Scoped B')",
  [orgA,orgB],
 );
 // Scoped logins and their random credentials exist ONLY in this ephemeral
 // CI test database; no password value, SQL statement or dump is uploaded.
 for(const [name,password] of [[nameA,passwordA],[nameB,passwordB]]){
  await admin.query(
   "CREATE ROLE "+name+" LOGIN NOINHERIT NOBYPASSRLS PASSWORD '"+password+"'",
  );
  await admin.query("GRANT orbicore_ci_signal_recorder TO "+name);
 }
 await admin.query(
  "INSERT INTO ci_signal_writer_scopes(principal_name,organization_id) "+
  "VALUES($1,$2),($3,$4)",[nameA,orgA,nameB,orgB],
 );
 const clientA=await getScoped(nameA,passwordA);
 const clientB=await getScoped(nameB,passwordB);
 const recA=createCiScopedSignalRecorder({database:clientA});
 const recB=createCiScopedSignalRecorder({database:clientB});
 // Real authenticated non-owner PG login, NOT a superuser SET ROLE test.
 for(const cl of [clientA,clientB]){
  for(const q of [
   "SELECT 1 FROM public.job_signal_rejections",
   "SELECT 1 FROM public.ci_signal_writer_scopes",
   "SELECT 1 FROM public.users",
   "UPDATE public.job_signal_rejections SET occurrences=999",
   "DELETE FROM public.job_signal_rejections",
   "INSERT INTO public.job_signal_rejections(organization_id,redis_entry_id,reason,worker_id) "+
     "VALUES('forbidden','1-0','missing_job','forbidden')",
  ]){
   await assert.rejects(cl.query(q),(e)=>e.code==="42501");
  }
  await assert.rejects(cl.query("SET ROLE orbicore"),(e)=>e.code==="42501");
 }
 await recA.record({organizationId:orgA,redisId:"145-0",reason:"invalid_job_id",workerId:"ci-scoped"});
 await recA.record({organizationId:orgA,redisId:"145-0",reason:"invalid_job_id",workerId:"ci-scoped"});
 assert.equal((await recA.inspect({organizationId:orgA}))[0]?.occurrences,2);
 await assert.rejects(recA.record({
  organizationId:orgB,redisId:"146-0",reason:"missing_job",workerId:"ci-scoped",
 }),/ci_signal_record_scope_denied/);
 await clientA.query("SET orbicore.tenant_id='"+orgB+"'");
 await assert.rejects(recA.inspect({organizationId:orgB}),e=>e.code==="42501");
 await assert.rejects(recA.record({
  organizationId:orgA,redisId:"145-0",reason:"missing_job",workerId:"ci-scoped",
 }),/ci_signal_record_scope_denied/);
 assert.equal((await recA.inspect({organizationId:orgA}))[0]?.occurrences,2);
 assert.equal((await recB.inspect({organizationId:orgB})).length,0);
 assert.equal((await recB.inspect({organizationId:orgB,limit:2})).length,0);
 await assert.rejects(recA.inspect({organizationId:orgA,limit:101}),/invalid_metadata/);
 await assert.rejects(recA.record({
  organizationId:orgA,redisId:"bad;DROP TABLE",reason:"invalid_job_id",workerId:"ci-scoped",
 }),/invalid_metadata/);
 // Actually run the Redis consumer with a PRIVILEGED query pool for other
 // synthetic job operations but a SEPARATE non-owner authenticated pool for
 // the only evidence write/read path exercised by these signals.
 const runner=createSyntheticRedisJobRunner({
  pool:admin,redis,organizationId:orgA,workerId:"ci-scope-worker",
  rejectionRecorder:recA,
 });
 await runner.ensureGroup();
 const send=async(org,job)=>redis.sendCommand([
  "XADD",runner.stream,"*","organization_id",org,"job_id",job,
 ]);
 const mismatch=await send(orgB,"synthetic-other");
 assert.equal((await runner.consumeOne()).status,"rejected_invalid_signal");
 const malformed=await send(orgA,"../../synthetic");
 assert.equal((await runner.consumeOne()).status,"rejected_invalid_signal");
 const notFound=await send(orgA,"nonexistent-valid-synthetic-job");
 assert.equal((await runner.consumeOne()).status,"rejected_missing_job");
 assert.equal(await pending(runner),0);
 const rows=(await admin.query(
  "SELECT redis_entry_id,reason FROM job_signal_rejections "+
  "WHERE organization_id=$1 AND redis_entry_id=ANY($2::text[])",
  [orgA,[mismatch,malformed,notFound]],
 )).rows;
 assert.equal(rows.length,3);
 assert.equal(rows.find(x=>x.redis_entry_id===mismatch)?.reason,"tenant_mismatch");
 assert.equal(rows.find(x=>x.redis_entry_id===malformed)?.reason,"invalid_job_id");
 assert.equal(rows.find(x=>x.redis_entry_id===notFound)?.reason,"missing_job");
 assert.equal((await recB.inspect({organizationId:orgB})).length,0);

 // Actual permission-loss fault on the trusted SQL routine: without EXECUTE,
 // the restricted writer cannot save evidence, so Redis PEL remains pending.
 await admin.query(
  "REVOKE EXECUTE ON FUNCTION public.orbicore_ci_record_signal_rejection("+
  "TEXT,TEXT,TEXT,TEXT) FROM orbicore_ci_signal_recorder",
 );
 const failedId=await send(orgA,"../failure");
 try{
  await assert.rejects(runner.consumeOne(),(e)=>e.code==="42501");
  assert.equal(await pending(runner),1);
  assert.equal((await admin.query(
   "SELECT count(*)::int AS n FROM job_signal_rejections WHERE redis_entry_id=$1",
   [failedId],
  )).rows[0].n,0);
 }finally{
  await admin.query(
   "GRANT EXECUTE ON FUNCTION public.orbicore_ci_record_signal_rejection("+
   "TEXT,TEXT,TEXT,TEXT) TO orbicore_ci_signal_recorder",
  );
 }
 assert.equal((await runner.consumeOne({reclaim:true,minIdleMs:0})).status,
  "rejected_invalid_signal");
 assert.equal(await pending(runner),0);

 // Replaying the same redis id from a second DB session cannot cross tenants.
 assert.equal((await recB.inspect({organizationId:orgB})).length,0);
 assert.equal((await recA.inspect({organizationId:orgA})).length,5);
 // No API/worker role can reassign its own authorized tenant scope.
 await assert.rejects(clientA.query(
  "UPDATE ci_signal_writer_scopes SET organization_id=$1 WHERE principal_name=$2",
  [orgB,nameA],
 ),(e)=>e.code==="42501");
 console.log(JSON.stringify({
  check:"orb-004-ci-tenant-scoped-nonowner-rejection-writer",
  postgres16:true,redis7:true,realPGScopedLogins:true,
  directJobUserAuditAndScopeTablesDenied:true,
  roleEscalationDenied:true,scopeSetGucDoesNotAuthorize:true,
  crossTenantWriteAndReadDenied:true,conflictingReplayDenied:true,
  storedBeforeRedisAck:true,revokeFunctionBlocksAck:true,
  reclaimAfterGrantRestore:true,sensitivePayloadStored:false,
  producerAuthenticated:false,defaultWorkerRoleMigrated:false,
  productionAuthCutover:false,
 }));
}finally{
 for(const cl of clients)cl.release();
 await Promise.all(pools.map(p=>p.end()));
 if(redis.isOpen)await redis.close().catch(()=>redis.destroy());
 await admin.end();
}
