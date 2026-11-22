import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createPostgresCiLoginAdapter } from "../apps/api/postgres-ci-login.mjs";

async function ci(fn){
  const old={github:process.env.GITHUB_ACTIONS,flag:process.env.ORBICORE_CI_SYNTHETIC_PG_LOGIN};
  process.env.GITHUB_ACTIONS="true";
  process.env.ORBICORE_CI_SYNTHETIC_PG_LOGIN="1";
  try { return await fn(); }
  finally {
    if(old.github===undefined)delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS=old.github;
    if(old.flag===undefined)delete process.env.ORBICORE_CI_SYNTHETIC_PG_LOGIN;
    else process.env.ORBICORE_CI_SYNTHETIC_PG_LOGIN=old.flag;
  }
}
function mocked(response={accepted:true,needs_mfa:false,tenant_id:"org-ci",rate_limited:false}){
  const commands=[];
  let released=0;
  const pool={
    async connect(){
      return {
        async query(sql,args){
          commands.push({sql,args});
          if(sql.includes("orbi_fixture_never_run"))throw Error("intentional");
          if(sql.includes("orbi_fail_guard"))throw Error("failed-fixture-query");
          if(sql.includes("orbicore_ci_password_login"))return {rows:[response]};
          if(sql.includes("orbicore_ci_finish_recovery_mfa"))return {rows:[{accepted:true}]};
          if(sql.includes("orbicore_ci_revoke_session"))return {rows:[{revoked:true}]};
          return {rows:[]};
        },
        release(){released++;},
      };
    },
  };
  return {pool,commands,get released(){return released;}};
}
const sha=x=>createHash("sha256").update(x).digest("hex");

test("ORB-005: CI login adapter rejects runtime activation and needs a pool",async()=>{
  await ci(async()=>{
    delete process.env.ORBICORE_CI_SYNTHETIC_PG_LOGIN;
    assert.throws(()=>createPostgresCiLoginAdapter({connect(){}}),/ci_only/);
    process.env.ORBICORE_CI_SYNTHETIC_PG_LOGIN="1";
    assert.throws(()=>createPostgresCiLoginAdapter({}),/PostgreSQL pool/);
  });
});
test("ORB-005: login issues only a random session token, never selects password hashes",async()=>{
  await ci(async()=>{
    const m=mocked();
    const api=createPostgresCiLoginAdapter(m.pool);
    const response=await api.login({
      email:"CI-Owner@example.test",password:"generated-runtime-password-32",
    });
    assert.equal(response.accepted,true);
    assert.equal(response.mfaRequired,false);
    assert.equal(response.tenantId,"org-ci");
    assert.match(response.token,/^[A-Za-z0-9_-]{32,}$/);
    assert.deepEqual(m.commands.map(x=>x.sql),[
      "BEGIN","SET LOCAL ROLE orbicore_synthetic_submitter",
      "SELECT accepted, needs_mfa, tenant_id, rate_limited " +
        "FROM public.orbicore_ci_password_login($1,$2,$3)",
      "COMMIT",
    ]);
    assert.equal(m.commands[2].args[0],"ci-owner@example.test");
    assert.equal(m.commands[2].args[2],sha(response.token));
    assert.equal(m.released,1);
  });
});
test("ORB-005: bad inputs are rejected without opening the database",async()=>{
  await ci(async()=>{
    let connects=0;
    const api=createPostgresCiLoginAdapter({
      async connect(){connects++;throw new Error("unexpected connection");},
    });
    for(const payload of [
      {email:"bad",password:"long-enough"},
      {email:"ok@example.test",password:"short"},
      {email:"ok@example.test",password:"x".repeat(129)},
    ]){
      assert.equal((await api.login(payload)).accepted,false);
    }
    assert.equal((await api.finishRecoveryMfa({token:"short",code:"not-a-code"})).accepted,false);
    assert.equal(await api.revoke({token:"short"}),false);
    assert.equal(connects,0);
  });
});
test("ORB-005: recovery token rotates, consumes code hash and logout revokes",async()=>{
  await ci(async()=>{
    const m=mocked();
    const api=createPostgresCiLoginAdapter(m.pool);
    const oldToken="A".repeat(43);
    const code="ABCD1234EFGH5678";
    const recovery=await api.finishRecoveryMfa({token:oldToken,code});
    assert.equal(recovery.accepted,true);
    assert.notEqual(recovery.token,oldToken);
    assert.equal(m.commands[2].args[0],sha(oldToken));
    assert.equal(m.commands[2].args[1],sha(recovery.token));
    assert.equal(m.commands[2].args[2],sha(code));
    assert.equal(await api.revoke({token:recovery.token}),true);
    assert.equal(m.commands[6].args[0],sha(recovery.token));
    assert.equal(m.released,2);
  });
});
test("ORB-005: invalid credential response does not produce a session token",async()=>{
  await ci(async()=>{
    const m=mocked({accepted:false,needs_mfa:false,tenant_id:null,rate_limited:true});
    const api=createPostgresCiLoginAdapter(m.pool);
    const out=await api.login({email:"user@example.test",password:"wrong-not-accepted"});
    assert.deepEqual(out,{accepted:false,rateLimited:true});
    assert.equal(Object.hasOwn(out,"token"),false);
  });
});
