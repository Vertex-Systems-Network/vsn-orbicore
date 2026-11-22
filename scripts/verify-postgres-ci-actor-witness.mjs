import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { createApp } from "../apps/api/server.mjs";
import { createCiSourceEventAttestor } from "../apps/api/ci-source-event-attestation.mjs";
import { initializeCiSourceEpochJournal, changeCiSourceCredential } from
  "../apps/api/postgres-ci-credential-invalidation.mjs";
import {
  createCiSourceWitness,inspectCiSourceWitnessCompleteness,
} from "../apps/api/ci-source-witness.mjs";
import { createCiReauthenticationShadowPilot } from
  "../apps/api/postgres-ci-credential-shadow.mjs";

for(const k of [
  "ORBICORE_CI_SYNTHETIC_SHADOW_SCHEMA","ORBICORE_CI_SYNTHETIC_REAUTH",
  "ORBICORE_CI_SYNTHETIC_RECONCILE",
  "ORBICORE_CI_SYNTHETIC_EVENT_ATTESTATION",
  "ORBICORE_CI_SYNTHETIC_ACTOR_AUTH","ORBICORE_CI_SYNTHETIC_WITNESS",
]){
  if(process.env.GITHUB_ACTIONS!=="true"||process.env[k]!=="1")
    throw new Error("ci_actor_witness_integration_gate_required");
}
const params={
 host:process.env.PGHOST??"127.0.0.1",
 port:Number(process.env.PGPORT??5432),
 user:process.env.PGUSER??"orbicore",
 database:process.env.PGDATABASE??"orbicore",
 password:process.env.PGPASSWORD,max:4,connectionTimeoutMillis:5000,
};
const admin=new Pool(params);
let writer,witnessPool;
const root=mkdtempSync(join(tmpdir(),"orbicore-ci-witness-"));
const dbPath=join(root,"source.sqlite");
const bootstrap=randomBytes(32).toString("hex");
let app=createApp({dbPath,startWorker:false,bootstrapToken:bootstrap});
const cred=()=>randomBytes(24).toString("base64url");
const records=[
 {id:"ci-owner-a",org:"ci-org-a",email:"owner-a@example.test",role:"owner",pwd:cred()},
 {id:"ci-operator-a",org:"ci-org-a",email:"operator-a@example.test",role:"operator",pwd:cred()},
 {id:"ci-viewer-a",org:"ci-org-a",email:"viewer-a@example.test",role:"viewer",pwd:cred()},
 {id:"ci-owner-b",org:"ci-org-b",email:"owner-b@example.test",role:"owner",pwd:cred()},
];
const [ownerA,operatorA,viewerA,ownerB]=records;
const attestor=createCiSourceEventAttestor({
 activeKey:{id:"source_witness_k1",bytes:randomBytes(32)},
});
const now=new Date().toISOString();
const events=()=>app.db.prepare(
 "SELECT sequence,event_id,organization_id,user_id,source_epoch,reason,"+
 "origin_key_id,origin_mac,actor_id,status,created_at "+
 "FROM ci_source_credential_outbox ORDER BY sequence",
).all();
const allWitness=async()=>(await admin.query(
 "SELECT organization_id,user_id,source_epoch,event_id,origin_key_id,"+
 "origin_mac,actor_id FROM orbicore_ci_shadow.source_event_witnesses "+
 "ORDER BY organization_id,user_id,source_epoch",
)).rows;
const inspect=async()=>inspectCiSourceWitnessCompleteness({
 sqlite:app.db,witnessRows:await allWitness(),attestor,
});
const eventCount=()=>events().length;
const sourceEpoch=(row)=>app.db.prepare(
 "SELECT epoch FROM ci_source_credential_epoch WHERE user_id=?",
).get(row.id).epoch;
async function seed(r){
 app.db.prepare("INSERT OR IGNORE INTO organizations(id,name,created_at) VALUES(?,?,?)")
   .run(r.org,"Disposable synthetic tenant",now);
 const salt=randomBytes(16).toString("hex");
 const hash=scryptSync(r.pwd,salt,64).toString("hex");
 app.db.prepare(
  "INSERT INTO users(id,organization_id,email,password_salt,password_hash,"+
  "role,disabled,mfa_enabled,created_at) VALUES(?,?,?,?,?,?,0,0,?)",
 ).run(r.id,r.org,r.email,salt,hash,r.role,now);
 app.db.prepare(
  "INSERT INTO ci_source_credential_epoch(user_id,epoch) VALUES(?,1)",
 ).run(r.id);
 await admin.query(
  "INSERT INTO public.organizations(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING",
  [r.org,"Disposable synthetic tenant"],
 );
 await admin.query(
  "INSERT INTO public.users(id,organization_id,email,password_salt,"+
  "password_hash,role,disabled,mfa_enabled) "+
  "VALUES($1,$2,$3,'ci_reauth_fixture_no_pg_login',"+
  "'ci-no-password-verifier',$4,false,false)",
  [r.id,r.org,r.email,r.role],
 );
}
async function makeRole(name,role){
 const password=randomBytes(24).toString("hex");
 await admin.query(
  "CREATE ROLE "+name+" LOGIN NOINHERIT NOBYPASSRLS PASSWORD '"+password+"'",
 );
 await admin.query(
  "GRANT "+role+" TO "+name+" WITH SET TRUE, INHERIT FALSE",
 );
 return new Pool({...params,user:name,password});
}
async function roleQuery(pool,role,query,args=[]){
 const client=await pool.connect();
 try{
  await client.query("BEGIN");
  await client.query("SET LOCAL ROLE "+role);
  const r=await client.query(query,args);
  await client.query("COMMIT");
  return r;
 }catch(e){await client.query("ROLLBACK");throw e}
 finally{client.release()}
}
const change=(target,kind,actor,pwd,options={})=>
 changeCiSourceCredential({
  sqlite:app.db,userId:target.id,kind,actorId:actor.id,
  actorPassword:pwd,attestor,...options,
 });
