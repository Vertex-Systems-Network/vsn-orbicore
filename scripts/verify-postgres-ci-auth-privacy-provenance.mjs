import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { createApp } from "../apps/api/server.mjs";
import { createCiSourceEventAttestor } from
  "../apps/api/ci-source-event-attestation.mjs";
import {
  initializeCiSourceEpochJournal, changeCiSourceCredential,
  createCiSourceEpochReconciler,
} from "../apps/api/postgres-ci-credential-invalidation.mjs";
import {
  initializeCiAuthFailureAudit,createCiKeyedAuthFailureAudit,
} from "../apps/api/ci-keyed-auth-failure-audit.mjs";
import { createCiReauthenticationShadowPilot } from
  "../apps/api/postgres-ci-credential-shadow.mjs";

for(const k of [
  "ORBICORE_CI_SYNTHETIC_SHADOW_SCHEMA",
  "ORBICORE_CI_SYNTHETIC_REAUTH",
  "ORBICORE_CI_SYNTHETIC_RECONCILE",
  "ORBICORE_CI_SYNTHETIC_EVENT_ATTESTATION",
  "ORBICORE_CI_SYNTHETIC_FAILURE_AUDIT",
]){
  if(process.env[k]!=="1" || process.env.GITHUB_ACTIONS!=="true")
    throw new Error("ci_auth_privacy_provenance_test_gate_required");
}
const conf={
  host:process.env.PGHOST??"127.0.0.1",
  port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??"orbicore",
  database:process.env.PGDATABASE??"orbicore",
  password:process.env.PGPASSWORD,max:4,
  connectionTimeoutMillis:5000,
};
const owner=new Pool(conf);
let restrictedWriter,restrictedReconciler;
const root=mkdtempSync(join(tmpdir(),"orbicore-ci-audit-mac-"));
const dbPath=join(root,"fixture.sqlite");
const fixtureBootstrap=randomBytes(32).toString("hex");
const a={
  org:"org-ci-mac-a",id:"user-ci-mac-a",
  email:"known@example.test",
  password:randomBytes(20).toString("base64url"),
};
const b={
  org:"org-ci-mac-b",id:"user-ci-mac-b",
  email:"known-b@example.test",
  password:randomBytes(20).toString("base64url"),
};
let app=createApp({dbPath,startWorker:false,bootstrapToken:fixtureBootstrap});
const keyOne={id:"source_k1",bytes:randomBytes(32)};
const keyTwo={id:"source_k2",bytes:randomBytes(32)};
const failOne={id:"failure_k1",bytes:randomBytes(32)};
const failTwo={id:"failure_k2",bytes:randomBytes(32)};
let time=1_800_000_000_000;
const events=(db)=>db.prepare(
  "SELECT event_id,organization_id,user_id,source_epoch,reason,"+
  "origin_key_id,origin_mac,status FROM ci_source_credential_outbox "+
  "ORDER BY sequence",
).all();
const pending=(db)=>db.prepare(
  "SELECT COUNT(*) AS n FROM ci_source_credential_outbox WHERE status='pending'",
).get().n;
const oldDraftState=async row=>(await owner.query(
  "SELECT state FROM orbicore_ci_shadow.reauth_drafts "+
  "WHERE user_id=$1 AND organization_id=$2 ORDER BY source_epoch LIMIT 1",
  [row.id,row.org],
)).rows[0].state;
const fence=async row=>(await owner.query(
  "SELECT confirmed_epoch FROM orbicore_ci_shadow.source_epoch_fences "+
  "WHERE user_id=$1 AND organization_id=$2",
  [row.id,row.org],
)).rows[0];
async function makeLogin(name,role){
  const pwd=randomBytes(20).toString("hex");
  await owner.query(
    "CREATE ROLE "+name+" LOGIN NOINHERIT NOBYPASSRLS PASSWORD '"+pwd+"'",
  );
  await owner.query(
    "GRANT "+role+" TO "+name+" WITH SET TRUE, INHERIT FALSE",
  );
  return new Pool({...conf,user:name,password:pwd});
}
async function seed(row){
  const now=new Date().toISOString();
  app.db.prepare("INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)")
    .run(row.org,"CI fixture",now);
  const salt=randomBytes(16).toString("hex");
  const legacy=scryptSync(row.password,salt,64).toString("hex");
  app.db.prepare(
    "INSERT INTO users(id,organization_id,email,password_salt,password_hash,"+
    "role,disabled,mfa_enabled,created_at) "+
    "VALUES(?,?,?,?,?,'owner',0,0,?)",
  ).run(row.id,row.org,row.email,salt,legacy,now);
  app.db.prepare(
    "INSERT INTO ci_source_credential_epoch(user_id,epoch) VALUES(?,1)",
  ).run(row.id);
  await owner.query("INSERT INTO public.organizations(id,name) VALUES($1,$2)",
    [row.org,"CI fixture"]);
  await owner.query(
    "INSERT INTO public.users(id,organization_id,email,password_salt,"+
    "password_hash,role,disabled,mfa_enabled) "+
    "VALUES($1,$2,$3,'ci_reauth_fixture_no_pg_login',"+
    "'ci-no-pg-password-verifier','owner',false,false)",
    [row.id,row.org,row.email],
  );
}

