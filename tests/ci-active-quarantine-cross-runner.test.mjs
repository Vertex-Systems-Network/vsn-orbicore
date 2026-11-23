import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  createCiActiveQuarantineAttestation,
  verifyCiActiveQuarantineAttestation,
} from "../apps/api/ci-active-quarantine-cross-runner.mjs";

const t0="2026-11-23T10:00:00.000Z",t1="2026-11-23T10:01:00.000Z";
const rows = () => {
  const data=[
    {id:"ci-a",organizationId:"org-ci-a",accountId:"acc-ci-a",requestedBy:"user-ci-a",
     status:"queued",idempotencyKey:"org-ci-a:ci-queue-a",createdAt:t0,startedAt:null},
    {id:"ci-b",organizationId:"org-ci-b",accountId:"acc-ci-b",requestedBy:"user-ci-b",
     status:"running",idempotencyKey:"org-ci-b:ci-queue-b",createdAt:t0,startedAt:t1},
  ];
  return data.map(x=>({...x,digest:createHash("sha256").update(JSON.stringify(x)).digest("hex")}));
};
const make=()=>createCiActiveQuarantineAttestation({
  rows:rows(),runId:"45162001819",headSha:"a".repeat(40),
  nonce:"b".repeat(32),consent:"ci_fixture_active_jobs_quarantine_no_replay",
});
const check=(a,override={})=>verifyCiActiveQuarantineAttestation({
  envelope:a.envelope,publicKeySha256:a.publicKeySha256,
  envelopeSha256:a.envelopeSha256,expectedRunId:"45162001819",
  expectedHeadSha:"a".repeat(40),expectedSequence:1,expectedCount:2,...override,
});

test("ORB-004/016 independent Ed25519 runner witness contains signed metadata only, not credentials",()=>{
 const a=make();
 assert.equal(check(a),true);
 assert.equal(a.sequence,1);assert.equal(a.count,2);
 const encoded=JSON.stringify(a.envelope);
 for(const bad of ["password","privateKey","token_hash","result_json","apiToken","email","secret_references"]) {
   assert.equal(encoded.includes(bad),false);
 }
 assert.equal(a.publicKeySha256.length,64);
 assert.equal(a.envelopeSha256.length,64);
});
test("ORB-004/016 detached runner rejects modified row and recomputed untrusted digest",()=>{
 const a=make();
 const mutations=[
   x=>{x.rows[0].status="running";x.rows[0].startedAt=t1;},
   x=>{x.rows[0].accountId="forged-ci-account";x.rows[0].digest=createHash("sha256").update(JSON.stringify({
     id:x.rows[0].id,organizationId:x.rows[0].organizationId,accountId:x.rows[0].accountId,
     requestedBy:x.rows[0].requestedBy,status:x.rows[0].status,idempotencyKey:x.rows[0].idempotencyKey,
     createdAt:x.rows[0].createdAt,startedAt:x.rows[0].startedAt,
   })).digest("hex");},
   x=>{x.rows[0].password_hash="forbidden";},
   x=>{x.rows[1].id=x.rows[0].id;},
   x=>{x.rows.reverse();},
   x=>{x.rows.pop();},
   x=>{x.signature=randomBytes(64).toString("base64url");},
   x=>{x.publicKeySpki=randomBytes(50).toString("base64url");},
   x=>{x.runId="42";},
   x=>{x.headSha="c".repeat(40);},
   x=>{x.scope="production";},
 ];
 for(const mutate of mutations) {
   const b=structuredClone(a.envelope);mutate(b);
   assert.equal(check(a,{envelope:b}),false);
 }
 for(const overrides of [
   {expectedRunId:"42"},{expectedHeadSha:"c".repeat(40)},
   {expectedCount:1},{expectedSequence:2},
   {publicKeySha256:randomBytes(32).toString("hex")},
   {envelopeSha256:randomBytes(32).toString("hex")},
 ]) assert.equal(check(a,overrides),false);
});
test("ORB-004/016 signer fails closed on unsafe or noncanonical rows and incorrect consent",()=>{
 const config={runId:"45162001819",headSha:"a".repeat(40),
   nonce:"b".repeat(32),consent:"ci_fixture_active_jobs_quarantine_no_replay"};
 assert.throws(()=>createCiActiveQuarantineAttestation({...config,rows:rows().reverse()}),/noncanonical_order/);
 assert.throws(()=>createCiActiveQuarantineAttestation({...config,rows:rows(),consent:null}),/scope_invalid/);
 assert.throws(()=>createCiActiveQuarantineAttestation({...config,rows:rows(),headSha:"bad"}),/scope_invalid/);
 const changed=rows();changed[0].digest="0".repeat(64);
 assert.throws(()=>createCiActiveQuarantineAttestation({...config,rows:changed}),/digest_invalid/);
 const extra=rows();extra[0].result_json='{"apiToken":"unsafe"}';
 assert.throws(()=>createCiActiveQuarantineAttestation({...config,rows:extra}),/rows_invalid/);
});