try{
 initializeCiSourceEpochJournal(app.db);
 for(const r of records)await seed(r);
 writer=await makeRole("orbicore_ci_witness_shadow_login",
  "orbicore_ci_shadow_writer");
 witnessPool=await makeRole("orbicore_ci_witness_restricted_login",
  "orbicore_ci_source_witness_writer");
 const grants=(await admin.query(
  "SELECT has_schema_privilege('orbicore_ci_source_witness_writer',"+
  "'orbicore_ci_shadow','USAGE') AS usage,"+
  "has_table_privilege('orbicore_ci_source_witness_writer',"+
  "'orbicore_ci_shadow.source_event_witnesses','SELECT') AS readable,"+
  "has_table_privilege('orbicore_ci_source_witness_writer',"+
  "'orbicore_ci_shadow.source_event_witnesses','DELETE') AS deletable,"+
  "has_function_privilege('orbicore_ci_source_witness_writer',"+
  "'orbicore_ci_shadow.anchor_source_event_witness(text,text,bigint,text,text,text,text)',"+
  "'EXECUTE') AS executable",
 )).rows[0];
 assert.deepEqual(grants,{
  usage:true,readable:false,deletable:false,executable:true,
 });
 await assert.rejects(roleQuery(
  witnessPool,"orbicore_ci_source_witness_writer",
  "SELECT COUNT(*) FROM orbicore_ci_shadow.source_event_witnesses",
 ),e=>e.code==="42501");
 await assert.rejects(roleQuery(
  witnessPool,"orbicore_ci_source_witness_writer",
  "DELETE FROM orbicore_ci_shadow.source_event_witnesses",
 ),e=>e.code==="42501");
 assert.deepEqual(await inspect(),{complete:true,witnessedEvents:0});

 const pilot=createCiReauthenticationShadowPilot({
  sqlite:app.db,postgres:writer,
 });
 assert.equal(await pilot.stage({
  userId:operatorA.id,password:operatorA.pwd,expectedSourceEpoch:1,
  idempotencyKey:"a".repeat(64),
 }),true);
 const unchanged=app.db.prepare(
  "SELECT password_hash FROM users WHERE id=?",
 ).get(operatorA.id).password_hash;
 const denied=[
  ()=>change(operatorA,"password_reset",operatorA,"not-the-password",
   {newPassword:cred()}),
  ()=>change(operatorA,"disabled",viewerA,viewerA.pwd),
  ()=>change(operatorA,"disabled",ownerB,ownerB.pwd),
  ()=>change(ownerB,"disabled",ownerA,ownerA.pwd),
  ()=>change(ownerA,"disabled",ownerA,ownerA.pwd),
  ()=>change(viewerA,"role_revoked",operatorA,operatorA.pwd),
  ()=>change(operatorA,"password_reset",{id:"missing-actor"},cred(),
   {newPassword:cred()}),
 ];
 for(const deny of denied) assert.equal(deny(),false);
 assert.equal(eventCount(),0);
 assert.equal(sourceEpoch(operatorA),1);
 assert.equal(app.db.prepare(
  "SELECT password_hash FROM users WHERE id=?",
 ).get(operatorA.id).password_hash,unchanged);

 const nextPass=cred();
 const a=change(operatorA,"password_reset",operatorA,operatorA.pwd,
  {newPassword:nextPass});
 assert.equal(a.sourceEpoch,2);
 const b=change(operatorA,"disabled",ownerA,ownerA.pwd);
 assert.equal(b.sourceEpoch,3);
 const c=change(viewerA,"role_revoked",ownerA,ownerA.pwd);
 assert.equal(c.sourceEpoch,2);
 const d=change(ownerA,"mfa_enrolled",ownerA,ownerA.pwd);
 assert.equal(d.sourceEpoch,2);
 assert.equal(change(viewerA,"disabled",ownerA,ownerA.pwd),false);
 assert.equal(change(operatorA,"password_reset",operatorA,nextPass,
  {newPassword:cred()}),false); // actor disabled
 assert.equal(eventCount(),4);
 assert.equal(await inspect().then(x=>x.complete),false); // no external witness
 for(const e of events()){
  assert.equal(e.actor_id!==null,true);
  assert.equal(attestor.verify(e),true);
 }
 const saved=events();
 app.db.prepare(
  "UPDATE ci_source_credential_outbox SET actor_id=? WHERE event_id=?",
 ).run(ownerB.id,a.eventId);
 assert.equal(attestor.verify(events()[0]),false);
 app.db.prepare(
  "UPDATE ci_source_credential_outbox SET actor_id=? WHERE event_id=?",
 ).run(operatorA.id,a.eventId);
 const w=createCiSourceWitness({
  sqlite:app.db,postgres:witnessPool,attestor,
 });
 // The source commit occurred already. A failed post-PG-commit send must be
 // re-triable with the same immutable, signed event.
 await assert.rejects(w.anchorPending({injectAfterPgCommit:true}),
  /ci_source_witness_post_commit_interruption/);
 assert.equal((await allWitness()).length,1);
 assert.equal((await inspect()).complete,false);
 assert.deepEqual(await w.anchorPending(),{anchored:4});
 assert.deepEqual(await w.anchorPending(),{anchored:4});
 assert.equal((await allWitness()).length,4);
 assert.deepEqual(await inspect(),{complete:true,witnessedEvents:4});

 // A different event cannot overwrite an existing witness at same epoch.
 const conflicting=await roleQuery(
  witnessPool,"orbicore_ci_source_witness_writer",
  "SELECT orbicore_ci_shadow.anchor_source_event_witness("+
  "$1,$2,$3,$4,$5,$6,$7) AS ok",
  [operatorA.org,operatorA.id,2,"f".repeat(64),
   saved[0].origin_key_id,saved[0].origin_mac,operatorA.id],
 );
 assert.equal(conflicting.rows[0].ok,false);
 assert.deepEqual(await inspect(),{complete:true,witnessedEvents:4});

 // A witnessed event deleted from SQLite is detected using the separately
 // retained Postgres witness, even though the SQLite source epoch remains 3.
 app.db.prepare("DELETE FROM ci_source_credential_outbox WHERE event_id=?")
  .run(a.eventId);
 assert.equal((await inspect()).complete,false);
 const removed=saved.find(e=>e.event_id===a.eventId);
 app.db.prepare(
  "INSERT INTO ci_source_credential_outbox("+
  "sequence,event_id,organization_id,user_id,source_epoch,reason,"+
  "origin_key_id,origin_mac,actor_id,status,created_at) "+
  "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
 ).run(removed.sequence,removed.event_id,removed.organization_id,
  removed.user_id,removed.source_epoch,removed.reason,removed.origin_key_id,
  removed.origin_mac,removed.actor_id,removed.status,removed.created_at);
 assert.deepEqual(await inspect(),{complete:true,witnessedEvents:4});

 // Corrupted source epoch and post-witness MAC mutation must fail closed.
 app.db.prepare(
  "UPDATE ci_source_credential_epoch SET epoch=1 WHERE user_id=?",
 ).run(operatorA.id);
 assert.equal((await inspect()).complete,false);
 app.db.prepare(
  "UPDATE ci_source_credential_epoch SET epoch=3 WHERE user_id=?",
 ).run(operatorA.id);
 app.db.prepare(
  "UPDATE ci_source_credential_outbox SET origin_mac=? WHERE event_id=?",
 ).run("f".repeat(64),b.eventId);
 assert.equal((await inspect()).complete,false);
 app.db.prepare(
  "UPDATE ci_source_credential_outbox SET origin_mac=? WHERE event_id=?",
 ).run(saved.find(e=>e.event_id===b.eventId).origin_mac,b.eventId);
 assert.deepEqual(await inspect(),{complete:true,witnessedEvents:4});

 // A privileged PG table deletion cannot be performed by restricted role;
 // injected owner tampering is independently seen as an incomplete witness.
 await admin.query(
  "DELETE FROM orbicore_ci_shadow.source_event_witnesses WHERE event_id=$1",
  [c.eventId],
 );
 assert.equal((await inspect()).complete,false);
 assert.deepEqual(await w.anchorPending(),{anchored:4});
 assert.deepEqual(await inspect(),{complete:true,witnessedEvents:4});

 // A real SQLite close/reopen does not make the witness disappear.
 app.close();
 app=createApp({dbPath,startWorker:false,bootstrapToken:bootstrap});
 initializeCiSourceEpochJournal(app.db);
 assert.deepEqual(await inspect(),{complete:true,witnessedEvents:4});

 // Deleting an event before anchoring would also fail the local source
 // epoch completeness scan. This does NOT prove against compromise of
 // both SQLite epoch and its unwitnessed outbox before PG capture.
 const later=change(viewerA,"mfa_enrolled",viewerA,viewerA.pwd);
 assert.equal(later.sourceEpoch,3);
 assert.equal((await inspect()).complete,false);
 app.db.prepare("DELETE FROM ci_source_credential_outbox WHERE event_id=?")
  .run(later.eventId);
 assert.equal((await inspect()).complete,false);

 process.stdout.write(JSON.stringify({
  check:"orb-005-ci-actor-witness-completeness",
  syntheticOnly:true,actualPostgres16:true,fileBackedSqliteRestart:true,
  actorFreshPasswordAndTenantRBAC:true,
  unauthorizedAndCrossTenantDenied:true,
  actorSignedMacV2:true,independentPgWitness:true,
  restrictedNonOwnerNoReadOrDelete:true,
  appendOnceIdempotentAndConflictDenied:true,
  postCommitRetry:true,missingWitnessDenied:true,
  deletedAnchoredEventDetected:true,modifiedActorAndMacDetected:true,
  epochRegressionDetected:true,missingUnwitnessedEventDetected:true,
  postgresLoginAuthority:false,defaultHttpModified:false,
  independentPowerLossRecovery:false,
 })+"\n");
} finally{
 if(writer)await writer.end();
 if(witnessPool)await witnessPool.end();
 app.close();
 await admin.end();
 rmSync(root,{recursive:true,force:true});
}
