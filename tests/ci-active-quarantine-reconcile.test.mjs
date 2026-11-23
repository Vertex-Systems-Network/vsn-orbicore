import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { validateSyntheticActiveJobQuarantine } from "../apps/api/ci-active-job-quarantine.mjs";
import {
  signSyntheticQuarantineWitness, assertSyntheticQuarantineWitness,
  createSyntheticActiveQuarantineWitness, reconcileSyntheticActiveQuarantine,
} from "../apps/api/ci-active-quarantine-reconcile.mjs";

const now="2026-11-23T10:00:00.000Z";
const fixture=()=>({
  accounts:[{id:"acc-ci",organization_id:"org-ci",source:"mock_fixture"}],
  users:[{id:"user-ci",organization_id:"org-ci",email:"ci@test.example.invalid",role:"operator",disabled:0}],
  secretReferences:[],
  jobs:[{id:"job-ci",organization_id:"org-ci",account_id:"acc-ci",requested_by:"user-ci",
    type:"inventory_refresh",status:"queued",idempotency_key:"org-ci:ci-queue-reconcile",
    created_at:now,started_at:null,completed_at:null,result_json:null,error:null}],
});

test("ORB-004/016 detached witness covers validated synthetic source, without plaintext payloads",()=>{
  const rows=validateSyntheticActiveJobQuarantine(fixture());
  const key=randomBytes(32),nonce="a".repeat(32);
  const a=signSyntheticQuarantineWitness(rows,key,nonce);
  const b=signSyntheticQuarantineWitness([...rows].reverse(),key,nonce);
  assert.deepEqual(a,b);
  assert.equal(assertSyntheticQuarantineWitness(a,key),true);
  assert.deepEqual(Object.keys(a),["version","scope","nonce","count","digest","mac"]);
  assert.equal(a.digest.length,64);
  assert.equal(JSON.stringify(a).includes("acc-ci"),false);
  assert.equal(JSON.stringify(a).includes("org-ci"),false);
});

test("ORB-004/016 witness fails closed on foreign signer, changed fields, invalid MAC and keys",()=>{
  const rows=validateSyntheticActiveJobQuarantine(fixture()),key=randomBytes(32);
  const witness=signSyntheticQuarantineWitness(rows,key,"b".repeat(32));
  assert.throws(()=>assertSyntheticQuarantineWitness(witness,randomBytes(32)),/mac_mismatch/);
  for(const changed of [
    {...witness,count:2}, {...witness,nonce:"c".repeat(32)},
    {...witness,digest:"f".repeat(64)}, {...witness,mac:"0".repeat(64)},
  ]) assert.throws(()=>assertSyntheticQuarantineWitness(changed,key),/mac_mismatch/);
  for(const malformed of [
    {...witness,scope:"live"}, {...witness,extra:"data"},
    {...witness,count:0}, {...witness,version:2},
    {...witness,nonce:"a"}, {...witness,mac:"Z".repeat(64)},null,
  ]) assert.throws(()=>assertSyntheticQuarantineWitness(malformed,key),/witness_invalid/);
  assert.throws(()=>signSyntheticQuarantineWitness(rows,Buffer.from("short")),/key_32_bytes/);
  assert.throws(()=>signSyntheticQuarantineWitness(rows,key,"invalid"),/nonce_invalid/);
});

test("ORB-004/016 witness signing and reconciliation never access source or PG without CI gate",async()=>{
  const fail={exec(){throw Error("sqlite-should-not-be-read");},
    prepare(){throw Error("sqlite-should-not-be-read");}};
  const pg={connect(){throw Error("postgres-should-not-be-read");}};
  const key=randomBytes(32);
  assert.throws(()=>createSyntheticActiveQuarantineWitness({
    sqlite:fail,key,consent:"ci_fixture_active_jobs_quarantine_no_replay",
  }),/ci_active_quarantine_explicit_gate_required/);
  await assert.rejects(reconcileSyntheticActiveQuarantine({
    sqlite:fail,postgres:pg,witness:{},key,
    consent:"ci_fixture_active_jobs_quarantine_no_replay",
  }),/ci_active_quarantine_explicit_gate_required/);
});