try{
  initializeCiSourceEpochJournal(app.db);
  initializeCiAuthFailureAudit(app.db);
  for(const row of [a,b])await seed(row);
  restrictedWriter=await makeLogin("orbicore_ci_mac_writer","orbicore_ci_shadow_writer");
  restrictedReconciler=await makeLogin(
    "orbicore_ci_mac_reconciler","orbicore_ci_shadow_reconciler",
  );

  const pilot=createCiReauthenticationShadowPilot({
    sqlite:app.db,postgres:restrictedWriter,
  });
  assert.equal(await pilot.stage({
    userId:a.id,password:a.password,expectedSourceEpoch:1,
    idempotencyKey:"a".repeat(64),
  }),true);
  assert.equal(await oldDraftState(a),"shadow_only");
  const attestorOld=createCiSourceEventAttestor({activeKey:keyOne});
  let reconciler=createCiSourceEpochReconciler({
    sqlite:app.db,postgres:restrictedReconciler,attestor:attestorOld,
  });

  // Reject an unsigned mutation atomically while attested mode is enabled.
  assert.throws(()=>changeCiSourceCredential({
    sqlite:app.db,userId:a.id,kind:"disabled",
  }),/ci_source_mutation_unavailable/);
  assert.equal(pending(app.db),0);
  assert.equal(app.db.prepare(
    "SELECT disabled FROM users WHERE id=?",
  ).get(a.id).disabled,0);

  const e1=changeCiSourceCredential({
    sqlite:app.db,userId:a.id,kind:"disabled",attestor:attestorOld,
  });
  assert.equal(e1.sourceEpoch,2);
  assert.equal(pending(app.db),1);
  assert.equal(events(app.db)[0].origin_key_id,"source_k1");
  assert.equal(events(app.db)[0].origin_mac.length,64);
  assert.equal(attestorOld.verify(events(app.db)[0]),true);

  // Alter an event *after* the source transaction: MAC validation fails
  // before the PostgreSQL reconciler can be called.
  app.db.prepare(
    "UPDATE ci_source_credential_outbox SET reason=? WHERE event_id=?",
  ).run("role_revoked",e1.eventId);
  await assert.rejects(reconciler.reconcilePending(),
    /ci_reconciliation_source_event_mac_invalid/);
  assert.equal((await fence(a)),undefined);
  assert.equal(await oldDraftState(a),"shadow_only");
  app.db.prepare(
    "UPDATE ci_source_credential_outbox SET reason=? WHERE event_id=?",
  ).run("disabled",e1.eventId);

  // A replacement key with the same ID cannot forge the event MAC.
  const wrongAttestor=createCiSourceEventAttestor({
    activeKey:{id:"source_k1",bytes:randomBytes(32)},
  });
  const wrongReconciler=createCiSourceEpochReconciler({
    sqlite:app.db,postgres:restrictedReconciler,attestor:wrongAttestor,
  });
  await assert.rejects(wrongReconciler.reconcilePending(),
    /ci_reconciliation_source_event_mac_invalid/);
  assert.equal(pending(app.db),1);

  // PostgreSQL commits revoke, but SQLite ack is interrupted. A disk reopen
  // and original external key permit exactly-once acknowledgement semantics.
  await assert.rejects(reconciler.reconcilePending({
    injectAfterPgCommit:true,
  }),/ci_reconciliation_interrupted_after_pg_commit/);
  assert.equal((await fence(a)).confirmed_epoch,"2");
  assert.equal(await oldDraftState(a),"invalidated");
  assert.equal(pending(app.db),1);
  app.close();
  app=createApp({dbPath,startWorker:false,bootstrapToken:fixtureBootstrap});
  initializeCiSourceEpochJournal(app.db);
  initializeCiAuthFailureAudit(app.db);
  reconciler=createCiSourceEpochReconciler({
    sqlite:app.db,postgres:restrictedReconciler,attestor:attestorOld,
  });
  assert.deepEqual(await reconciler.reconcilePending(),
    {reconciled:1,pending:0});
  assert.deepEqual(await reconciler.reconcilePending(),
    {reconciled:0,pending:0});

  // Signing-key rotation keeps prior keys for pending-event replay.
  const e2=changeCiSourceCredential({
    sqlite:app.db,userId:b.id,kind:"mfa_enrolled",
    attestor:attestorOld,
  });
  const attestorNew=createCiSourceEventAttestor({
    activeKey:keyTwo,previousKeys:[keyOne],
  });
  assert.equal(attestorNew.verify(
    events(app.db).find(x=>x.event_id===e2.eventId)),true);
  const rotated=createCiSourceEpochReconciler({
    sqlite:app.db,postgres:restrictedReconciler,attestor:attestorNew,
  });
  assert.deepEqual(await rotated.reconcilePending(),
    {reconciled:1,pending:0});
  const e3=changeCiSourceCredential({
    sqlite:app.db,userId:b.id,kind:"role_revoked",attestor:attestorNew,
  });
  assert.equal(events(app.db).find(x=>x.event_id===e3.eventId).origin_key_id,
    "source_k2");
  const noOld=createCiSourceEventAttestor({activeKey:keyTwo});
  assert.equal(noOld.verify(events(app.db).find(
    x=>x.event_id===e2.eventId)),false);
  assert.deepEqual(await rotated.reconcilePending(),
    {reconciled:1,pending:0});

  // Unknown user and known user with bad password have the SAME rejection
  // contract. No source identity, tenant, submitted email or password is
  // stored in the CI audit rows.
  let failureAudit=createCiKeyedAuthFailureAudit({
    sqlite:app.db,activeKey:failOne,now:()=>time,maxFailures:3,
    windowMs:60000,
  });
  const sameKnown=failureAudit.recordRejected({
    identifier:"  KNOWN@EXAMPLE.TEST ",
  });
  const sameUnknown=failureAudit.recordRejected({
    identifier:"unknown@example.test",
  });
  assert.deepEqual(sameKnown,{status:401,error:"invalid_credentials"});
  assert.deepEqual(sameUnknown,sameKnown);
  assert.deepEqual(failureAudit.recordRejected({
    identifier:"known@example.test",
  }),sameKnown);
  const privacyRows=app.db.prepare(
    "SELECT * FROM ci_auth_failure_events ORDER BY rowid",
  ).all();
  assert.equal(privacyRows.length,3);
  const privacyText=JSON.stringify(privacyRows);
  for(const forbidden of [
    "known@example.test","unknown@example.test",a.password,
    a.org,a.id,"source_k1",
  ])assert.equal(privacyText.includes(forbidden),false);
  assert.equal(privacyRows[0].identity_digest.length,64);
  assert.equal(privacyRows[0].identity_key_id,"failure_k1");
  assert.equal(privacyRows[0].identity_digest,
    privacyRows[2].identity_digest);
  assert.notEqual(privacyRows[0].identity_digest,
    privacyRows[1].identity_digest);

  // Rotate the HMAC key: retain old key for window counts, or fail closed.
  failureAudit=createCiKeyedAuthFailureAudit({
    sqlite:app.db,activeKey:failTwo,previousKeys:[failOne],
    now:()=>time,maxFailures:3,windowMs:60000,
  });
  assert.deepEqual(failureAudit.recordRejected({
    identifier:"known@example.test",
  }),sameKnown); // prior key had 2 attempts
  assert.deepEqual(failureAudit.recordRejected({
    identifier:"known@example.test",
  }),{status:429,error:"auth_rate_limited"});
  assert.deepEqual(failureAudit.recordRejected({
    identifier:"unknown@example.test",
  }),sameUnknown);
  const missingOld=createCiKeyedAuthFailureAudit({
    sqlite:app.db,activeKey:failTwo,
    now:()=>time,maxFailures:3,windowMs:60000,
  });
  assert.throws(()=>missingOld.recordRejected({
    identifier:"known@example.test",
  }),/ci_auth_failure_audit_unavailable/);
  assert.throws(()=>missingOld.recordRejected({
    identifier:"nonexistent@example.test",
  }),/ci_auth_failure_audit_unavailable/);

  // A forced DB write error rolls back and denies all attempts; no email or
  // keys are returned in the generic public error.
  const auditBefore=app.db.prepare(
    "SELECT COUNT(*) AS n FROM ci_auth_failure_events",
  ).get().n;
  app.db.exec(
    "CREATE TRIGGER ci_fail_failure_audit "+
    "BEFORE INSERT ON ci_auth_failure_events "+
    "BEGIN SELECT RAISE(ABORT,'ci_injected_write_denied'); END",
  );
  assert.throws(()=>failureAudit.recordRejected({
    identifier:"never-log-this@example.test",
  }),e=>e.message==="ci_auth_failure_audit_unavailable");
  assert.equal(app.db.prepare(
    "SELECT COUNT(*) AS n FROM ci_auth_failure_events",
  ).get().n,auditBefore);
  app.db.exec("DROP TRIGGER ci_fail_failure_audit");

  // File-backed restart: durable window counter and external key selection.
  app.close();
  app=createApp({dbPath,startWorker:false,bootstrapToken:fixtureBootstrap});
  initializeCiAuthFailureAudit(app.db);
  const afterRestart=createCiKeyedAuthFailureAudit({
    sqlite:app.db,activeKey:failTwo,previousKeys:[failOne],
    now:()=>time,maxFailures:3,windowMs:60000,
  });
  assert.deepEqual(afterRestart.recordRejected({
    identifier:"known@example.test",
  }),{status:429,error:"auth_rate_limited"});
  // Window expires; older keys may then be dropped without silently
  // resetting a live attempt quota.
  time+=60001;
  const afterExpiry=createCiKeyedAuthFailureAudit({
    sqlite:app.db,activeKey:failTwo,now:()=>time,
    maxFailures:3,windowMs:60000,
  });
  assert.deepEqual(afterExpiry.recordRejected({
    identifier:"known@example.test",
  }),sameKnown);
  assert.deepEqual(afterExpiry.recordRejected({
    identifier:"unknown@example.test",
  }),sameUnknown);

  // A malformed submitted identifier is represented only by a shared keyed
  // bucket, never a literal copy of attacker-controlled text.
  assert.deepEqual(afterExpiry.recordRejected({
    identifier:"malformed\nemail",
  }),sameKnown);

  process.stdout.write(JSON.stringify({
    check:"orb-005-ci-event-attestation-and-keyed-failure",
    sourceEventMacTamperDenied:true,unknownSourceMacDenied:true,
    sourceKeyRotationReplay:true,pgCommitSourceAckCrashReplay:true,
    defaultHttpUnchanged:true,postgresLoginAuthority:false,
    auditKeyNotPersisted:true,noPlaintextEmailLogged:true,
    knownUnknownResponseParity:true,rateLimitKeyRotation:true,
    missingKeyFailsClosed:true,forcedAuditWriteFailureDenied:true,
    fileBackedCounterRestart:true,
    syntheticOnly:true,
  })+"\n");
}finally{
  if(restrictedWriter)await restrictedWriter.end();
  if(restrictedReconciler)await restrictedReconciler.end();
  app.close();
  await owner.end();
  rmSync(root,{recursive:true,force:true});
}
