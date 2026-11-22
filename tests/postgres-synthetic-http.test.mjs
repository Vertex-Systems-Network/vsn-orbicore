import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import { createPostgresSyntheticHttpHarness } from "../apps/api/postgres-synthetic-http-harness.mjs";

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

function withCi(fn) {
  const originalGithub = process.env.GITHUB_ACTIONS;
  const originalFixture = process.env.ORBICORE_CI_SYNTHETIC_PG_HTTP;
  process.env.GITHUB_ACTIONS = "true";
  process.env.ORBICORE_CI_SYNTHETIC_PG_HTTP = "1";
  return Promise.resolve().then(fn).finally(() => {
    if (originalGithub === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = originalGithub;
    if (originalFixture === undefined) delete process.env.ORBICORE_CI_SYNTHETIC_PG_HTTP;
    else process.env.ORBICORE_CI_SYNTHETIC_PG_HTTP = originalFixture;
  });
}

test("ORB-005: HTTP fixture requires explicit CI gate and strict mock gateway", async () => {
  await withCi(async () => {
    delete process.env.ORBICORE_CI_SYNTHETIC_PG_HTTP;
    assert.throws(() => createPostgresSyntheticHttpHarness({
      gateway: {enqueue(){},sessionTenant(){}},
    }),/synthetic_http_github_ci_only/);
    process.env.ORBICORE_CI_SYNTHETIC_PG_HTTP = "1";
    assert.throws(() => createPostgresSyntheticHttpHarness({
      gateway: {enqueue(){}},
    }),/sessionTenant and enqueue/);
    assert.throws(() => createPostgresSyntheticHttpHarness({
      gateway:{enqueue(){},sessionTenant(){}},csrfSecret:Buffer.alloc(10),
    }),/32\+ random bytes/);
  });
});

test("ORB-005: loopback HTTP rejects unauthenticated and cross-origin requests before PG writes", async () => {
  await withCi(async () => {
    const session=randomBytes(32).toString("base64url");
    const expectedHash=createHash("sha256").update(session).digest("hex");
    let writes=0,probes=0;
    const gateway={
      async sessionTenant({tokenHash}){
        probes++;
        return tokenHash===expectedHash?"org-ci-fixture":null;
      },
      async enqueue({tokenHash,organizationId,accountId,idempotencyKey}){
        assert.equal(tokenHash,expectedHash);
        assert.equal(organizationId,"org-ci-fixture");
        assert.equal(accountId,"account-ci-fixture");
        assert.equal(idempotencyKey,"ci-key");
        writes++;
        return {jobId:"job-ci-fixture",created:writes===1};
      },
    };
    const harness=createPostgresSyntheticHttpHarness({gateway});
    try {
      const base=await harness.start(),cookie="orbicore_session="+session;
      assert.equal((await fetch(base+"/__ci/pg/session/csrf")).status,401);
      assert.equal(await spoofHostRequest(base,cookie),403);
      assert.equal((await fetch(base+"/__ci/pg/session/csrf",{
        headers:{cookie,origin:"https://untrusted.invalid"},
      })).status,403);
      assert.equal(probes,0);
      const csrfResponse=await fetch(base+"/__ci/pg/session/csrf",{headers:{cookie}});
      assert.equal(csrfResponse.status,200);
      assert.equal(csrfResponse.headers.get("set-cookie"),null);
      const {csrfToken}=await csrfResponse.json();
      assert.match(csrfToken,/^[a-f0-9]{64}$/);
      assert.equal(csrfResponse.headers.get("cache-control"),"no-store");
      assert.equal((await fetch(base+"/__ci/pg/jobs/refresh",{headers:{cookie}})).status,405);
      assert.equal((await fetch(base+"/__ci/pg/session/csrf",{
        method:"POST",headers:{cookie,origin:base},
      })).status,405);
      assert.equal((await fetch(base+"/__ci/pg/session/csrf",{
        headers:{cookie:"orbicore_session="+randomBytes(32).toString("base64url")},
      })).status,401);
      const post=({origin=base,headers={},body={accountId:"account-ci-fixture"}}={})=>
        fetch(base+"/__ci/pg/jobs/refresh",{
          method:"POST",
          headers:{
            cookie,origin,
            "x-orbicore-csrf":csrfToken,
            "content-type":"application/json",
            "idempotency-key":"ci-key",
            ...headers,
          },
          body:JSON.stringify(body),
        });
      assert.equal((await post({headers:{"x-orbicore-csrf":"0".repeat(64)}})).status,403);
      assert.equal((await post({origin:"https://untrusted.invalid"})).status,403);
      assert.equal((await post({body:{accountId:"account-ci-fixture",organizationId:"org-spoof"}})).status,400);
      assert.equal(writes,0);
      assert.equal((await post()).status,202);
      assert.equal((await post()).status,200);
      assert.equal(writes,2);
    }finally{await harness.close();}
  });
});

test("ORB-005: SQL errors are sanitized and never disclose provider/database details", async () => {
  await withCi(async()=>{
    const session=randomBytes(32).toString("base64url");
    const gateway={
      async sessionTenant(){return "org-ci-only";},
      async enqueue(){throw new Error("private-database-hostname-db.internal.invalid");},
    };
    const harness=createPostgresSyntheticHttpHarness({gateway});
    try{
      const base=await harness.start();
      const {csrfToken}=await(await fetch(base+"/__ci/pg/session/csrf",{
        headers:{cookie:"orbicore_session="+session},
      })).json();
      const response=await fetch(base+"/__ci/pg/jobs/refresh",{
        method:"POST",
        headers:{cookie:"orbicore_session="+session,
          origin:base,"x-orbicore-csrf":csrfToken,
          "idempotency-key":"ci","content-type":"application/json"},
        body:JSON.stringify({accountId:"account-ci"}),
      });
      assert.equal(response.status,503);
      const raw=await response.text();
      assert.equal(raw.includes("db.internal.invalid"),false);
      assert.deepEqual(JSON.parse(raw),{error:"postgres_fixture_unavailable"});
    }finally{await harness.close();}
  });
});
