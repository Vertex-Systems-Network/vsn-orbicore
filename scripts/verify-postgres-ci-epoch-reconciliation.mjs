import assert from "node:assert/strict";
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { createApp } from "../apps/api/server.mjs";
import { createCiReauthenticationShadowPilot } from "../apps/api/postgres-ci-credential-shadow.mjs";
import {
  initializeCiSourceEpochJournal, changeCiSourceCredential,
  createCiSourceEpochReconciler,
} from "../apps/api/postgres-ci-credential-invalidation.mjs";

if (process.env.GITHUB_ACTIONS!=="true" ||
    process.env.ORBICORE_CI_SYNTHETIC_SHADOW_SCHEMA!=="1" ||
    process.env.ORBICORE_CI_SYNTHETIC_REAUTH!=="1" ||
    process.env.ORBICORE_CI_SYNTHETIC_RECONCILE!=="1") {
  throw new Error("ci_epoch_reconciliation_hosted_only");
}

const params={
  host:process.env.PGHOST??"127.0.0.1",
  port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??"orbicore",
  database:process.env.PGDATABASE??"orbicore",
  password:process.env.PGPASSWORD,
  max:4,connectionTimeoutMillis:5000,
};
const admin=new Pool(params);
const root=mkdtempSync(join(tmpdir(),"orbicore-ci-epoch-"));
const dbPath=join(root,"source.sqlite");
const fixtureToken=randomBytes(32).toString("hex");
let app=createApp({dbPath,startWorker:false,bootstrapToken:fixtureToken});
let restrictedWriter;
let restrictedReconciler;
const hash=(v)=>createHash("sha256").update(v).digest("hex");
const password=()=>randomBytes(24).toString("base64url");
const rows=[
 {org:"org-ci-epoch-a",id:"user-ci-epoch-a",email:"epoch-a@example.test",pass:password()},
 {org:"org-ci-epoch-b",id:"user-ci-epoch-b",email:"epoch-b@example.test",pass:password()},
 {org:"org-ci-epoch-c",id:"user-ci-epoch-c",email:"epoch-c@example.test",pass:password()},
 {org:"org-ci-epoch-d",id:"user-ci-epoch-d",email:"epoch-d@example.test",pass:password()},
];
const [a,b,c,d]=rows;
const adminCount=async(sql,values=[])=>Number(
  (await admin.query(sql,values)).rows[0].n,
);
const draft=async(row)=> (await admin.query(
  "SELECT state,source_epoch FROM orbicore_ci_shadow.reauth_drafts "+
  "WHERE organization_id=$1 AND user_id=$2 ORDER BY source_epoch DESC LIMIT 1",
  [row.org,row.id],
)).rows[0];
const fence=async(row)=> (await admin.query(
  "SELECT confirmed_epoch,source_event_id,reason "+
  "FROM orbicore_ci_shadow.source_epoch_fences "+
  "WHERE organization_id=$1 AND user_id=$2",
  [row.org,row.id],
)).rows[0];
const pending=(db)=>db.prepare(
  "SELECT COUNT(*) AS n FROM ci_source_credential_outbox WHERE status='pending'",
).get().n;
const byId=(db,row)=>db.prepare(
  "SELECT epoch FROM ci_source_credential_epoch WHERE user_id=?",
).get(row.id)?.epoch;
const staged=(row,sourceEpoch=1,pwd=row.pass)=>({
  userId:row.id,expectedSourceEpoch:sourceEpoch,password:pwd,
  idempotencyKey:hash(row.id+"@"+sourceEpoch),
});
const withRole=async(pool,role,sql,values=[])=>{
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE "+role);
    const result=await client.query(sql,values);
    await client.query("COMMIT");
    return result;
  }catch(e){
    await client.query("ROLLBACK");
    throw e;
  }finally{client.release();}
};

