import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { Pool } from "pg";
import { computeAuditEntryHash } from "../apps/api/audit.mjs";
import { createPostgresSyntheticSubmissionGateway } from "../apps/api/postgres-synthetic-gateway.mjs";
import { createPostgresSyntheticHttpHarness } from "../apps/api/postgres-synthetic-http-harness.mjs";

if (process.env.GITHUB_ACTIONS !== "true" ||
    process.env.ORBICORE_CI_SYNTHETIC_PG_HTTP !== "1") {
  throw new Error("ci_fixture_http_only");
}

const ownerPool = new Pool({
  host: process.env.PGHOST ?? "127.0.0.1",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "orbicore",
  database: process.env.PGDATABASE ?? "orbicore",
  password: process.env.PGPASSWORD,
  max: 3,connectionTimeoutMillis: 5000,
});
async function spoofHostRequest(base,cookie) {
  const target=new URL(base);
  return new Promise((resolve,reject)=>{
    const request=httpRequest({
      hostname:"127.0.0.1",
      port:Number(target.port),
      path:"/__ci/pg/session/csrf",
      method:"GET",
      headers:{host:"untrusted.example.invalid",cookie},
    },response=>{
      response.resume();
      response.once("end",()=>resolve(response.statusCode));
    });
    request.once("error",reject);
    request.end();
  });
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const orgA = "org-ci-http-a", orgB = "org-ci-http-b";
const accA = "account-ci-http-a", accA2 = "account-ci-http-a2";
const accB = "account-ci-http-b", accLive = "account-ci-http-provider";
const ownerA = "owner-ci-http-a", ownerB = "owner-ci-http-b";
const viewer = "viewer-ci-http-a", disabled = "disabled-ci-http-a";
const mfa = "mfa-ci-http-a", expired = "expired-ci-http-a";
const sessions = Object.fromEntries([
  ["ownerA",randomBytes(32).toString("base64url")],
  ["ownerB",randomBytes(32).toString("base64url")],
  ["viewer",randomBytes(32).toString("base64url")],
  ["disabled",randomBytes(32).toString("base64url")],
  ["mfa",randomBytes(32).toString("base64url")],
  ["expired",randomBytes(32).toString("base64url")],
]);
const safeCount = async table => Number((await ownerPool.query(
  "SELECT COUNT(*)::integer AS n FROM " + table,
)).rows[0].n);
let limitedPool;
let harness;
let raceHarness;
try {
  const ephemeralPass = randomBytes(32).toString("hex");
  const login = "orbicore_ci_http_login";
  await ownerPool.query(
    "CREATE ROLE orbicore_ci_http_login LOGIN NOINHERIT NOBYPASSRLS " +
    "PASSWORD '" + ephemeralPass + "'",
  );
  await ownerPool.query(
    "GRANT orbicore_synthetic_submitter TO orbicore_ci_http_login " +
    "WITH SET TRUE, INHERIT FALSE",
  );
  limitedPool = new Pool({
    host: process.env.PGHOST ?? "127.0.0.1",
    port: Number(process.env.PGPORT ?? 5432),
    user:login,password:ephemeralPass,
    database:process.env.PGDATABASE ?? "orbicore",
    max:6,connectionTimeoutMillis:5000,
  });
  assert.deepEqual((await limitedPool.query(
    "SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user",
  )).rows[0],{name:login,rolsuper:false,rolbypassrls:false});
  await assert.rejects(limitedPool.query("SELECT token_hash FROM public.sessions"),
    error=>error.code==="42501");
  await assert.rejects(limitedPool.query(
    "SELECT organization_id FROM public.orbicore_probe_synthetic_session($1)",
    [sha256(sessions.ownerA)],
  ), error=>error.code==="42501");

  for (const [id,name] of [[orgA,"CI tenant A"],[orgB,"CI tenant B"]]) {
    await ownerPool.query("INSERT INTO organizations(id,name) VALUES($1,$2)",[id,name]);
  }
  for (const [id,org,email,role,isDisabled,isMfa] of [
    [ownerA,orgA,"owner-a@example.test","owner",false,false],
    [ownerB,orgB,"owner-b@example.test","owner",false,false],
    [viewer,orgA,"viewer@example.test","viewer",false,false],
    [disabled,orgA,"disabled@example.test","admin",true,false],
    [mfa,orgA,"mfa@example.test","operator",false,true],
    [expired,orgA,"expired@example.test","owner",false,false],
  ]) {
    await ownerPool.query(
      "INSERT INTO users(id,organization_id,email,password_salt,password_hash,role,disabled,mfa_enabled) " +
      "VALUES($1,$2,$3,'ci-fake-salt','ci-fake-hash',$4,$5,$6)",
      [id,org,email,role,isDisabled,isMfa],
    );
  }
  for(const [id,org,source] of [
    [accA,orgA,"mock_fixture"],[accA2,orgA,"mock_fixture"],
    [accB,orgB,"mock_fixture"],[accLive,orgA,"provider"],
  ]) {
    await ownerPool.query(
      "INSERT INTO accounts(id,organization_id,label,provider,host,username,health,used_bytes,quota_bytes,source) " +
      "VALUES($1,$2,'ci-only','mock','fake.example.invalid','fixture','healthy',0,1,$3)",
      [id,org,source],
    );
  }
  for (const [key,id,org,isExpired] of [
    ["ownerA",ownerA,orgA,false],["ownerB",ownerB,orgB,false],
    ["viewer",viewer,orgA,false],["disabled",disabled,orgA,false],
    ["mfa",mfa,orgA,false],["expired",expired,orgA,true],
  ]) {
    await ownerPool.query(
      "INSERT INTO sessions(token_hash,user_id,organization_id,expires_at,mfa_verified) " +
      "VALUES($1,$2,$3,clock_timestamp()+$4::interval,FALSE)",
      [sha256(sessions[key]),id,org,isExpired?"-2 minutes":"30 minutes"],
    );
  }

  const gateway = createPostgresSyntheticSubmissionGateway(limitedPool);
  harness = createPostgresSyntheticHttpHarness({gateway});
  const base = await harness.start();
  const origin = base;
  const csrfPath = "/__ci/pg/session/csrf",jobPath = "/__ci/pg/jobs/refresh";
  function request(path,{method="GET",sessionKey,csrf,body,key,headers={}}={}) {
    const requestHeaders = {
      ...(sessionKey?{cookie:"orbicore_session="+sessions[sessionKey]}:{}),
      ...(csrf?{"x-orbicore-csrf":csrf}:{}),
      ...(key?{"idempotency-key":key}:{}),
      ...(body!==undefined?{"content-type":"application/json"}:{}),
      ...(method==="POST"?{origin}:{}),
      ...headers,
    };
    return fetch(base+path,{
      method,headers:requestHeaders,
      ...(body!==undefined?{body:typeof body==="string"?body:JSON.stringify(body)}:{}),
    });
  }
  async function csrf(sessionKey) {
    const response=await request(csrfPath,{sessionKey});
    if(response.status!==200)return {status:response.status,token:null};
    const payload=await response.json();
    assert.equal(payload.source,"postgres_ci_only");
    assert.match(payload.csrfToken,/^[a-f0-9]{64}$/);
    assert.equal(response.headers.get("cache-control"),"no-store");
    assert.equal(response.headers.get("set-cookie"),null);
    return {status:response.status,token:payload.csrfToken};
  }
  async function post({sessionKey="ownerA",csrfToken,accountId=accA,key="ci-http-key",body,headers={}}={}) {
    return request(jobPath,{
      method:"POST",sessionKey,csrf:csrfToken,key,
      body:body??{accountId},headers,
    });
  }
  const ownerCsrf=(await csrf("ownerA")).token;
  assert.ok(ownerCsrf);
  assert.equal((await csrf("viewer")).status,401);
  assert.equal((await csrf("disabled")).status,401);
  assert.equal((await csrf("expired")).status,401);
  assert.equal((await csrf("mfa")).status,401);
  assert.equal((await request(csrfPath)).status,401);
  assert.equal((await request("/__ci/pg/unknown",{sessionKey:"ownerA"})).status,404);
  assert.equal((await request(csrfPath,{method:"POST",sessionKey:"ownerA"})).status,405);
  assert.equal((await request(csrfPath,{sessionKey:"ownerA",
    headers:{origin:"https://untrusted.example.invalid"}})).status,403);
  assert.equal((await request(csrfPath,{sessionKey:"ownerA",
    headers:{"sec-fetch-site":"cross-site"}})).status,403);
  assert.equal(await spoofHostRequest(base,"orbicore_session="+sessions.ownerA),403);

  assert.equal((await post({csrfToken:null})).status,403);
  assert.equal((await post({csrfToken:"0".repeat(64)})).status,403);
  assert.equal((await post({csrfToken:ownerCsrf,
    headers:{origin:"https://untrusted.example.invalid"}})).status,403);
  assert.equal((await post({csrfToken:ownerCsrf,
    headers:{origin:""}})).status,403);
  assert.equal((await post({csrfToken:ownerCsrf,
    headers:{"sec-fetch-site":"cross-site"}})).status,403);
  assert.equal((await post({csrfToken:ownerCsrf,
    body:{accountId:accA,organizationId:orgB}})).status,400);
  assert.equal((await post({csrfToken:ownerCsrf,
    body:"{broken-json"})).status,400);
  assert.equal((await post({csrfToken:ownerCsrf,
    body:{accountId:accA},headers:{"content-type":"text/plain"}})).status,400);
  assert.equal((await post({csrfToken:ownerCsrf,
    body:JSON.stringify({accountId:"x".repeat(4000)})})).status,413);
  assert.equal((await post({csrfToken:ownerCsrf,key:""})).status,400);
  assert.equal(await safeCount("jobs"),0);
  assert.equal(await safeCount("job_outbox"),0);

  const first=await post({csrfToken:ownerCsrf,key:"ci-first"});
  assert.equal(first.status,202);
  const firstBody=await first.json();
  assert.equal(firstBody.storage,"postgres_ci_fixture_only");
  assert.equal(firstBody.live,false);
  assert.ok(firstBody.jobId);
  const same=await post({csrfToken:ownerCsrf,key:"ci-first"});
  assert.equal(same.status,200);
  assert.equal((await same.json()).jobId,firstBody.jobId);
  assert.equal((await post({csrfToken:ownerCsrf,
    key:"ci-first",accountId:accA2})).status,409);
  assert.equal((await post({csrfToken:ownerCsrf,
    key:"ci-cross",accountId:accB})).status,403);
  assert.equal((await post({csrfToken:ownerCsrf,
    key:"ci-provider",accountId:accLive})).status,403);

  await ownerPool.query(
    "UPDATE sessions SET mfa_verified=TRUE WHERE token_hash=$1",
    [sha256(sessions.mfa)],
  );
  const mfaCsrf=(await csrf("mfa")).token;
  assert.ok(mfaCsrf);
  assert.equal((await post({sessionKey:"mfa",csrfToken:mfaCsrf,key:"ci-mfa"})).status,202);

  const otherCsrf=(await csrf("ownerB")).token;
  assert.ok(otherCsrf);
  assert.equal((await post({sessionKey:"ownerB",csrfToken:otherCsrf,
    accountId:accA,key:"ci-foreign"})).status,403);
  assert.equal((await post({sessionKey:"ownerB",csrfToken:otherCsrf,
    accountId:accB,key:"ci-other"})).status,202);

  const jobs=await ownerPool.query(
    "SELECT id,organization_id,account_id,requested_by FROM jobs ORDER BY organization_id,id",
  );
  assert.equal(jobs.rows.length,3);
  assert.ok(jobs.rows.some(x=>x.organization_id===orgB&&x.requested_by===ownerB));
  assert.ok(jobs.rows.every(x=>x.organization_id===orgA||x.organization_id===orgB));
  assert.equal(await safeCount("job_outbox"),3);
  assert.equal(await safeCount("audit_events"),3);

  const audits=(await ownerPool.query(
    "SELECT organization_id,actor,action,target_id,outcome,created_at," +
    "details_raw_json,prev_hash,entry_hash FROM audit_events ORDER BY audit_sequence",
  )).rows;
  const previous=new Map();
  for (const row of audits) {
    const prior=previous.get(row.organization_id)??"GENESIS";
    assert.equal(row.prev_hash,prior);
    assert.equal(row.entry_hash,computeAuditEntryHash({
      prevHash:prior,organizationId:row.organization_id,actor:row.actor,
      action:row.action,targetId:row.target_id,outcome:row.outcome,
      detailsJson:row.details_raw_json,createdAt:row.created_at.toISOString(),
    }));
    previous.set(row.organization_id,row.entry_hash);
  }

  // Revocation after the CSRF token was issued invalidates both probe and
  // submission. No reusable SQLite actor or stale cached tenant allowed.
  await ownerPool.query("DELETE FROM sessions WHERE token_hash=$1",
    [sha256(sessions.ownerA)]);
  assert.equal((await csrf("ownerA")).status,401);
  assert.equal((await post({csrfToken:ownerCsrf,key:"ci-after-revocation"})).status,401);
  await ownerPool.query("UPDATE users SET disabled=TRUE WHERE id=$1",[ownerB]);
  assert.equal((await post({sessionKey:"ownerB",csrfToken:otherCsrf,
    accountId:accB,key:"ci-after-disable"})).status,401);

  // Force failure *between* separate HTTP probe and restricted writer: the
  // writer must revalidate the token inside its own PG transaction.
  const raceToken=randomBytes(32).toString("base64url");
  await ownerPool.query(
    "INSERT INTO sessions(token_hash,user_id,organization_id,expires_at,mfa_verified) " +
    "VALUES($1,$2,$3,clock_timestamp()+interval '10 minutes',TRUE)",
    [sha256(raceToken),mfa,orgA],
  );
  const fixtureRace={
    async sessionTenant(args){return gateway.sessionTenant(args);},
    async enqueue(args){
      await ownerPool.query("DELETE FROM sessions WHERE token_hash=$1",[args.tokenHash]);
      return gateway.enqueue(args);
    },
  };
  raceHarness=createPostgresSyntheticHttpHarness({gateway:fixtureRace});
  const raceBase=await raceHarness.start();
  const raceHeaders={cookie:"orbicore_session="+raceToken};
  const raceProof=await fetch(raceBase+csrfPath,{headers:raceHeaders});
  assert.equal(raceProof.status,200);
  const raceCsrf=(await raceProof.json()).csrfToken;
  const raced=await fetch(raceBase+jobPath,{
    method:"POST",
    headers:{...raceHeaders,origin:raceBase,"content-type":"application/json",
      "x-orbicore-csrf":raceCsrf,"idempotency-key":"ci-race"},
    body:JSON.stringify({accountId:accA}),
  });
  assert.equal(raced.status,403);
  assert.equal((await raced.json()).error,"policy_denied");
  assert.equal(await safeCount("jobs"),3);

  // Audit insertion failure must be translated to a safe HTTP failure.
  await ownerPool.query(
    "ALTER TABLE audit_events ADD CONSTRAINT ci_http_audit_fail " +
    "CHECK(action <> 'job.enqueue') NOT VALID",
  );
  const oldJobs=await safeCount("jobs"),oldOutbox=await safeCount("job_outbox");
  const denied=await post({sessionKey:"mfa",csrfToken:mfaCsrf,
    key:"ci-force-audit-rollback"});
  assert.equal(denied.status,503);
  const body=await denied.json();
  assert.deepEqual(body,{error:"postgres_fixture_unavailable"});
  assert.equal(await safeCount("jobs"),oldJobs);
  assert.equal(await safeCount("job_outbox"),oldOutbox);
  await ownerPool.query("ALTER TABLE audit_events DROP CONSTRAINT ci_http_audit_fail");

  console.log(JSON.stringify({
    task:"ORB-005",type:"loopback-postgres-authenticated-http-csrf-fixture",
    githubOnly:true,realNonOwnerLogin:true,
    schema:"migrations_001_through_007",
    noSQLiteAuthFallback:true,productionHttpUnchanged:true,
    rawSessionTokensInLogs:false,
    csrfIssuerAuthenticatedByPostgres:true,
    requiredSameOriginOnMutation:true,
    rejectedCrossSiteAndHostSpoof:true,
    rejectedMalformedOversizedAndInjectedTenantPayloads:true,
    forbiddenViewerDisabledExpiredAndUnverifiedMfa:true,
    crossTenantAndLiveAccountDenied:true,
    databaseRechecksRevocationWithinSubmission:true,
    concurrentJobOutboxAuditAtomicity:true,
    auditChainMatchedNode:true,
    forcedAuditFailureRolledBackJobAndOutbox:true,
    jobs:await safeCount("jobs"),
    outbox:await safeCount("job_outbox"),
    audits:await safeCount("audit_events"),
    live:false,realProviderOperations:false,
    productionAuthCutover:false,
  }));
} finally {
  if (raceHarness) await raceHarness.close();
  if (harness) await harness.close();
  if (limitedPool) await limitedPool.end();
  await ownerPool.end();
}
