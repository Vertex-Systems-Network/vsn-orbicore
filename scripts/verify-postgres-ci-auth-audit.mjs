import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { computeAuditEntryHash } from "../apps/api/audit.mjs";
import { newRecoveryCodes, recoveryCodeHash } from "../apps/api/mfa.mjs";
import { createPostgresCiLoginAdapter } from "../apps/api/postgres-ci-login.mjs";
import { createPostgresSyntheticSubmissionGateway } from "../apps/api/postgres-synthetic-gateway.mjs";
import { createPostgresSyntheticHttpHarness } from "../apps/api/postgres-synthetic-http-harness.mjs";

if(process.env.GITHUB_ACTIONS !== "true" ||
   process.env.ORBICORE_CI_SYNTHETIC_PG_HTTP !== "1" ||
   process.env.ORBICORE_CI_SYNTHETIC_PG_LOGIN !== "1" ||
   process.env.ORBICORE_CI_SYNTHETIC_PG_AUTH_AUDIT !== "1"){
  throw new Error("ci_pg_auth_audit_explicit_gates_required");
}
const pool=new Pool({
  host:process.env.PGHOST ?? "127.0.0.1",
  port:Number(process.env.PGPORT ?? 5432),
  user:process.env.PGUSER ?? "orbicore",
  database:process.env.PGDATABASE ?? "orbicore",
  password:process.env.PGPASSWORD,max:4,connectionTimeoutMillis:5000,
});
const hash=v=>createHash("sha256").update(v).digest("hex");
const tenant="org-ci-audited-a",tenantB="org-ci-audited-b";
const user="ci-audited-owner",otherUser="ci-audited-other";
const mfaUser="ci-audited-mfa",viewerUser="ci-audited-viewer";
const account="account-ci-audited",otherAccount="account-ci-audited-other";
const email={
  owner:"owner-audit@example.test",mfa:"mfa-audit@example.test",
  viewer:"viewer-audit@example.test",other:"other-audit@example.test",
};
const passwords=Object.fromEntries(Object.keys(email).map(id=>[
  id,randomBytes(24).toString("base64url"),
]));
const recoveryCodes=newRecoveryCodes(3);
let restrictedPool,harness;
const count=async(table,where="",values=[])=>Number((await pool.query(
  "SELECT COUNT(*)::integer AS n FROM public."+table+" "+where,values,
)).rows[0].n);
try{
  const login="orbicore_ci_auth_audit_login";
  const secret=randomBytes(32).toString("hex");
  await pool.query(
    "CREATE ROLE orbicore_ci_auth_audit_login LOGIN NOINHERIT NOBYPASSRLS PASSWORD '"+secret+"'",
  );
  await pool.query(
    "GRANT orbicore_synthetic_submitter TO orbicore_ci_auth_audit_login WITH SET TRUE, INHERIT FALSE",
  );
  restrictedPool=new Pool({
    host:process.env.PGHOST ?? "127.0.0.1",
    port:Number(process.env.PGPORT ?? 5432),
    user:login,database:process.env.PGDATABASE ?? "orbicore",
    password:secret,max:8,connectionTimeoutMillis:5000,
  });
  assert.deepEqual((await restrictedPool.query(
    "SELECT current_user AS name,rolsuper,rolbypassrls " +
    "FROM pg_roles WHERE rolname=current_user",
  )).rows[0],{name:login,rolsuper:false,rolbypassrls:false});
  for(const sql of [
    "SELECT password_hash FROM public.users",
    "SELECT token_hash FROM public.sessions",
    "SELECT code_hash FROM public.recovery_codes",
    "SELECT details_raw_json FROM public.audit_events",
    "DELETE FROM public.audit_events",
  ])await assert.rejects(restrictedPool.query(sql),e=>e.code==="42501");

  for(const [id,name] of [[tenant,"CI audit tenant"],[tenantB,"Second CI audit tenant"]]){
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,$2)",[id,name]);
  }
  for(const [id,org,mail,pass,role,mfa] of [
    [user,tenant,email.owner,passwords.owner,"owner",false],
    [mfaUser,tenant,email.mfa,passwords.mfa,"operator",true],
    [viewerUser,tenant,email.viewer,passwords.viewer,"viewer",false],
    [otherUser,tenantB,email.other,passwords.other,"owner",false],
  ])await pool.query(
    "INSERT INTO users(id,organization_id,email,password_salt,password_hash,role,mfa_enabled) " +
    "VALUES($1,$2,$3,'ci_pg_bcrypt_only',public.crypt($4,public.gen_salt('bf',10)),$5,$6)",
    [id,org,mail,pass,role,mfa],
  );
  for(const [id,org] of [[account,tenant],[otherAccount,tenantB]]){
    await pool.query(
      "INSERT INTO accounts(id,organization_id,label,provider,host,username,health,"+
      "used_bytes,quota_bytes,source) VALUES($1,$2,'CI fake','mock','fixture.invalid'," +
      "'fixture','healthy',0,1,'mock_fixture')",[id,org],
    );
  }
  for(const code of recoveryCodes)await pool.query(
    "INSERT INTO recovery_codes(user_id,organization_id,code_hash) VALUES($1,$2,$3)",
    [mfaUser,tenant,recoveryCodeHash(code)],
  );

  // Link the first new audited login to a previously imported, verifiable
  // Node-compatible tenant audit row, not blindly to timestamp ordering.
  const seedTime="2026-11-22T00:00:00.000Z";
  const seedDetails='{"source":"ci_fixture","event":"seed"}';
  const seedHash=computeAuditEntryHash({
    prevHash:"GENESIS",organizationId:tenant,actor:user,
    action:"fixture.seed",targetId:user,outcome:"completed",
    detailsJson:seedDetails,createdAt:seedTime,
  });
  await pool.query(
    "INSERT INTO audit_events(id,organization_id,actor,action,target_id,outcome," +
    "created_at,details_json,details_raw_json,prev_hash,entry_hash) " +
    // The raw JSON input must have a distinct bind parameter from JSONB:
    // sharing a parameter coerces it to JSONB and reorders the hash input.
    "VALUES($1,$2,$3,'fixture.seed',$3,'completed',$4,$5::jsonb,$6::text,'GENESIS',$7)",
    [randomUUID(),tenant,user,seedTime,seedDetails,seedDetails,seedHash],
  );

  // The untrusted limited login cannot call original 008 functions, the
  // helper, or audited functions without an explicit SET LOCAL ROLE.
  const deny=async(sql,args=[])=>{
    const c=await restrictedPool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE orbicore_synthetic_submitter");
      await assert.rejects(c.query(sql,args),e=>e.code==="42501");
    } finally{
      await c.query("ROLLBACK");
      c.release();
    }
  };
  for(const sql of [
    "SELECT * FROM public.orbicore_ci_password_login($1,$2,$3)",
    "SELECT public.orbicore_ci_finish_recovery_mfa($1,$2,$3)",
    "SELECT public.orbicore_ci_revoke_session($1)",
    "SELECT public.orbicore_ci_append_auth_audit($1,$2)",
  ])await deny(sql,sql.includes("password_login")?
    [email.owner,passwords.owner,hash("reject")]:
    sql.includes("finish_recovery")?
      [hash("old"),hash("new"),hash("code")]:
      sql.includes("append_auth")?[hash("bad"),"auth.logout"]:[hash("bad")]);

  const unAudited=createPostgresCiLoginAdapter(restrictedPool);
  await assert.rejects(unAudited.login({
    email:email.owner,password:passwords.owner,
  }),e=>e.code==="42501");
  assert.equal(await count("sessions"),0);

  const auth=createPostgresCiLoginAdapter(restrictedPool,{audited:true});
  const gateway=createPostgresSyntheticSubmissionGateway(restrictedPool);
  harness=createPostgresSyntheticHttpHarness({gateway,loginAdapter:auth});
  const base=await harness.start();
  const p={
    login:"/__ci/pg/auth/login",
    csrf:"/__ci/pg/session/csrf",
    mfa:"/__ci/pg/auth/mfa/recovery",
    logout:"/__ci/pg/auth/logout",
    job:"/__ci/pg/jobs/refresh",
  };
  async function call(path,{method="GET",cookie,csrf,body,key,origin=base}={}){
    return fetch(base+path,{
      method,
      headers:{
        ...(cookie?{cookie}:{}),
        ...(csrf?{"x-orbicore-csrf":csrf}:{}),
        ...(key?{"idempotency-key":key}:{}),
        ...(body!==undefined?{"content-type":"application/json"}:{}),
        ...(method!=="GET"?{origin}:{}),
      },
      ...(body!==undefined?{body:JSON.stringify(body)}:{}),
    });
  }
  const getCookie=r=>r.headers.get("set-cookie")?.split(";")[0];
  const loginHttp=(id,override=passwords[id])=>call(p.login,{
    method:"POST",body:{email:email[id],password:override},
  });
  const token=async cookie=>{
    const r=await call(p.csrf,{cookie});
    return r.status===200?(await r.json()).csrfToken:null;
  };
  const job=(cookie,csrf,acc,key)=>call(p.job,{
    method:"POST",cookie,csrf,body:{accountId:acc},key,
  });
  const audited=async()=>{
    const rows=(await pool.query(
      "SELECT organization_id,actor,action,target_id,outcome,created_at,"+
      "details_raw_json,prev_hash,entry_hash,audit_sequence " +
      "FROM public.audit_events ORDER BY audit_sequence",
    )).rows;
    const head=new Map();
    for(const row of rows){
      const expectedPrev=head.get(row.organization_id) ?? "GENESIS";
      assert.equal(row.prev_hash,expectedPrev,"invalid predecessor");
      assert.equal(row.entry_hash,computeAuditEntryHash({
        prevHash:expectedPrev,organizationId:row.organization_id,
        actor:row.actor,action:row.action,targetId:row.target_id,
        outcome:row.outcome,detailsJson:row.details_raw_json,
        createdAt:row.created_at.toISOString(),
      }),"Node and PostgreSQL audit SHA disagree for "+row.action+
        " tenant="+row.organization_id+" timestamp="+row.created_at.toISOString());
      for(const secret of [
        ...Object.values(passwords),...recoveryCodes,
      ]) assert.equal(row.details_raw_json.includes(secret),false,
        "audit details must not contain credentials or recovery codes");
      assert.equal(Object.hasOwn(JSON.parse(row.details_raw_json),"password"),false,
        "audit details must not contain a password property");
      head.set(row.organization_id,row.entry_hash);
    }
    return rows;
  };

  // Failures (including missing usernames) stay in the pseudonymous
  // throttle store: no tenant can be inferred for an unrecognized email.
  assert.equal((await loginHttp("owner","incorrect-password")).status,401);
  assert.equal((await call(p.login,{method:"POST",body:{
    email:"no-such-user@example.test",password:passwords.owner,
  }})).status,401);
  assert.equal(await count("audit_events"),1);
  assert.equal(await count("sessions"),0);

  const success=await loginHttp("owner");
  assert.equal(success.status,200);
  const ownerCookie=getCookie(success);
  assert.match(ownerCookie,/^orbicore_session=[A-Za-z0-9_-]{32,}$/);
  assert.equal(await count("sessions"),1);
  let rows=await audited();
  assert.deepEqual(rows.map(r=>r.action),["fixture.seed","auth.login.success"]);
  assert.equal(rows[1].prev_hash,seedHash);
  assert.equal(rows[1].target_id,user);
  assert.equal(rows[1].details_raw_json,
    '{"source":"ci_fixture","method":"password"}');
  const ownerCsrf=await token(ownerCookie);
  assert.ok(ownerCsrf);
  assert.equal((await job(ownerCookie,ownerCsrf,account,"audit-job")).status,202);
  rows=await audited();
  assert.equal(rows.at(-1).action,"job.enqueue");
  assert.equal(await count("job_outbox"),1);

  const viewer=await loginHttp("viewer");
  assert.equal(viewer.status,200);
  const viewerCookie=getCookie(viewer);
  assert.equal((await call(p.csrf,{cookie:viewerCookie})).status,401);
  assert.equal((await job(viewerCookie,ownerCsrf,account,"viewer-rejected")).status,401);
  assert.equal((await audited()).at(-1).action,"auth.login.success");
  assert.equal((await audited()).at(-1).actor,viewerUser);

  const other=await loginHttp("other");
  assert.equal(other.status,200);
  const otherCookie=getCookie(other);
  const otherCsrf=await token(otherCookie);
  assert.ok(otherCsrf);
  assert.equal((await job(otherCookie,otherCsrf,account,"cross-tenant")).status,403);
  assert.equal((await job(otherCookie,otherCsrf,otherAccount,"other-job")).status,202);
  assert.equal(await count("jobs"),2);

  const pending=await loginHttp("mfa");
  assert.equal(pending.status,202);
  const pendingCookie=getCookie(pending);
  const pendingBody=await pending.json();
  assert.equal(pendingBody.authenticated,false);
  assert.match(pendingBody.csrfToken,/^[a-f0-9]{64}$/);
  assert.equal(await token(pendingCookie),null);
  assert.equal((await job(pendingCookie,ownerCsrf,account,"pre-mfa")).status,401);
  rows=await audited();
  assert.equal(rows.at(-1).action,"auth.login.mfa_pending");
  assert.equal(rows.at(-1).outcome,"pending_mfa");

  // A final audit INSERT failure must roll back the entire MFA code
  // consumption AND session-hash rotation transaction.
  await pool.query(
    "ALTER TABLE audit_events ADD CONSTRAINT ci_reject_recovery_audit " +
    "CHECK(action <> 'auth.mfa.recovery') NOT VALID",
  );
  const beforeMfa=await count("audit_events");
  const rejectedRecovery=await call(p.mfa,{
    method:"POST",cookie:pendingCookie,
    csrf:pendingBody.csrfToken,body:{code:recoveryCodes[0]},
  });
  assert.equal(rejectedRecovery.status,503);
  assert.deepEqual(await rejectedRecovery.json(),{error:"postgres_fixture_unavailable"});
  assert.equal(await count("audit_events"),beforeMfa);
  assert.equal((await pool.query(
    "SELECT used_at FROM recovery_codes WHERE user_id=$1 AND code_hash=$2",
    [mfaUser,recoveryCodeHash(recoveryCodes[0])],
  )).rows[0].used_at,null);
  assert.equal((await pool.query(
    "SELECT mfa_verified FROM sessions WHERE token_hash=$1",
    [hash(pendingCookie.split("=")[1])],
  )).rows[0].mfa_verified,false);
  await pool.query("ALTER TABLE audit_events DROP CONSTRAINT ci_reject_recovery_audit");

  const upgraded=await call(p.mfa,{
    method:"POST",cookie:pendingCookie,
    csrf:pendingBody.csrfToken,body:{code:recoveryCodes[0]},
  });
  assert.equal(upgraded.status,200);
  const rotatedCookie=getCookie(upgraded);
  assert.notEqual(rotatedCookie,pendingCookie);
  assert.equal(await token(pendingCookie),null);
  const mfaCsrf=await token(rotatedCookie);
  assert.ok(mfaCsrf);
  rows=await audited();
  assert.equal(rows.at(-1).action,"auth.mfa.recovery");
  assert.equal(rows.at(-1).details_raw_json,
    '{"source":"ci_fixture","method":"recovery_code"}');
  assert.equal((await job(rotatedCookie,mfaCsrf,account,"mfa-job")).status,202);
  assert.equal(await count("job_outbox"),3);

  // Even a successful SQL password verification must not create a session
  // unless its audit entry is durably written in the *same transaction*.
  await pool.query(
    "ALTER TABLE audit_events ADD CONSTRAINT ci_reject_login_audit " +
    "CHECK(action <> 'auth.login.success') NOT VALID",
  );
  const sessionBefore=await count("sessions");
  const auditBefore=await count("audit_events");
  const rejectedLogin=await loginHttp("owner");
  assert.equal(rejectedLogin.status,503);
  assert.deepEqual(await rejectedLogin.json(),{error:"postgres_fixture_unavailable"});
  assert.equal(await count("sessions"),sessionBefore);
  assert.equal(await count("audit_events"),auditBefore);
  await pool.query("ALTER TABLE audit_events DROP CONSTRAINT ci_reject_login_audit");

  // Similarly, logout must not revoke the cookie if the audit append
  // fails. The same previously issued CSRF token still works afterward.
  await pool.query(
    "ALTER TABLE audit_events ADD CONSTRAINT ci_reject_logout_audit " +
    "CHECK(action <> 'auth.logout') NOT VALID",
  );
  const refusedLogout=await call(p.logout,{
    method:"POST",cookie:ownerCookie,csrf:ownerCsrf,
  });
  assert.equal(refusedLogout.status,503);
  assert.equal((await call(p.csrf,{cookie:ownerCookie})).status,200);
  assert.equal(await count("audit_events"),auditBefore);
  await pool.query("ALTER TABLE audit_events DROP CONSTRAINT ci_reject_logout_audit");

  const logout=await call(p.logout,{
    method:"POST",cookie:ownerCookie,csrf:ownerCsrf,
  });
  assert.equal(logout.status,200);
  assert.match(logout.headers.get("set-cookie"),/Max-Age=0/);
  assert.equal((await call(p.csrf,{cookie:ownerCookie})).status,401);
  assert.equal((await job(ownerCookie,ownerCsrf,account,"post-logout")).status,401);
  rows=await audited();
  assert.equal(rows.at(-1).action,"auth.logout");
  assert.equal(rows.at(-1).details_raw_json,
    '{"source":"ci_fixture","method":"session_revocation"}');

  // Deliberately injected unchained legacy audit head cannot be used as a
  // predecessor. The attempted login leaves no session in PostgreSQL.
  const legacyAuditId=randomUUID();
  await pool.query(
    "INSERT INTO audit_events(id,organization_id,actor,action,target_id,"+
    "outcome,details_json,details_raw_json) VALUES($1,$2,$3,'legacy.fake',"+
    "$3,'completed','{}'::jsonb,'{}')",
    [legacyAuditId,tenant,user],
  );
  const beforeLegacy=await count("sessions");
  const deniedLegacy=await loginHttp("owner");
  assert.equal(deniedLegacy.status,503);
  assert.equal(await count("sessions"),beforeLegacy);
  await pool.query("DELETE FROM audit_events WHERE id=$1",[legacyAuditId]);
  await audited();

  console.log(JSON.stringify({
    task:"ORB-005",kind:"disposable_pg_ci_atomic_auth_audit",
    limitedRealDatabaseLogin:true,
    rawCredentialsOrSessionHashesInAudit:false,
    legacyScryptCredentialCutover:false,
    nonOwnerCannotExecuteUnloggedFunctions:true,
    unknownUserFailuresNotTenantAudited:true,
    passwordThrottleRetained:true,
    tenantAuditChainMatchesNode:true,
    preexistingLegacyHeadLinked:true,
    loginAuditSessionCreationAtomic:true,
    mfaAuditCodeConsumptionAndRotationAtomic:true,
    logoutAuditRevocationAtomic:true,
    tamperedAuditHeadRefused:true,
    failedAuditReturnsSanitizedHttp503:true,
    syntheticJobs:await count("jobs"),
    syntheticOutboxEvents:await count("job_outbox"),
    chainedAuditRows:await count("audit_events"),
    productionAuthCutover:false,liveProviderActions:false,
  }));
}finally{
  if(harness)await harness.close();
  if(restrictedPool)await restrictedPool.end();
  await pool.end();
}
