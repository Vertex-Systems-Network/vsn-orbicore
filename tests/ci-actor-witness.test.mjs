import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { verifyCiMutationActor } from
 "../apps/api/ci-source-mutation-authorization.mjs";
import { createCiSourceWitness } from "../apps/api/ci-source-witness.mjs";
import { createCiSourceEventAttestor } from
 "../apps/api/ci-source-event-attestation.mjs";

test("ORB-005 actor authorization and witness cannot run in HTTP env",()=>{
 const old={
  GITHUB_ACTIONS:process.env.GITHUB_ACTIONS,
  ORBICORE_CI_SYNTHETIC_ACTOR_AUTH:
   process.env.ORBICORE_CI_SYNTHETIC_ACTOR_AUTH,
  ORBICORE_CI_SYNTHETIC_WITNESS:
   process.env.ORBICORE_CI_SYNTHETIC_WITNESS,
 };
 try{
  delete process.env.GITHUB_ACTIONS;
  process.env.ORBICORE_CI_SYNTHETIC_ACTOR_AUTH="1";
  process.env.ORBICORE_CI_SYNTHETIC_WITNESS="1";
  assert.throws(()=>verifyCiMutationActor(),
   /ci_mutation_actor_gate_required/);
  assert.throws(()=>createCiSourceWitness(),
   /ci_source_witness_explicit_gate_required/);
 }finally{
  for(const [k,v] of Object.entries(old)){
   if(v===undefined)delete process.env[k];else process.env[k]=v;
  }
 }
});

test("ORB-005 v2 event MAC binds authorized synthetic actor; v1 stays distinct",()=>{
 const old={
  GITHUB_ACTIONS:process.env.GITHUB_ACTIONS,
  ORBICORE_CI_SYNTHETIC_REAUTH:
   process.env.ORBICORE_CI_SYNTHETIC_REAUTH,
  ORBICORE_CI_SYNTHETIC_RECONCILE:
   process.env.ORBICORE_CI_SYNTHETIC_RECONCILE,
  ORBICORE_CI_SYNTHETIC_EVENT_ATTESTATION:
   process.env.ORBICORE_CI_SYNTHETIC_EVENT_ATTESTATION,
 };
 try{
  for(const k of Object.keys(old))
   process.env[k]=k==="GITHUB_ACTIONS"?"true":"1";
  const attestor=createCiSourceEventAttestor({
   activeKey:{id:"test_k1",bytes:randomBytes(32)},
  });
  const event={
   event_id:randomBytes(32).toString("hex"),
   organization_id:"org-a",user_id:"user-a",source_epoch:2,
   reason:"disabled",actor_id:"owner-a",
  };
  const s=attestor.sign(event);
  const row={...event,origin_key_id:s.originKeyId,origin_mac:s.originMac};
  assert.equal(attestor.verify(row),true);
  assert.equal(attestor.verify({...row,actor_id:"owner-b"}),false);
  assert.equal(attestor.verify({...row,actor_id:null}),false);
  const v1={...event};
  delete v1.actor_id;
  const legacy=attestor.sign(v1);
  assert.notEqual(s.originMac,legacy.originMac);
  assert.equal(attestor.verify({
   ...v1,origin_key_id:legacy.originKeyId,origin_mac:legacy.originMac,
  }),true);
 }finally{
  for(const [k,v] of Object.entries(old)){
   if(v===undefined)delete process.env[k];else process.env[k]=v;
  }
 }
});
