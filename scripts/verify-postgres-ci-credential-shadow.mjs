import assert from "node:assert/strict";
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { Pool } from "pg";
import { createApp } from "../apps/api/server.mjs";
import {
  CI_SHADOW_KDF, createCiReauthenticationShadowPilot,
} from "../apps/api/postgres-ci-credential-shadow.mjs";

if (process.env.GITHUB_ACTIONS !== "true" ||
    process.env.ORBICORE_CI_SYNTHETIC_REAUTH !== "1" ||
    process.env.ORBICORE_CI_SYNTHETIC_SHADOW_SCHEMA !== "1") {
  throw new Error("ci_only_reauth_integration_guard");
}
const params = {
  host:process.env.PGHOST ?? "127.0.0.1",
  port:Number(process.env.PGPORT ?? 5432),
  user:process.env.PGUSER ?? "orbicore",
  database:process.env.PGDATABASE ?? "orbicore",
  password:process.env.PGPASSWORD,
  max:4,connectionTimeoutMillis:5000,
};
const admin = new Pool(params);
let restricted;
const app=createApp({
  dbPath:":memory:",startWorker:false,
  bootstrapToken:randomBytes(32).toString("hex"),
});
const db=app.db;
const authPassword = () => randomBytes(24).toString("base64url");
const sha = value => createHash("sha256").update(value).digest("hex");
const specs=[
  {org:"org-ci-reauth-a",id:"user-ci-reauth-a",email:"reauth-a@example.test",pass:authPassword()},
  {org:"org-ci-reauth-b",id:"user-ci-reauth-b",email:"reauth-b@example.test",pass:authPassword()},
  {org:"org-ci-reauth-c",id:"user-ci-reauth-c",email:"reauth-c@example.test",pass:authPassword()},
];
const a=specs[0],b=specs[1],c=specs[2];
const staging=(row,extra={})=>({
  userId:row.id,
  password:row.pass,
  expectedSourceEpoch:1,
  idempotencyKey:sha("fixture-only:"+row.id+":1"),
  ...extra,
});
const count=async()=>Number((await admin.query(
  "SELECT COUNT(*) AS count FROM orbicore_ci_shadow.reauth_drafts",
)).rows[0].count);
async function seed(row){
  const now=new Date().toISOString();
  db.prepare("INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)")
    .run(row.org,"Disposable CI tenant",now);
  const salt=randomBytes(16).toString("hex");
  const hash=scryptSync(row.pass,salt,64).toString("hex");
  db.prepare(
    "INSERT INTO users(id,organization_id,email,password_salt,password_hash,"+
    "role,disabled,mfa_enabled,created_at) "+
    "VALUES(?,?,?,?,?,'owner',0,0,?)",
  ).run(row.id,row.org,row.email,salt,hash,now);
  db.prepare(
    "INSERT INTO ci_source_credential_epoch(user_id,epoch) VALUES(?,1)",
  ).run(row.id);
  await admin.query("INSERT INTO public.organizations(id,name) VALUES($1,$2)",
    [row.org,"Disposable CI tenant"]);
  await admin.query(
    "INSERT INTO public.users(id,organization_id,email,password_salt,"+
    "password_hash,role,disabled,mfa_enabled) "+
    "VALUES($1,$2,$3,'ci_reauth_fixture_no_pg_login',"+
    "'ci-no-pg-password-verifier','owner',false,false)",
    [row.id,row.org,row.email],
  );
}
try {
  db.exec("CREATE TABLE ci_source_credential_epoch("+
    "user_id TEXT PRIMARY KEY REFERENCES users(id),"+
    "epoch INTEGER NOT NULL CHECK(epoch>=1))");
  for(const item of specs)await seed(item);
  const login="orbicore_ci_reauth_writer_login";
  const secret=randomBytes(24).toString("hex");
  await admin.query(
    "CREATE ROLE "+login+" LOGIN NOINHERIT NOBYPASSRLS PASSWORD '"+secret+"'",
  );
  await admin.query(
    "GRANT orbicore_ci_shadow_writer TO "+login+
    " WITH SET TRUE, INHERIT FALSE",
  );
  restricted=new Pool({...params,user:login,password:secret});
  assert.deepEqual((await restricted.query(
    "SELECT rolcanlogin,rolsuper,rolbypassrls FROM pg_roles "+
    "WHERE rolname=current_user",
  )).rows[0],{rolcanlogin:true,rolsuper:false,rolbypassrls:false});

  const rights=(await admin.query(
    "SELECT has_schema_privilege('orbicore_ci_shadow_writer',"+
    "'orbicore_ci_shadow','USAGE') AS schema_usage,"+
    "has_table_privilege('orbicore_ci_shadow_writer',"+
    "'orbicore_ci_shadow.reauth_drafts','SELECT') AS select_privilege,"+
    "has_table_privilege('orbicore_ci_shadow_writer',"+
    "'orbicore_ci_shadow.reauth_drafts','INSERT') AS insert_privilege,"+
    "has_function_privilege('orbicore_ci_shadow_writer',"+
    "'orbicore_ci_shadow.stage_reauth_draft(text,text,text,text,bigint,text,text,text)',"+
    "'EXECUTE') AS function_execute",
  )).rows[0];
  assert.deepEqual(rights,{
    schema_usage:true,select_privilege:false,
    insert_privilege:false,function_execute:true,
  });
  await assert.rejects(restricted.query(
    "SELECT verifier_digest FROM orbicore_ci_shadow.reauth_drafts",
  ),error=>error.code==="42501");
  await assert.rejects(restricted.query(
    "SELECT orbicore_ci_shadow.stage_reauth_draft("+
    "$1,$2,$3,$4,$5,$6,$7,$8)",
    [a.org,a.id,a.email,"owner",1,sha("forged"),"a".repeat(48),"b".repeat(128)],
  ),error=>error.code==="42501");
  const pilot=createCiReauthenticationShadowPilot({sqlite:db,postgres:restricted});

  assert.equal(await pilot.stage(staging(a,{password:"not-valid-password"})),false);
  assert.equal(await pilot.stage(staging(a,{expectedSourceEpoch:2})),false);
  assert.equal(await pilot.stage(staging(a,{userId:"missing-ci-user"})),false);
  assert.equal(await count(),0);

  // Source-verified fresh password derives a different, privately stored
  // stronger-profile verifier; the original salted SQLite hash is untouched.
  assert.equal(await pilot.stage(staging(a)),true);
  assert.equal(await count(),1);
  const draft=(await admin.query(
    "SELECT source_epoch,kdf_profile,verifier_salt,verifier_digest,state "+
    "FROM orbicore_ci_shadow.reauth_drafts "+
    "WHERE organization_id=$1 AND user_id=$2",
    [a.org,a.id],
  )).rows[0];
  assert.equal(Number(draft.source_epoch),1);
  assert.equal(draft.kdf_profile,CI_SHADOW_KDF.version);
  assert.equal(draft.state,"shadow_only");
  assert.equal(draft.verifier_salt.length,48);
  assert.equal(draft.verifier_digest.length,128);
  assert.equal(
    scryptSync(a.pass,Buffer.from(draft.verifier_salt,"hex"),
      CI_SHADOW_KDF.keyLength,{
        N:CI_SHADOW_KDF.N,r:CI_SHADOW_KDF.r,p:CI_SHADOW_KDF.p,
        maxmem:CI_SHADOW_KDF.maxmem,
      }).toString("hex"),
    draft.verifier_digest,
  );
  assert.notEqual(draft.verifier_digest,db.prepare(
    "SELECT password_hash FROM users WHERE id=?",
  ).get(a.id).password_hash);
  assert.equal(await pilot.stage(staging(a)),false);
  assert.equal(await pilot.stage(staging(a,{
    idempotencyKey:sha("new-duplicate-key"),
  })),false);
  assert.equal(await count(),1);

  // Source-to-target user mapping MUST match email, tenant and role.
  await admin.query(
    "UPDATE public.users SET email=$1 WHERE id=$2",
    ["mismatched@example.test",b.id],
  );
  assert.equal(await pilot.stage(staging(b)),false);
  await admin.query(
    "UPDATE public.users SET email=$1 WHERE id=$2",
    [b.email,b.id],
  );
  assert.equal(await pilot.stage(staging(b)),true);
  assert.equal(await count(),2);

  // Source epoch and revocation changes deny any future attempts; existing
  // shadow draft is INERT (never used to authenticate).
  db.prepare(
    "UPDATE ci_source_credential_epoch SET epoch=2 WHERE user_id=?",
  ).run(a.id);
  assert.equal(await pilot.stage(staging(a)),false);
  db.prepare("UPDATE users SET disabled=1 WHERE id=?").run(b.id);
  assert.equal(await pilot.stage(staging(b,{
    expectedSourceEpoch:1,idempotencyKey:sha("disabled-user"),
  })),false);
  db.prepare("UPDATE users SET mfa_enabled=1 WHERE id=?").run(c.id);
  assert.equal(await pilot.stage(staging(c)),false);
  db.prepare("UPDATE users SET mfa_enabled=0 WHERE id=?").run(c.id);

  // Transaction failure: no shadow row is present for C; SQLite authority,
  // source epoch and original verifier are unchanged.
  const original=db.prepare(
    "SELECT password_hash FROM users WHERE id=?",
  ).get(c.id).password_hash;
  await admin.query(
    "ALTER TABLE orbicore_ci_shadow.reauth_drafts "+
    "ADD CONSTRAINT ci_force_rollback_c "+
    "CHECK(organization_id <> 'org-ci-reauth-c') NOT VALID",
  );
  await assert.rejects(pilot.stage(staging(c)),
    error=>error.message==="ci_shadow_stage_unavailable");
  assert.equal(await count(),2);
  assert.equal(db.prepare(
    "SELECT epoch FROM ci_source_credential_epoch WHERE user_id=?",
  ).get(c.id).epoch,1);
  assert.equal(db.prepare(
    "SELECT password_hash FROM users WHERE id=?",
  ).get(c.id).password_hash,original);
  await admin.query(
    "ALTER TABLE orbicore_ci_shadow.reauth_drafts "+
    "DROP CONSTRAINT ci_force_rollback_c",
  );
  assert.equal(await pilot.stage(staging(c)),true);
  assert.equal(await count(),3);

  process.stdout.write(JSON.stringify({
    check:"orb-005-ci-reauth-shadow",
    syntheticSource:true,explicitPasswordReauthentication:true,
    twoTenantIsolation:true,restrictedNonOwnerWriter:true,
    noDirectVerifierRead:true,epochDenial:true,
    disabledAndMfaDenial:true,faultRollback:true,
    shadowDraftCount:3,rawSecretOutput:false,
    runtimeLoginModified:false,postgresAuthAuthority:false,
  })+"\n");
} finally {
  if(restricted)await restricted.end();
  app.close();
  await admin.end();
}