async function seed(row){
  const now=new Date().toISOString();
  app.db.prepare(
    "INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)",
  ).run(row.org,"Disposable CI tenant",now);
  const salt=randomBytes(16).toString("hex");
  const digest=scryptSync(row.pass,salt,64).toString("hex");
  app.db.prepare(
    "INSERT INTO users(id,organization_id,email,password_salt,password_hash,"+
    "role,disabled,mfa_enabled,created_at) "+
    "VALUES(?,?,?,?,?,'owner',0,0,?)",
  ).run(row.id,row.org,row.email,salt,digest,now);
  app.db.prepare(
    "INSERT INTO ci_source_credential_epoch(user_id,epoch) VALUES(?,1)",
  ).run(row.id);
  await admin.query(
    "INSERT INTO public.organizations(id,name) VALUES($1,$2)",
    [row.org,"Disposable CI tenant"],
  );
  await admin.query(
    "INSERT INTO public.users(id,organization_id,email,password_salt,"+
    "password_hash,role,disabled,mfa_enabled) "+
    "VALUES($1,$2,$3,'ci_reauth_fixture_no_pg_login',"+
    "'ci-no-pg-password-verifier','owner',false,false)",
    [row.id,row.org,row.email],
  );
}

async function makeLogin(name,role){
  const pwd=randomBytes(24).toString("hex");
  await admin.query(
    "CREATE ROLE "+name+" LOGIN NOINHERIT NOBYPASSRLS PASSWORD '"+pwd+"'",
  );
  await admin.query(
    "GRANT "+role+" TO "+name+" WITH SET TRUE, INHERIT FALSE",
  );
  return new Pool({...params,user:name,password:pwd});
}
try {
  initializeCiSourceEpochJournal(app.db);
  for(const row of rows)await seed(row);
  restrictedWriter=await makeLogin(
    "orbicore_ci_epoch_writer_login","orbicore_ci_shadow_writer",
  );
  restrictedReconciler=await makeLogin(
    "orbicore_ci_epoch_reconciler_login","orbicore_ci_shadow_reconciler",
  );
  const perms=(await admin.query(
    "SELECT has_table_privilege('orbicore_ci_shadow_reconciler',"+
    "'orbicore_ci_shadow.source_epoch_fences','SELECT') AS fence_read,"+
    "has_table_privilege('orbicore_ci_shadow_reconciler',"+
    "'orbicore_ci_shadow.reauth_drafts','UPDATE') AS draft_update,"+
    "has_function_privilege('orbicore_ci_shadow_reconciler',"+
    "'orbicore_ci_shadow.apply_source_epoch_invalidation(text,text,bigint,text,text)',"+
    "'EXECUTE') AS reconcile_execute,"+
    "has_function_privilege('orbicore_ci_shadow_writer',"+
    "'orbicore_ci_shadow.apply_source_epoch_invalidation(text,text,bigint,text,text)',"+
    "'EXECUTE') AS writer_reconcile",
  )).rows[0];
  assert.deepEqual(perms,{
    fence_read:false,draft_update:false,
    reconcile_execute:true,writer_reconcile:false,
  });

  await assert.rejects(restrictedReconciler.query(
    "SELECT source_event_id FROM orbicore_ci_shadow.source_epoch_fences",
  ),e=>e.code==="42501");
  await assert.rejects(restrictedReconciler.query(
    "SELECT verifier_digest FROM orbicore_ci_shadow.reauth_drafts",
  ),e=>e.code==="42501");
  assert.equal((await withRole(restrictedReconciler,
    "orbicore_ci_shadow_reconciler",
    "SELECT orbicore_ci_shadow.apply_source_epoch_invalidation("+
    "$1,$2,$3,$4,$5) AS applied",
    [a.org,b.id,2,hash("cross-tenant"),"disabled"],
  )).rows[0].applied,false);

  let pilot=createCiReauthenticationShadowPilot({
    sqlite:app.db,postgres:restrictedWriter,
  });
  for(const row of rows)assert.equal(await pilot.stage(staged(row)),true);
  assert.equal(await adminCount(
    "SELECT COUNT(*) AS n FROM orbicore_ci_shadow.reauth_drafts",
  ),4);

  // SQLite single-transaction rollback: mutation, epoch and journal all
  // remain untouched. The user is still legacy-authenticated.
  const original=app.db.prepare(
    "SELECT password_hash FROM users WHERE id=?",
  ).get(a.id).password_hash;
  a.reset=password();
  assert.throws(()=>changeCiSourceCredential({
    sqlite:app.db,userId:a.id,kind:"password_reset",newPassword:a.reset,
    injectBeforeCommit:true,
  }),/ci_source_injected_before_commit/);
  assert.equal(byId(app.db,a),1);
  assert.equal(pending(app.db),0);
  assert.equal(app.db.prepare(
    "SELECT password_hash FROM users WHERE id=?",
  ).get(a.id).password_hash,original);

  const eventA=changeCiSourceCredential({
    sqlite:app.db,userId:a.id,kind:"password_reset",newPassword:a.reset,
  });
  assert.equal(eventA.sourceEpoch,2);
  assert.equal(byId(app.db,a),2);
  assert.equal(pending(app.db),1);
  assert.notEqual(app.db.prepare(
    "SELECT password_hash FROM users WHERE id=?",
  ).get(a.id).password_hash,original);
  assert.equal(await pilot.stage(staged(a)),false);
  assert.equal((await draft(a)).state,"shadow_only");

  let reconciler=createCiSourceEpochReconciler({
    sqlite:app.db,postgres:restrictedReconciler,
  });
  // A real PostgreSQL CHECK failure atomically aborts fence + draft revoke.
  await admin.query(
    "ALTER TABLE orbicore_ci_shadow.source_epoch_fences "+
    "ADD CONSTRAINT ci_fail_epoch_two CHECK(confirmed_epoch<>2) NOT VALID",
  );
  await assert.rejects(reconciler.reconcilePending(),
    e=>e.message==="ci_shadow_reconciliation_unavailable");
  assert.equal(pending(app.db),1);
  assert.equal(await adminCount(
    "SELECT COUNT(*) AS n FROM orbicore_ci_shadow.source_epoch_fences",
  ),0);
  assert.equal((await draft(a)).state,"shadow_only");
  await admin.query(
    "ALTER TABLE orbicore_ci_shadow.source_epoch_fences "+
    "DROP CONSTRAINT ci_fail_epoch_two",
  );

  // A post-PG-commit crash leaves a *pending* source event, but the committed
  // fence already invalidated the old verifier. Reopen disk-backed SQLite.
  await assert.rejects(reconciler.reconcilePending({
    injectAfterPgCommit:true,
  }),/ci_reconciliation_interrupted_after_pg_commit/);
  assert.equal(pending(app.db),1);
  assert.equal((await draft(a)).state,"invalidated");
  assert.equal(Number((await fence(a)).confirmed_epoch),2);

  app.close();
  app=createApp({dbPath,startWorker:false,bootstrapToken:fixtureToken});
  initializeCiSourceEpochJournal(app.db);
  assert.equal(byId(app.db,a),2);
  assert.equal(pending(app.db),1);
  reconciler=createCiSourceEpochReconciler({
    sqlite:app.db,postgres:restrictedReconciler,
  });
  assert.deepEqual(await reconciler.reconcilePending(),{
    reconciled:1,pending:0,
  });
  assert.equal((await fence(a)).source_event_id,eventA.eventId);
  assert.equal((await draft(a)).state,"invalidated");

  pilot=createCiReauthenticationShadowPilot({
    sqlite:app.db,postgres:restrictedWriter,
  });
  // Old epoch is also explicitly fenced at PostgreSQL, even with an
  // otherwise matching PG fixture identity and a fresh idempotency key.
  await assert.rejects(withRole(
    restrictedWriter,"orbicore_ci_shadow_writer",
    "SELECT orbicore_ci_shadow.stage_reauth_draft("+
    "$1,$2,$3,$4,$5,$6,$7,$8) AS staged",
    [a.org,a.id,a.email,"owner",1,hash("stale-forged-stage"),
      "a".repeat(48),"b".repeat(128)],
  ),e=>e.code==="23514");
  assert.equal(await pilot.stage(staged(a,2,a.reset)),true);
  assert.equal((await draft(a)).state,"shadow_only");
  assert.equal(Number((await draft(a)).source_epoch),2);

  // Separate terminal state transitions are source+journal atomic and
  // invalidate without needing the corresponding source password.
  const eventB=changeCiSourceCredential({
    sqlite:app.db,userId:b.id,kind:"disabled",
  });
  const eventC=changeCiSourceCredential({
    sqlite:app.db,userId:c.id,kind:"mfa_enrolled",
  });
  const eventD2=changeCiSourceCredential({
    sqlite:app.db,userId:d.id,kind:"role_revoked",
  });
  const eventD3=changeCiSourceCredential({
    sqlite:app.db,userId:d.id,kind:"password_reset",
    newPassword:password(),
  });
  assert.equal(eventD3.sourceEpoch,3);
  assert.equal(await pilot.stage(staged(b)),false);
  assert.equal(await pilot.stage(staged(c)),false);

  // Roll back PG transaction BEFORE commit; pending source outbox persists.
  await assert.rejects(reconciler.reconcilePending({
    injectBeforePgCommit:true,
  }),e=>e.message==="ci_shadow_reconciliation_unavailable");
  assert.equal(pending(app.db),4);
  assert.equal(await adminCount(
    "SELECT COUNT(*) AS n FROM orbicore_ci_shadow.source_epoch_fences",
  ),1);
  assert.equal((await draft(b)).state,"shadow_only");

  // Out-of-order replay: D epoch3 is applied before D epoch2. A later
  // earlier event is acknowledged without regressing PG high-water mark.
  assert.deepEqual(await reconciler.reconcilePending({
    order:"desc",
  }),{reconciled:4,pending:0});
  assert.equal((await draft(b)).state,"invalidated");
  assert.equal((await draft(c)).state,"invalidated");
  assert.equal((await draft(d)).state,"invalidated");
  assert.equal(Number((await fence(d)).confirmed_epoch),3);
  assert.equal((await fence(d)).source_event_id,eventD3.eventId);
  assert.equal((await fence(b)).source_event_id,eventB.eventId);
  assert.equal((await fence(c)).source_event_id,eventC.eventId);
  assert.equal(eventD2.sourceEpoch,2);
  assert.equal((await reconciler.reconcilePending()).reconciled,0);

  // Source/tenant tampering never calls the privileged PG function. Source
  // outbox rows are not trusted without matching SQLite account provenance.
  const eventA3=changeCiSourceCredential({
    sqlite:app.db,userId:a.id,kind:"mfa_enrolled",
  });
  app.db.prepare(
    "UPDATE ci_source_credential_outbox "+
    "SET organization_id=? WHERE event_id=?",
  ).run(b.org,eventA3.eventId);
  await assert.rejects(reconciler.reconcilePending(),
    /ci_reconciliation_source_provenance_mismatch/);
  assert.equal(pending(app.db),1);
  assert.equal((await draft(a)).state,"shadow_only");
  app.db.prepare(
    "UPDATE ci_source_credential_outbox "+
    "SET organization_id=? WHERE event_id=?",
  ).run(a.org,eventA3.eventId);
  assert.deepEqual(await reconciler.reconcilePending(),
    {reconciled:1,pending:0});
  assert.equal((await draft(a)).state,"invalidated");
  assert.equal(Number((await fence(a)).confirmed_epoch),3);

  // Only own tenant-bound revoked metadata is present. No runtime route or
  // session acceptance path ever reads the CI-only derived verifier.
  assert.equal(await adminCount(
    "SELECT COUNT(*) AS n FROM orbicore_ci_shadow.reauth_drafts "+
    "WHERE state='shadow_only'",
  ),0);
  assert.equal(await adminCount(
    "SELECT COUNT(*) AS n FROM orbicore_ci_shadow.source_epoch_fences",
  ),4);
  process.stdout.write(JSON.stringify({
    check:"orb-005-ci-epoch-reconcile",postgres16NonOwner:true,
    fileBackedSqliteRestart:true,sourceMutationAtomic:true,
    wrongTenantDenied:true,sourceEpochMonotonic:true,
    staleStageRejected:true,roleSeparated:true,
    pgConstraintRollback:true,crashBeforePgCommit:true,
    crashAfterPgCommitBeforeSourceAck:true,
    replayAfterRestart:true,outOfOrderReplay:true,
    passwordResetDisableMfaRoleEvents:true,rawSecretOutput:false,
    noRuntimeAuthCutover:true,sourceOutboxPending:0,
  })+"\n");
}finally{
  if(restrictedWriter)await restrictedWriter.end();
  if(restrictedReconciler)await restrictedReconciler.end();
  app.close();
  await admin.end();
  rmSync(root,{recursive:true,force:true});
}
