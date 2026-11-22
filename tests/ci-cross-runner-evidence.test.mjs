import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  createCiCrossRunnerEvidence, verifyCiCrossRunnerEvidence,
  restoreCiCrossRunnerMetadata,
} from "../apps/api/ci-cross-runner-evidence.mjs";

function fixture(){
 const org="ci-test-org-a",owner="ci-test-owner-a",user="ci-test-user-a";
 const ev={
  organization_id:org,user_id:user,source_epoch:2,
  event_id:randomBytes(32).toString("hex"),
  origin_key_id:"ci_mac_k1",
  origin_mac:randomBytes(32).toString("hex"),
  actor_id:owner,reason:"password_reset",
 };
 const {reason,...witness}=ev;
 return {
  sourceUsers:[{organization_id:org,user_id:user,epoch:2}],
  sourceEvents:[ev],witnessRows:[witness],
 };
}
function withGate(fn){
 const keys={
  GITHUB_ACTIONS:process.env.GITHUB_ACTIONS,
  ORBICORE_CI_SYNTHETIC_CROSS_RUNNER:
   process.env.ORBICORE_CI_SYNTHETIC_CROSS_RUNNER,
 };
 try{
  process.env.GITHUB_ACTIONS="true";
  process.env.ORBICORE_CI_SYNTHETIC_CROSS_RUNNER="1";
  return fn();
 }finally{
  for(const [k,v] of Object.entries(keys)){
   if(v===undefined)delete process.env[k];else process.env[k]=v;
  }
 }
}
test("ORB-005 cross-runner evidence exporter and restore have isolated CI gate",()=>{
 const previous={
  GITHUB_ACTIONS:process.env.GITHUB_ACTIONS,
  ORBICORE_CI_SYNTHETIC_CROSS_RUNNER:
   process.env.ORBICORE_CI_SYNTHETIC_CROSS_RUNNER,
 };
 try{
  delete process.env.GITHUB_ACTIONS;
  process.env.ORBICORE_CI_SYNTHETIC_CROSS_RUNNER="1";
  assert.throws(()=>createCiCrossRunnerEvidence({snapshot:fixture()}),
   /ci_cross_runner_evidence_explicit_gate_required/);
  assert.throws(()=>verifyCiCrossRunnerEvidence({}),
   /ci_cross_runner_evidence_explicit_gate_required/);
  assert.throws(()=>restoreCiCrossRunnerMetadata({}),
   /ci_cross_runner_evidence_explicit_gate_required/);
 }finally{
  for(const [k,v] of Object.entries(previous)){
   if(v===undefined)delete process.env[k];else process.env[k]=v;
  }
 }
});

test("ORB-005 synthetic metadata-only export and atomic restore",()=>{
 withGate(()=>{
  const original=createCiCrossRunnerEvidence({
   sequence:7,snapshot:fixture(),
  });
  const params={
   envelope:original.envelope,
   publicKeySha256:original.publicKeySha256,
   envelopeSha256:original.envelopeSha256,
   expectedSequence:7,minimumSequence:7,
  };
  assert.equal(verifyCiCrossRunnerEvidence(params),true);
  const swapped=structuredClone(original.envelope);
  swapped.snapshot.sourceEvents[0].actor_id="ci-test-attacker";
  assert.equal(verifyCiCrossRunnerEvidence({
   ...params,envelope:swapped,
  }),false);
  const untrusted=structuredClone(original.envelope);
  untrusted.snapshot.sourceEvents[0].password_hash="must-deny";
  assert.equal(verifyCiCrossRunnerEvidence({
   ...params,envelope:untrusted,
  }),false);
  assert.equal(verifyCiCrossRunnerEvidence({
   ...params,expectedSequence:8,
  }),false);
  assert.equal(verifyCiCrossRunnerEvidence({
   ...params,publicKeySha256:randomBytes(32).toString("hex"),
  }),false);
  const db=new DatabaseSync(":memory:");
  try{
   assert.throws(()=>restoreCiCrossRunnerMetadata({
    sqlite:db,...params,injectRollback:true,
   }),/ci_recovery_metadata_unavailable/);
   assert.equal(db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master "+
    "WHERE name LIKE 'ci_recovered_%'",
   ).get().n,0);
   assert.deepEqual(restoreCiCrossRunnerMetadata({
    sqlite:db,...params,
   }),{
    fixtureMetadataRecovered:true,users:1,sourceEvents:1,
    witnesses:1,productionLoginAuthorized:false,
   });
   assert.equal(db.prepare(
    "SELECT COUNT(*) AS n FROM ci_recovered_witnesses",
   ).get().n,1);
   assert.equal(db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE name='users'",
   ).get().n,0);
  }finally{db.close()}
 });
});

test("ORB-005 archive completeness denies gaps, duplicates, orphan witness",()=>{
 withGate(()=>{
  const f=fixture();
  assert.throws(()=>createCiCrossRunnerEvidence({
   snapshot:{...f,sourceEvents:[]},
  }),/ci_evidence_snapshot_invalid/);
  assert.throws(()=>createCiCrossRunnerEvidence({
   snapshot:{...f,sourceUsers:[...f.sourceUsers,{
    ...f.sourceUsers[0],epoch:3,
   }]},
  }),/ci_evidence_duplicate_user/);
  assert.throws(()=>createCiCrossRunnerEvidence({
   snapshot:{...f,sourceUsers:[{...f.sourceUsers[0],epoch:3}]},
  }),/ci_evidence_epoch_gap/);
  assert.throws(()=>createCiCrossRunnerEvidence({
   snapshot:{...f,witnessRows:[
    {...f.witnessRows[0],event_id:randomBytes(32).toString("hex"),
   ]},
  }),/ci_evidence_witness_mismatch/);
 });
});
