import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { createApp } from "../apps/api/server.mjs";
import { createCiSourceEventAttestor } from "../apps/api/ci-source-event-attestation.mjs";
import { initializeCiSourceEpochJournal,changeCiSourceCredential,
 createCiSourceEpochReconciler } from
 "../apps/api/postgres-ci-credential-invalidation.mjs";
import { createCiSourceWitness } from "../apps/api/ci-source-witness.mjs";
import { createCiReauthenticationShadowPilot } from
 "../apps/api/postgres-ci-credential-shadow.mjs";
import { createCiDetachedWitnessSigner } from
 "../apps/api/ci-detached-witness-checkpoint.mjs";
import { inspectCiShadowEvidenceReadiness } from
 "../apps/api/ci-shadow-readiness-probe.mjs";

const required=[
 "ORBICORE_CI_SYNTHETIC_SHADOW_SCHEMA","ORBICORE_CI_SYNTHETIC_REAUTH",
 "ORBICORE_CI_SYNTHETIC_RECONCILE","ORBICORE_CI_SYNTHETIC_EVENT_ATTESTATION",
 "ORBICORE_CI_SYNTHETIC_ACTOR_AUTH","ORBICORE_CI_SYNTHETIC_WITNESS",
 "ORBICORE_CI_SYNTHETIC_DETACHED_CHECKPOINT",
];
if(process.env.GITHUB_ACTIONS!=="true" ||
   required.some(k=>process.env[k]!=="1"))
 throw new Error("ci_detached_readiness_hosted_gate_required");
const config={
 host:process.env.PGHOST??"127.0.0.1",
 port:Number(process.env.PGPORT??5432),
 user:process.env.PGUSER??"orbicore",database:process.env.PGDATABASE??"orbicore",
 password:process.env.PGPASSWORD,max:5,connectionTimeoutMillis:5000,
};
const admin=new Pool(config);
const root=mkdtempSync(join(tmpdir(),"orbicore-ci-detached-"));
const sourcePath=join(root,"sqlite","source.sqlite");
const detachedDir=join(root,"auditor-not-source");
mkdirSync(join(root,"sqlite"));
mkdirSync(detachedDir);
const detachedFile=join(detachedDir,"pinned-witness-head.json");
const bootstrap=randomBytes(32).toString("hex");
let app=createApp({dbPath:sourcePath,startWorker:false,bootstrapToken:bootstrap});
let shadowPool,witnessPool,reconcilePool;
const pass=()=>randomBytes(24).toString("base64url");
const actor={org:"ci-detached-org-a",id:"ci-detached-owner",role:"owner",
 email:"ci-detached-owner@example.test",password:pass()};
const subject={org:actor.org,id:"ci-detached-member",role:"operator",
 email:"ci-detached-operator@example.test",password:pass()};
const unmodified={org:"ci-detached-org-b",id:"ci-detached-other",role:"owner",
 email:"ci-detached-other@example.test",password:pass()};
