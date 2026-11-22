import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { createCiDetachedWitnessSigner } from
 "../apps/api/ci-detached-witness-checkpoint.mjs";
import { inspectCiShadowEvidenceReadiness } from
 "../apps/api/ci-shadow-readiness-probe.mjs";

test("ORB-005 detached checkpoint and readiness refuse normal runtime",()=>{
 const prior={
  GITHUB_ACTIONS:process.env.GITHUB_ACTIONS,
  ORBICORE_CI_SYNTHETIC_DETACHED_CHECKPOINT:
   process.env.ORBICORE_CI_SYNTHETIC_DETACHED_CHECKPOINT,
  ORBICORE_CI_SYNTHETIC_WITNESS:
   process.env.ORBICORE_CI_SYNTHETIC_WITNESS,
  ORBICORE_CI_SYNTHETIC_EVENT_ATTESTATION:
   process.env.ORBICORE_CI_SYNTHETIC_EVENT_ATTESTATION,
 };
 try{
  delete process.env.GITHUB_ACTIONS;
  for(const k of Object.keys(prior)){
   if(k!=="GITHUB_ACTIONS")process.env[k]="1";
  }
  assert.throws(()=>createCiDetachedWitnessSigner(),
   /ci_detached_witness_explicit_gate_required/);
  assert.throws(()=>inspectCiShadowEvidenceReadiness(),
   /ci_detached_witness_explicit_gate_required/);
  process.env.GITHUB_ACTIONS="true";
  assert.throws(()=>createCiDetachedWitnessSigner({
   activeKey:{id:"auditor_k1",bytes:Buffer.alloc(8)},
  }),/ci_detached_witness_keyring_invalid/);
  assert.throws(()=>createCiDetachedWitnessSigner({
   activeKey:{id:"auditor_k1",bytes:randomBytes(32)},
   previousKeys:[{id:"auditor_k1",bytes:randomBytes(32)}],
  }),/ci_detached_witness_keyring_invalid/);
  assert.deepEqual(inspectCiShadowEvidenceReadiness(),
   {fixtureConsistent:false,productionLoginAuthorized:false});
 }finally{
  for(const [k,v] of Object.entries(prior)){
   if(v===undefined)delete process.env[k];else process.env[k]=v;
  }
 }
});

test("ORB-005 checkpoint signature binds normalized witness row order",()=>{
 const prior={
  GITHUB_ACTIONS:process.env.GITHUB_ACTIONS,
  ORBICORE_CI_SYNTHETIC_DETACHED_CHECKPOINT:
   process.env.ORBICORE_CI_SYNTHETIC_DETACHED_CHECKPOINT,
  ORBICORE_CI_SYNTHETIC_WITNESS:
   process.env.ORBICORE_CI_SYNTHETIC_WITNESS,
  ORBICORE_CI_SYNTHETIC_EVENT_ATTESTATION:
   process.env.ORBICORE_CI_SYNTHETIC_EVENT_ATTESTATION,
 };
 try{
  for(const k of Object.keys(prior))
   process.env[k]=k==="GITHUB_ACTIONS"?"true":"1";
  const signer=createCiDetachedWitnessSigner({
   activeKey:{id:"auditor_k1",bytes:randomBytes(32)},
  });
  const rows=[
   {organization_id:"org-a",user_id:"user-a",source_epoch:"2",
    event_id:"a".repeat(64),origin_key_id:"source_k1",
    origin_mac:"b".repeat(64),actor_id:"user-b"},
   {organization_id:"org-a",user_id:"user-b",source_epoch:"2",
    event_id:"c".repeat(64),origin_key_id:"source_k1",
    origin_mac:"d".repeat(64),actor_id:"user-a"},
  ];
  const cp=signer.issue({witnessRows:rows,sequence:1});
  assert.equal(signer.verify({checkpoint:cp,witnessRows:rows.slice().reverse(),
   pinnedMac:cp.mac,minimumSequence:1}),true);
  assert.equal(signer.verify({checkpoint:cp,witnessRows:rows.slice(0,1),
   pinnedMac:cp.mac,minimumSequence:1}),false);
  assert.equal(signer.verify({checkpoint:cp,witnessRows:[
    {...rows[0],actor_id:"user-c"},rows[1],
   ],pinnedMac:cp.mac,minimumSequence:1}),false);
  assert.equal(signer.verify({checkpoint:cp,witnessRows:rows,
   pinnedMac:cp.mac,minimumSequence:2}),false);
  assert.throws(()=>signer.issue({sequence:2,witnessRows:[
   rows[0],{...rows[0],event_id:"e".repeat(64)},
  ]}),/ci_detached_witness_snapshot_invalid/);
 }finally{
  for(const [k,v] of Object.entries(prior)){
   if(v===undefined)delete process.env[k];else process.env[k]=v;
  }
 }
});
