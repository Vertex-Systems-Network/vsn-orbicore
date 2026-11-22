import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { Pool } from "pg";
import { newRecoveryCodes, recoveryCodeHash } from "../apps/api/mfa.mjs";
import { createPostgresCiLoginAdapter } from "../apps/api/postgres-ci-login.mjs";
import { createPostgresSyntheticSubmissionGateway } from "../apps/api/postgres-synthetic-gateway.mjs";
import { createPostgresSyntheticHttpHarness } from "../apps/api/postgres-synthetic-http-harness.mjs";

if(process.env.GITHUB_ACTIONS !== "true" ||
   process.env.ORBICORE_CI_SYNTHETIC_PG_HTTP !== "1" ||
   process.env.ORBICORE_CI_SYNTHETIC_PG_LOGIN !== "1") {
  throw new Error("ci_fixture_login_requires_explicit_github_gates");
}

const ownerPool=new Pool({
  host:process.env.PGHOST ?? "127.0.0.1",
  port:Number(process.env.PGPORT ?? 5432),
  user:process.env.PGUSER ?? "orbicore",
  database:process.env.PGDATABASE ?? "orbicore",
  password:process.env.PGPASSWORD,max:4,connectionTimeoutMillis:5000,
});
let clientPool,server;
const sha=value=>createHash("sha256").update(value).digest("hex");
const org="org-ci-login-primary",orgOther="org-ci-login-other";
const acct="account-ci-login-primary",acctOther="account-ci-login-other";
const acctProvider="account-ci-login-provider";
const email={
  owner:"ci-owner@example.test",mfa:"ci-mfa@example.test",
  viewer:"ci-viewer@example.test",disabled:"ci-disabled@example.test",
  other:"ci-other@example.test",
};
const password=Object.fromEntries(Object.keys(email).map(k=>[
  k,randomBytes(24).toString("base64url"),
]));
const codes=newRecoveryCodes(3);
const count=async table=>Number((await ownerPool.query(
  "SELECT COUNT(*)::int AS count FROM "+table,
)).rows[0].count);
async function forgedHost(base,cookie){
  const target=new URL(base);
  return new Promise((resolve,reject)=>{
    const request=httpRequest({
      hostname:"127.0.0.1",port:Number(target.port),
      path:"/__ci/pg/session/csrf",method:"GET",
      headers:{host:"forged.example.invalid",cookie},
    },response=>{response.resume();response.once("end",()=>resolve(response.statusCode));});
    request.once("error",reject);request.end();
  });
}
try{
  // Every input to the fixture is in memory; no live credentials or provider.
  const login="orbicore_ci_auth_http_login";
  const temporaryDbPassword=randomBytes(32).toString("hex");
  await ownerPool.query(
    "CREATE ROLE orbicore_ci_auth_http_login LOGIN NOINHERIT NOBYPASSRLS " +
    "PASSWORD '"+temporaryDbPassword+"'",
  );
  await ownerPool.query(
    "GRANT orbicore_synthetic_submitter TO orbicore_ci_auth_http_login " +
    "WITH SET TRUE, INHERIT FALSE",
  );
  clientPool=new Pool({
    host:process.env.PGHOST ?? "127.0.0.1",port:Number(process.env.PGPORT ?? 5432),
    user:login,database:process.env.PGDATABASE ?? "orbicore",
    password:temporaryDbPassword,max:8,connectionTimeoutMillis:5000,
  });
  assert.deepEqual((await clientPool.query(
    "SELECT current_user AS name,rolsuper,rolbypassrls " +
    "FROM pg_roles WHERE rolname=current_user",
  )).rows[0],{name:login,rolsuper:false,rolbypassrls:false});
  for(const sql of [
    "SELECT password_hash FROM public.users",
    "SELECT code_hash FROM public.recovery_codes",
    "SELECT token_hash FROM public.sessions",
    "SELECT email_digest FROM public.ci_pg_login_limits",
  ]) await assert.rejects(clientPool.query(sql),e=>e.code==="42501");
  await assert.rejects(clientPool.query(
    "SELECT * FROM public.orbicore_ci_password_login($1,$2,$3)",
    [email.owner,password.owner,sha("nonexistent-session")],
  ),e=>e.code==="42501");

  for(const [id,name] of [[org,"Primary CI tenant"],[orgOther,"Other CI tenant"]]){
    await ownerPool.query(
      "INSERT INTO organizations(id,name) VALUES ($1,$2)",[id,name],
    );
  }
  for(const [id,orgId,source] of [
    [acct,org,"mock_fixture"],[acctOther,orgOther,"mock_fixture"],
    [acctProvider,org,"provider"],
  ]){
    await ownerPool.query(
      "INSERT INTO accounts(id,organization_id,label,provider,host,username,health," +
      "used_bytes,quota_bytes,source) VALUES ($1,$2,'Only synthetic','mock'," +
      "'none.example.invalid','fixture','healthy',0,1,$3)",
      [id,orgId,source],
    );
  }
  for(const [id,orgId,role,disabled,mfaEnabled] of [
    ["owner",org,"owner",false,false],
    ["mfa",org,"operator",false,true],
    ["viewer",org,"viewer",false,false],
    ["disabled",org,"admin",true,false],
    ["other",orgOther,"owner",false,false],
  ]){
    await ownerPool.query(
      "INSERT INTO users(id,organization_id,email,password_salt,password_hash," +
      "role,disabled,mfa_enabled) VALUES ($1,$2,$3,'ci_pg_bcrypt_only'," +
      "public.crypt($4,public.gen_salt('bf',10)),$5,$6,$7)",
      ["ci-fixture-"+id,orgId,email[id],password[id],role,disabled,mfaEnabled],
    );
  }
  for(const code of codes){
    await ownerPool.query(
      "INSERT INTO recovery_codes(user_id,organization_id,code_hash) " +
      "VALUES('ci-fixture-mfa',$1,$2)",
      [org,recoveryCodeHash(code)],
    );
  }
  // A synthetically-created legacy-marker record must not be accepted by
  // this separate CI bcrypt path, even if its stored hash is valid bcrypt.
  const unsupportedPassword=randomBytes(24).toString("base64url");
  await ownerPool.query(
    "INSERT INTO users(id,organization_id,email,password_salt,password_hash,role) " +
    "VALUES('ci-legacy-marker',$1,'legacy-scrypt@example.test'," +
    "'ci_legacy_scrypt_only',public.crypt($2,public.gen_salt('bf',10)),'owner')",
    [org,unsupportedPassword],
  );

  const gateway=createPostgresSyntheticSubmissionGateway(clientPool);
  const auth=createPostgresCiLoginAdapter(clientPool);
  server=createPostgresSyntheticHttpHarness({gateway,loginAdapter:auth});
  const base=await server.start();
  const loginPath="/__ci/pg/auth/login";
  const mfaPath="/__ci/pg/auth/mfa/recovery";
  const logoutPath="/__ci/pg/auth/logout";
  const csrfPath="/__ci/pg/session/csrf";
  const jobPath="/__ci/pg/jobs/refresh";

  async function call(path,{method="GET",cookie,csrf,body,key,origin=base,headers={}}={}){
    return fetch(base+path,{
      method,
      headers:{
        ...(cookie?{cookie}:{}),
        ...(csrf?{"x-orbicore-csrf":csrf}:{}),
        ...(key?{"idempotency-key":key}:{}),
        ...(body!==undefined?{"content-type":"application/json"}:{}),
        ...(method!=="GET"?{origin}:{}),
        ...headers,
      },
      ...(body!==undefined?{body:JSON.stringify(body)}:{}),
    });
  }
  const getCookie=response=>response.headers.get("set-cookie")?.split(";")[0];
  async function signIn(id,secret=password[id]){
    return call(loginPath,{method:"POST",body:{email:email[id],password:secret}});
  }
  async function csrf(cookie){
    const r=await call(csrfPath,{cookie});
    return r.status===200?(await r.json()).csrfToken:null;
  }
  async function job(cookie,csrfToken,accountId=acct,key="test-job"){
    return call(jobPath,{method:"POST",cookie,csrf:csrfToken,
      body:{accountId},key});
  }

  assert.equal((await call(loginPath,{method:"POST",
    body:{email:email.owner,password:password.owner},origin:"https://evil.invalid"})).status,403);
  assert.equal((await call(loginPath)).status,405);
  assert.equal((await call("/__ci/pg/auth/missing",{method:"POST"})).status,404);
  assert.equal((await call(loginPath,{method:"POST",body:{
    email:email.owner,password:password.owner,organizationId:orgOther,
  }})).status,400);
  assert.equal((await call(loginPath,{method:"POST",body:{
    email:email.disabled,password:password.disabled,
  }})).status,401);
  assert.equal((await call(loginPath,{method:"POST",body:{
    email:email.owner,password:password.other,
  }})).status,401);
  assert.equal((await call(loginPath,{method:"POST",body:{
    email:"not-present@example.invalid",password:password.owner,
  }})).status,401);
  assert.equal((await call(loginPath,{method:"POST",body:{
    email:"legacy-scrypt@example.test",password:unsupportedPassword,
  }})).status,401);

  // Source-controlled credentials are never needed: SQL verifies randomly
  // generated per-test bcrypt secrets internally without returning hashes.
  const loginResponse=await signIn("owner");
  assert.equal(loginResponse.status,200);
  const firstCookie=getCookie(loginResponse);
  assert.match(firstCookie,/^orbicore_session=[A-Za-z0-9_-]{32,}$/);
  const header=loginResponse.headers.get("set-cookie");
  assert.match(header,/HttpOnly/);
  assert.match(header,/SameSite=Strict/);
  assert.match(header,/Max-Age=3600/);
  assert.equal(header.includes("Secure"),false,"HTTP loopback fixture cannot issue TLS cookies");
  const ownerBody=await loginResponse.json();
  assert.deepEqual(ownerBody,{
    authenticated:true,mfaRequired:false,source:"postgres_ci_only",
  });
  assert.equal(await forgedHost(base,firstCookie),403);
  const ownerCsrf=await csrf(firstCookie);
  assert.match(ownerCsrf,/^[a-f0-9]{64}$/);
  assert.equal((await job(firstCookie,null)).status,403);
  assert.equal((await job(firstCookie,"0".repeat(64))).status,403);
  assert.equal((await job(firstCookie,ownerCsrf,acctOther,"cross-tenant")).status,403);
  assert.equal((await job(firstCookie,ownerCsrf,acctProvider,"live-account")).status,403);
  const first=await job(firstCookie,ownerCsrf,acct,"owner-fixture");
  assert.equal(first.status,202);
  const firstJob=(await first.json()).jobId;
  assert.ok(firstJob);
  const duplicate=await job(firstCookie,ownerCsrf,acct,"owner-fixture");
  assert.equal(duplicate.status,200);
  assert.equal((await duplicate.json()).jobId,firstJob);
  assert.equal(await count("jobs"),1);
  assert.equal(await count("job_outbox"),1);
  assert.equal(await count("audit_events"),1);

  const viewerResponse=await signIn("viewer");
  assert.equal(viewerResponse.status,200);
  const viewerCookie=getCookie(viewerResponse);
  assert.equal((await call(csrfPath,{cookie:viewerCookie})).status,401);
  assert.equal((await job(viewerCookie,ownerCsrf,acct,"viewer")).status,401);

  const otherResponse=await signIn("other");
  assert.equal(otherResponse.status,200);
  const otherCookie=getCookie(otherResponse);
  const otherCsrf=await csrf(otherCookie);
  assert.ok(otherCsrf);
  assert.equal((await job(otherCookie,otherCsrf,acct,"foreign")).status,403);
  assert.equal((await job(otherCookie,otherCsrf,acctOther,"other-fixture")).status,202);
  assert.equal((await job(otherCookie,ownerCsrf,acctOther,"stolen-csrf")).status,403);
  assert.equal(await count("jobs"),2);

  // Pending MFA cookie must not be authorized by the normal session probe.
  const pendingResponse=await signIn("mfa");
  assert.equal(pendingResponse.status,202);
  const pendingCookie=getCookie(pendingResponse);
  assert.match(pendingResponse.headers.get("set-cookie"),/Max-Age=300/);
  const pendingBody=await pendingResponse.json();
  assert.equal(pendingBody.authenticated,false);
  assert.equal(pendingBody.mfaRequired,true);
  assert.match(pendingBody.csrfToken,/^[0-9a-f]{64}$/);
  assert.equal((await call(csrfPath,{cookie:pendingCookie})).status,401);
  assert.equal((await job(pendingCookie,ownerCsrf,acct,"pre-mfa")).status,401);
  assert.equal((await call(mfaPath,{method:"POST",cookie:pendingCookie,
    body:{code:codes[0]},csrf:"0".repeat(64)})).status,403);
  const wrongCode=randomBytes(16).toString("base64url").toUpperCase();
  assert.equal((await call(mfaPath,{method:"POST",cookie:pendingCookie,
    body:{code:wrongCode},csrf:pendingBody.csrfToken})).status,401);
  const verified=await call(mfaPath,{method:"POST",cookie:pendingCookie,
    csrf:pendingBody.csrfToken,body:{code:codes[0]}});
  assert.equal(verified.status,200);
  const rotatedCookie=getCookie(verified);
  assert.ok(rotatedCookie);
  assert.notEqual(rotatedCookie,pendingCookie);
  assert.match(verified.headers.get("set-cookie"),/Max-Age=3600/);
  assert.equal((await call(csrfPath,{cookie:pendingCookie})).status,401);
  assert.equal((await call(mfaPath,{method:"POST",cookie:pendingCookie,
    csrf:pendingBody.csrfToken,body:{code:codes[1]}})).status,401);
  const mfaCsrf=await csrf(rotatedCookie);
  assert.ok(mfaCsrf);
  assert.equal((await job(rotatedCookie,mfaCsrf,acct,"mfa-fixture")).status,202);
  assert.equal(await count("jobs"),3);
  assert.equal(await count("job_outbox"),3);
  assert.equal(await count("audit_events"),3);
  const consumed=await ownerPool.query(
    "SELECT used_at FROM recovery_codes WHERE user_id='ci-fixture-mfa' AND code_hash=$1",
    [recoveryCodeHash(codes[0])],
  );
  assert.ok(consumed.rows[0].used_at,"MFA code must be one-time");

  // Replaying an already-used recovery code in a new pending session fails.
  const secondPending=await signIn("mfa");
  assert.equal(secondPending.status,202);
  const secondCookie=getCookie(secondPending);
  const secondCsrf=(await secondPending.json()).csrfToken;
  assert.equal((await call(mfaPath,{method:"POST",cookie:secondCookie,
    csrf:secondCsrf,body:{code:codes[0]}})).status,401);
  const secondVerified=await call(mfaPath,{method:"POST",cookie:secondCookie,
    csrf:secondCsrf,body:{code:codes[1]}});
  assert.equal(secondVerified.status,200);
  assert.notEqual(getCookie(secondVerified),secondCookie);

  // Five invalid recovery codes must delete a pending MFA session and
  // prevent a later valid code from reviving it.
  const exhaustedPending=await signIn("mfa");
  assert.equal(exhaustedPending.status,202);
  const exhaustedCookie=getCookie(exhaustedPending);
  const exhaustedCsrf=(await exhaustedPending.json()).csrfToken;
  for(let i=0;i<5;i++){
    const wrong=randomBytes(16).toString("base64url").toUpperCase();
    assert.equal((await call(mfaPath,{method:"POST",cookie:exhaustedCookie,
      csrf:exhaustedCsrf,body:{code:wrong}})).status,401);
  }
  assert.equal((await call(mfaPath,{method:"POST",cookie:exhaustedCookie,
    csrf:exhaustedCsrf,body:{code:codes[2]}})).status,401);
  const exhaustedState=await ownerPool.query(
    "SELECT count(*)::integer AS count FROM sessions WHERE token_hash=$1",
    [sha(exhaustedCookie.split("=")[1])],
  );
  assert.equal(exhaustedState.rows[0].count,0);
  const remainingCode=await ownerPool.query(
    "SELECT used_at FROM recovery_codes WHERE user_id='ci-fixture-mfa' AND code_hash=$1",
    [recoveryCodeHash(codes[2])],
  );
  assert.equal(remainingCode.rows[0].used_at,null);

  // Login rate limit lives in PostgreSQL, not process-local memory.
  for(let i=0;i<5;i++){
    const bad=await signIn("owner",password.other);
    assert.equal(bad.status,i===4?429:401);
  }
  assert.equal((await signIn("owner")).status,429);
  const limitedRows=await ownerPool.query(
    "SELECT email_digest,failures,locked_until FROM ci_pg_login_limits",
  );
  assert.ok(limitedRows.rows.every(row=>
    /^[0-9a-f]{64}$/.test(row.email_digest)));
  assert.ok(limitedRows.rows.some(row=>row.failures===5&&row.locked_until));

  // Old session stays valid until explicitly revoked, despite new login
  // throttling; logout immediately removes the PostgreSQL session.
  const loggedOut=await call(logoutPath,{method:"POST",cookie:firstCookie,
    csrf:ownerCsrf});
  assert.equal(loggedOut.status,200);
  assert.match(loggedOut.headers.get("set-cookie"),/Max-Age=0/);
  assert.equal((await call(csrfPath,{cookie:firstCookie})).status,401);
  assert.equal((await job(firstCookie,ownerCsrf,acct,"replay-logout")).status,401);
  assert.equal((await call(logoutPath,{method:"POST",cookie:otherCookie,
    csrf:ownerCsrf})).status,403);
  assert.equal((await call(logoutPath,{method:"POST",cookie:otherCookie,
    csrf:otherCsrf,origin:"https://evil.invalid"})).status,403);
  assert.equal((await call(logoutPath,{method:"POST",cookie:otherCookie,
    csrf:otherCsrf})).status,200);

  // A client-created temp session cannot acquire policy when its user gets
  // disabled or its tenant account becomes a provider account.
  await ownerPool.query(
    "UPDATE users SET disabled=TRUE WHERE id='ci-fixture-mfa'",
  );
  assert.equal((await call(csrfPath,{cookie:rotatedCookie})).status,401);
  assert.equal(await count("jobs"),3);
  assert.equal(await count("job_outbox"),3);
  assert.equal(await count("audit_events"),3);

  // A limited fixture-login DB role has no direct credential read/write.
  await assert.rejects(clientPool.query(
    "UPDATE users SET role='owner' WHERE id='ci-fixture-viewer'",
  ),e=>e.code==="42501");
  await assert.rejects(clientPool.query(
    "SELECT * FROM public.orbicore_ci_finish_recovery_mfa($1,$2,$3)",
    [sha("old"),sha("new"),sha("code")],
  ),e=>e.code==="42501");

  console.log(JSON.stringify({
    task:"ORB-005",kind:"pg-ci-bcrypt-login-recovery-mfa-cookie-lifecycle",
    environment:"disposable_github_postgres16",live:false,
    loginCredentialFormat:"ci_pg_bcrypt_only_not_sqlite_scrypt",
    realNonOwnerLogin:true,noDirectCredentialAccess:true,
    randomFixtureCredentialsOnly:true,
    httpLoginSetsHttpOnlySameSiteStrictCookie:true,
    loopbackHttpOmittedSecure:true,
    noStoreCsrfCookieBound:true,
    passwordRateLimitPersistedInPg:true,
    pendingMfaDoesNotAuthorizeWrites:true,
    recoveryCodeSingleUse:true,
    pendingMfaLockedOutAfterFiveBadCodes:true,
    legacyCredentialMarkerDenied:true,
    mfaTokenRotated:true,
    sessionAndUserRevocationVerified:true,
    csrfAndOriginAndHostChecks:true,
    crossTenantAndProviderDenied:true,
    logoutRevokesAndClearsCookie:true,
    rawSessionTokensInEvidence:false,
    activeSyntheticJobs:await count("jobs"),
    durableOutboxEntries:await count("job_outbox"),
    linkedAuditEntries:await count("audit_events"),
    productionAuthRouteSwitched:false,
    productionSQLiteScryptMigration:false,
    realTotpKeysOrPasskeysVerified:false,
    liveProviderActions:false,
  }));
}finally{
  if(server) await server.close();
  if(clientPool) await clientPool.end();
  await ownerPool.end();
}