const people=[actor,subject,unmodified];
const attest=createCiSourceEventAttestor({
 activeKey:{id:"source_k1",bytes:randomBytes(32)},
});
const firstKey={id:"auditor_k1",bytes:randomBytes(32)};
const secondKey={id:"auditor_k2",bytes:randomBytes(32)};
const signer=createCiDetachedWitnessSigner({activeKey:firstKey});
const now=new Date().toISOString();
const events=()=>app.db.prepare(
 "SELECT sequence,event_id,organization_id,user_id,source_epoch,reason,"+
 "origin_key_id,origin_mac,actor_id,status,created_at "+
 "FROM ci_source_credential_outbox ORDER BY sequence",
).all();
const witnessRows=async()=>(await admin.query(
 "SELECT organization_id,user_id,source_epoch,event_id,"+
 "origin_key_id,origin_mac,actor_id "+
 "FROM orbicore_ci_shadow.source_event_witnesses",
)).rows;
const fenceRows=async()=>(await admin.query(
 "SELECT organization_id,user_id,confirmed_epoch "+
 "FROM orbicore_ci_shadow.source_epoch_fences",
)).rows;
const draftRows=async()=>(await admin.query(
 "SELECT organization_id,user_id,source_epoch,state "+
 "FROM orbicore_ci_shadow.reauth_drafts",
)).rows;
let pinnedMac;
let minimumSequence=1;
async function inspect(checkpoint,override={}){
 return inspectCiShadowEvidenceReadiness({
  sqlite:app.db,attestor:attest,
  witnessRows:await witnessRows(),fenceRows:await fenceRows(),
  draftRows:await draftRows(),
  signer,checkpoint,pinnedMac,minimumSequence,
  ...override,
 });
}
const deny=async(checkpoint,override={})=>{
 const result=await inspect(checkpoint,override);
 assert.equal(result.fixtureConsistent,false);
 assert.equal(result.productionLoginAuthorized,false);
};
async function seeded(p){
 app.db.prepare("INSERT OR IGNORE INTO organizations(id,name,created_at) VALUES(?,?,?)")
  .run(p.org,"Synthetic tenant",now);
 const salt=randomBytes(16).toString("hex");
 const verifier=scryptSync(p.password,salt,64).toString("hex");
 app.db.prepare(
  "INSERT INTO users(id,organization_id,email,password_salt,password_hash,"+
  "role,disabled,mfa_enabled,created_at) VALUES(?,?,?,?,?,?,0,0,?)",
 ).run(p.id,p.org,p.email,salt,verifier,p.role,now);
 app.db.prepare("INSERT INTO ci_source_credential_epoch(user_id,epoch) VALUES(?,1)")
  .run(p.id);
 await admin.query("INSERT INTO public.organizations(id,name) VALUES($1,$2) "+
  "ON CONFLICT DO NOTHING",[p.org,"Synthetic tenant"]);
 await admin.query(
  "INSERT INTO public.users(id,organization_id,email,password_salt,"+
  "password_hash,role,disabled,mfa_enabled) VALUES("+
  "$1,$2,$3,'ci_reauth_fixture_no_pg_login','ci-not-pg-verifier',$4,false,false)",
  [p.id,p.org,p.email,p.role],
 );
}
async function restricted(name,group){
 const secret=randomBytes(24).toString("hex");
 await admin.query("CREATE ROLE "+name+
  " LOGIN NOINHERIT NOBYPASSRLS PASSWORD '"+secret+"'");
 await admin.query("GRANT "+group+" TO "+name+" WITH SET TRUE, INHERIT FALSE");
 return new Pool({...config,user:name,password:secret});
}
const change=(kind,actorRow,pwd,other={})=>changeCiSourceCredential({
 sqlite:app.db,userId:subject.id,kind,
 actorId:actorRow.id,actorPassword:pwd,attestor:attest,...other,
});
try{
 initializeCiSourceEpochJournal(app.db);
 for(const p of people)await seeded(p);
 shadowPool=await restricted("orbicore_ci_detached_shadow","orbicore_ci_shadow_writer");
 witnessPool=await restricted("orbicore_ci_detached_witness","orbicore_ci_source_witness_writer");
 reconcilePool=await restricted("orbicore_ci_detached_reconciler",
  "orbicore_ci_shadow_reconciler");
 const pilot=createCiReauthenticationShadowPilot({
  sqlite:app.db,postgres:shadowPool,
 });
 assert.equal(await pilot.stage({
  userId:subject.id,password:subject.password,expectedSourceEpoch:1,
  idempotencyKey:"b".repeat(64),
 }),true);
 const replacement=pass();
 const changed=change("password_reset",subject,subject.password,
  {newPassword:replacement});
 assert.equal(changed.sourceEpoch,2);
 const disabled=change("disabled",actor,actor.password);
 assert.equal(disabled.sourceEpoch,3);
 assert.equal(events().length,2);
 const witness=createCiSourceWitness({
  sqlite:app.db,postgres:witnessPool,attestor:attest,
 });
 await deny();
 assert.deepEqual(await witness.anchorPending(),{anchored:2});
 const rows=await witnessRows();
 const cp1=signer.issue({witnessRows:rows,sequence:1});
 pinnedMac=cp1.mac;
 // File lives apart from SQLite and PostgreSQL. It remains writable in
 // this same disposable CI runner: NOT an external auditor or actual WORM.
 writeFileSync(detachedFile,JSON.stringify(cp1),{flag:"wx",mode:0o600});
 const load=()=>JSON.parse(readFileSync(detachedFile,"utf8"));
 assert.deepEqual(load(),cp1);
 await deny(load()); // PG fence and SQLite ack are missing
 const reconciler=createCiSourceEpochReconciler({
  sqlite:app.db,postgres:reconcilePool,attestor:attest,
 });
 assert.deepEqual(await reconciler.reconcilePending(),
  {reconciled:2,pending:0});
 let positive=await inspect(load());
 assert.deepEqual(positive,{
  fixtureConsistent:true,productionLoginAuthorized:false,witnessedEvents:2,
 });
 // The record is valid only while the pinned, signer-authenticated PG
 // snapshot and all source/target epoch projections agree.
 await deny({...load(),mac:"f".repeat(64)});
 await deny({...load(),sequence:2});
 await deny(load(),{pinnedMac:"f".repeat(64)});
 await deny(load(),{minimumSequence:2});
 const wrongSigner=createCiDetachedWitnessSigner({
  activeKey:{id:"auditor_k1",bytes:randomBytes(32)},
 });
 await deny(load(),{signer:wrongSigner});
 const fromFile=readFileSync(detachedFile,"utf8");
 writeFileSync(detachedFile,"not-json");
 assert.throws(load,SyntaxError);
 writeFileSync(detachedFile,fromFile);
 unlinkSync(detachedFile);
 assert.throws(load,e=>e.code==="ENOENT");
 writeFileSync(detachedFile,fromFile,{flag:"wx",mode:0o600});
 assert.deepEqual(await inspect(load()),positive);
 // Real PostgreSQL owner deletion is detected by comparing the detached
 // pinned snapshot against the now-disagreeing live witness.
 const victim=(await witnessRows())[0];
 await admin.query(
  "DELETE FROM orbicore_ci_shadow.source_event_witnesses "+
  "WHERE organization_id=$1 AND user_id=$2 AND source_epoch=$3",
  [victim.organization_id,victim.user_id,victim.source_epoch],
 );
 await deny(load());
 assert.deepEqual(await witness.anchorPending(),{anchored:2});
 assert.deepEqual(await inspect(load()),positive);
 const sourceEvent=events()[0];
 app.db.prepare(
  "DELETE FROM ci_source_credential_outbox WHERE event_id=?",
 ).run(sourceEvent.event_id);
 await deny(load());
 app.db.prepare(
  "INSERT INTO ci_source_credential_outbox("+
  "sequence,event_id,organization_id,user_id,source_epoch,reason,"+
  "origin_key_id,origin_mac,actor_id,status,created_at) "+
  "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
 ).run(sourceEvent.sequence,sourceEvent.event_id,sourceEvent.organization_id,
  sourceEvent.user_id,sourceEvent.source_epoch,sourceEvent.reason,
  sourceEvent.origin_key_id,sourceEvent.origin_mac,sourceEvent.actor_id,
  sourceEvent.status,sourceEvent.created_at);
 assert.deepEqual(await inspect(load()),positive);
 app.db.prepare(
  "UPDATE ci_source_credential_outbox SET status='pending' WHERE event_id=?",
 ).run(sourceEvent.event_id);
 await deny(load());
 app.db.prepare(
  "UPDATE ci_source_credential_outbox SET status='reconciled' WHERE event_id=?",
 ).run(sourceEvent.event_id);
 assert.deepEqual(await inspect(load()),positive);
 // Removing a projected PG fence or restoring stale shadow state vetoes
 // fixture readiness even though witness and offline signature still match.
 const keptFence=(await fenceRows())[0];
 await admin.query(
  "DELETE FROM orbicore_ci_shadow.source_epoch_fences "+
  "WHERE organization_id=$1 AND user_id=$2",
  [keptFence.organization_id,keptFence.user_id],
 );
 await deny(load());
 await admin.query(
  "INSERT INTO orbicore_ci_shadow.source_epoch_fences("+
  "organization_id,user_id,confirmed_epoch,source_event_id,reason) "+
  "VALUES($1,$2,$3,$4,$5)",
  [subject.org,subject.id,3,disabled.eventId,"disabled"],
 );
 assert.deepEqual(await inspect(load()),positive);
 await admin.query(
  "UPDATE orbicore_ci_shadow.reauth_drafts "+
  "SET state='shadow_only' WHERE organization_id=$1 AND user_id=$2",
  [subject.org,subject.id],
 );
 await deny(load());
 await admin.query(
  "UPDATE orbicore_ci_shadow.reauth_drafts "+
  "SET state='invalidated' WHERE organization_id=$1 AND user_id=$2",
  [subject.org,subject.id],
 );
 assert.deepEqual(await inspect(load()),positive);
 app.db.prepare("UPDATE ci_source_credential_epoch SET epoch=1 WHERE user_id=?")
  .run(subject.id);
 await deny(load());
 app.db.prepare("UPDATE ci_source_credential_epoch SET epoch=3 WHERE user_id=?")
  .run(subject.id);
 assert.deepEqual(await inspect(load()),positive);
 // Sign a later version. Only externally pinned sequence+MAC authorizes
 // treating this as the live (still synthetic) evidence head.
 const rotated=createCiDetachedWitnessSigner({
  activeKey:secondKey,previousKeys:[firstKey],
 });
 const cp2=rotated.issue({witnessRows:await witnessRows(),sequence:2});
 pinnedMac=cp2.mac;minimumSequence=2;
 await deny(cp1,{signer:rotated}); // old signed head cannot roll back
 assert.equal((await inspect(cp2,{signer:rotated})).fixtureConsistent,true);
 // A signed-but-wrong snapshot is rejected, even when its MAC is otherwise
 // valid and the auditor key is known.
 const shortened=(await witnessRows()).slice(0,1);
 const bogus=rotated.issue({witnessRows:shortened,sequence:3});
 await deny(bogus,{signer:rotated,pinnedMac:bogus.mac,minimumSequence:3});
 // Source SQLite closed/reopened; detached pinned file and PG witness stay.
 writeFileSync(detachedFile,JSON.stringify(cp2));
 app.close();
 app=createApp({dbPath:sourcePath,startWorker:false,bootstrapToken:bootstrap});
 initializeCiSourceEpochJournal(app.db);
 const reopened=load();
 assert.equal((await inspect(reopened,{signer:rotated})).fixtureConsistent,true);
 assert.equal((await inspect(reopened,{signer:rotated})).productionLoginAuthorized,false);
 // No HTTP auth, SQL credential promotion, provider access or secret log.
 process.stdout.write(JSON.stringify({
  check:"orb-005-ci-detached-checkpoint-readiness",
  postgres16:true,fileBackedSqliteReopen:true,detachedFileCheckpoint:true,
  missingCorruptCheckpointDenied:true,
  signedManifestAndPinnedHead:true,oldSequenceReplayDenied:true,
  signerKeyRotation:true,missingPgWitnessDenied:true,
  deletedSourceEventDenied:true,pendingSourceOutboxDenied:true,
  missingPgEpochFenceDenied:true,staleShadowDenied:true,
  sourceEpochRegressionDenied:true,forgedSnapshotDenied:true,
  fixturePositiveConsistency:true,
  defaultHttpUnchanged:true,productionLoginAuthorized:false,
  independentlyAdministeredWorm:false,offHostRestoreProven:false,
 })+"\n");
}finally{
 if(shadowPool)await shadowPool.end();
 if(witnessPool)await witnessPool.end();
 if(reconcilePool)await reconcilePool.end();
 app.close();await admin.end();rmSync(root,{recursive:true,force:true});
}
