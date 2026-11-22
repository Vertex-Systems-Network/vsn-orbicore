import assert from "node:assert/strict";
import { test } from "node:test";
import { createCiScopedSignalRecorder } from "../apps/api/ci-scoped-signal-recorder.mjs";
test("ORB-004 restricted recorder has strict CI gate",()=>{
 const old=process.env.GITHUB_ACTIONS;
 try{
  delete process.env.GITHUB_ACTIONS;
  assert.throws(()=>createCiScopedSignalRecorder({database:{query(){}}}),
   /ci_signal_scope_explicit_gate_required/);
 }finally{
  if(old===undefined)delete process.env.GITHUB_ACTIONS;
  else process.env.GITHUB_ACTIONS=old;
 }
});
test("ORB-004 bounded functions never accept raw redis fields",async()=>{
 const old={GITHUB_ACTIONS:process.env.GITHUB_ACTIONS,
  ORBICORE_CI_SYNTHETIC_SIGNAL_SCOPE:process.env.ORBICORE_CI_SYNTHETIC_SIGNAL_SCOPE};
 try{
  process.env.GITHUB_ACTIONS="true";
  process.env.ORBICORE_CI_SYNTHETIC_SIGNAL_SCOPE="1";
  const queries=[];
  const recorder=createCiScopedSignalRecorder({
   database:{async query(sql,params){queries.push({sql,params});return{
    rows:sql.includes(" AS accepted")?[{accepted:true}]:[],
   };}},
  });
  await recorder.record({
   organizationId:"ci-tenant",redisId:"1234-0",
   reason:"missing_job",workerId:"ci-worker",
  });
  assert.equal((await recorder.inspect({organizationId:"ci-tenant"})).length,0);
  assert.equal(queries.length,2);
  assert.equal(queries[0].params.length,4);
  assert.ok(queries[0].sql.includes("$4"));
  assert.equal(queries[0].sql.includes("ci-tenant"),false);
  await assert.rejects(recorder.record({
   organizationId:"ci-tenant",redisId:"1234-0",
   reason:"bad_reason",workerId:"ci-worker",
  }),/invalid_metadata/);
  await assert.rejects(recorder.record({
   organizationId:"ci-tenant",redisId:"../payload",
   reason:"missing_job",workerId:"ci-worker",
  }),/invalid_metadata/);
  await assert.rejects(recorder.inspect({
   organizationId:"ci-tenant",limit:0,
  }),/invalid_metadata/);
 }finally{
  for(const [k,v] of Object.entries(old)){
   if(v===undefined)delete process.env[k];
   else process.env[k]=v;
  }
 }
});
