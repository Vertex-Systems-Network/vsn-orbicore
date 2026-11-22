import assert from "node:assert/strict";
import { randomBytes,randomUUID } from "node:crypto";
import {test} from "node:test";
import {createCiWakeupAttestor} from "../apps/api/ci-wakeup-attestation.mjs";
const id=()=>randomUUID();
const fixture=()=>({organizationId:"ci-tenant-a",jobId:"ci-job-123",outboxId:id()});
const gate=async fn=>{
 const vars={
  GITHUB_ACTIONS:process.env.GITHUB_ACTIONS,
  ORBICORE_CI_SYNTHETIC_SIGNED_WAKEUP:process.env.ORBICORE_CI_SYNTHETIC_SIGNED_WAKEUP,
 };
 try{
  process.env.GITHUB_ACTIONS="true";
  process.env.ORBICORE_CI_SYNTHETIC_SIGNED_WAKEUP="1";
  return await fn();
 }finally{
  for(const [k,v] of Object.entries(vars)){
   if(v===undefined)delete process.env[k];else process.env[k]=v;
  }
 }
};
test("ORB-004 CI-only wakeup signatures cannot be used without explicit gate",()=>{
 const previous=process.env.GITHUB_ACTIONS;
 try{
  delete process.env.GITHUB_ACTIONS;
  assert.throws(()=>createCiWakeupAttestor({
    active:{id:"ci_key_1",key:randomBytes(32)},
  }),/ci_wakeup_signature_fixture_gate_required/);
 }finally{
  if(previous===undefined)delete process.env.GITHUB_ACTIONS;
  else process.env.GITHUB_ACTIONS=previous;
 }
});
test("ORB-004 HMAC exact fields, replay envelope and rotation fail closed",async()=>{
 await gate(()=>{
  const key1={id:"ci_key_1",key:randomBytes(32)};
  const key2={id:"ci_key_2",key:randomBytes(32)};
  const first=createCiWakeupAttestor({active:key1});
  const values=fixture();
  const sign=first.sign(values);
  const fields={
    organization_id:values.organizationId,
    job_id:values.jobId,outbox_id:values.outboxId,
    ...sign,
  };
  assert.equal(first.verify({fields}),true);
  for(const [key,value] of [
    ["organization_id","ci-tenant-b"],
    ["job_id","ci-other-job"],
    ["outbox_id",id()],
    ["origin_key_id","ci_unknown_key"],
    ["origin_mac",randomBytes(32).toString("hex")],
  ])assert.equal(first.verify({fields:{...fields,[key]:value}}),false);
  assert.equal(first.verify({fields:{...fields,extra:"untrusted"}}),false);
  assert.equal(first.verify({fields:{...fields,__duplicate_wire_fields__:"1"}}),false);
  assert.equal(first.verify({fields:null}),false);
  assert.equal(first.verify({fields:{...fields,origin_mac:"BAD"}}),false);
  assert.equal(createCiWakeupAttestor({
    active:key2,previous:[key1],
  }).verify({fields}),true);
  assert.equal(createCiWakeupAttestor({
    active:key2,
  }).verify({fields}),false);
  assert.throws(()=>createCiWakeupAttestor({
    active:key1,previous:[key1],
  }),/ci_wakeup_duplicate_key_id/);
  assert.throws(()=>createCiWakeupAttestor({
    active:{id:"ci_short",key:randomBytes(8)},
  }),/ci_wakeup_key_invalid/);
  assert.throws(()=>first.sign({...values,outboxId:"1-0"}),
    /ci_wakeup_identity_invalid/);
 });
});
