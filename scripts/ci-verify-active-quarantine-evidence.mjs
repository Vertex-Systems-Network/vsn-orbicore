import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { verifyCiActiveQuarantineAttestation } from "../apps/api/ci-active-quarantine-cross-runner.mjs";

if (process.env.GITHUB_ACTIONS !== "true" ||
    process.env.ORBICORE_CI_ACTIVE_QUARANTINE !== "1" ||
    !process.env.EXPECTED_PUBLIC_KEY_SHA256 ||
    !process.env.EXPECTED_ENVELOPE_SHA256 ||
    !process.env.GITHUB_RUN_ID || !process.env.GITHUB_SHA) {
  throw new Error("ci_quarantine_independent_runner_only");
}
const path=".data/ci/active-quarantine-cross-runner/evidence.json";
const raw=readFileSync(path,"utf8");
const envelope=JSON.parse(raw);
assert.equal(raw,JSON.stringify(envelope)+"\n","signed artifact must be exact canonical JSON");
const trusted={
  publicKeySha256:process.env.EXPECTED_PUBLIC_KEY_SHA256,
  envelopeSha256:process.env.EXPECTED_ENVELOPE_SHA256,
  expectedRunId:process.env.GITHUB_RUN_ID,
  expectedHeadSha:process.env.GITHUB_SHA,
  expectedSequence:Number(process.env.EXPECTED_SEQUENCE),
  expectedCount:Number(process.env.EXPECTED_QUARANTINED_COUNT),
};
const check=(value=envelope,overrides={})=>
  verifyCiActiveQuarantineAttestation({envelope:value,...trusted,...overrides});
assert.equal(check(),true,"fresh CI runner must verify the producer's genuine signature");
assert.equal(envelope.rows.length,2);
const changed=structuredClone(envelope);
changed.rows[0].status="running";
changed.rows[0].startedAt="2026-11-23T10:01:00.000Z";
assert.equal(check(changed),false,"tampered status must fail");
const rehashed=structuredClone(envelope);
rehashed.rows[0].accountId="ci-replaced-account";
const row=rehashed.rows[0];
rehashed.rows[0].digest=createHash("sha256").update(JSON.stringify({
  id:row.id,organizationId:row.organizationId,accountId:row.accountId,
  requestedBy:row.requestedBy,status:row.status,
  idempotencyKey:row.idempotencyKey,createdAt:row.createdAt,startedAt:row.startedAt,
})).digest("hex");
assert.equal(check(rehashed),false,"recomputed row hash cannot forge the detached signature");
const dropped=structuredClone(envelope);
dropped.rows.pop();
assert.equal(check(dropped),false);
const duplicate=structuredClone(envelope);
duplicate.rows.push(duplicate.rows[0]);
assert.equal(check(duplicate),false);
const newSigner=structuredClone(envelope);
newSigner.publicKeySpki=randomBytes(44).toString("base64url");
assert.equal(check(newSigner),false);
const corrupted=structuredClone(envelope);
corrupted.signature=randomBytes(64).toString("base64url");
assert.equal(check(corrupted),false);
const extraneous=structuredClone(envelope);
extraneous.rows[0].access_token="forbidden";
assert.equal(check(extraneous),false);
assert.equal(check(envelope,{publicKeySha256:randomBytes(32).toString("hex")}),false);
assert.equal(check(envelope,{envelopeSha256:randomBytes(32).toString("hex")}),false);
assert.equal(check(envelope,{expectedRunId:"1"}),false);
assert.equal(check(envelope,{expectedHeadSha:"0".repeat(40)}),false);
assert.equal(check(envelope,{expectedSequence:2}),false);
assert.equal(check(envelope,{expectedCount:1}),false);
for (const word of ["password_hash","password_salt","apiToken","privateKey",
  "secret_references","result_json","access_token","recovery_code","email"]) {
  assert.equal(raw.includes(word),false,"artifact must never include "+word);
}
console.log(JSON.stringify({
  tasks:["ORB-004","ORB-005","ORB-016","ORB-017"],
  mode:"ci_only_independent_quarantine_ed25519",
  separateRunner:true,detachedArtifactVerified:true,publicKeyPinViaJobOutput:true,
  artifactHashPinViaJobOutput:true,
  headShaAndWorkflowRunIdBound:true,signedRows:envelope.rows.length,
  corruptedAndRehashedRowDenied:true,wrongSignerAndRunDenied:true,
  privateSignerExported:false,containsProductionCredentials:false,
  sqliteOrPostgresRestoredInSecondRunner:false,
  executableJobs:0,jobOutboxWrites:0,redisReplays:0,liveProviderCalls:0,
  productionKeyCustody:false,productionCutover:false,
}));
