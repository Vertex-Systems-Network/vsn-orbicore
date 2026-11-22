import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  verifyCiCrossRunnerEvidence,restoreCiCrossRunnerMetadata,
} from "../apps/api/ci-cross-runner-evidence.mjs";
if(process.env.GITHUB_ACTIONS!=="true"||
   process.env.ORBICORE_CI_SYNTHETIC_CROSS_RUNNER!=="1")
 throw new Error("ci_cross_runner_restore_hosted_only");
const trusted={
 publicKeySha256:process.env.EXPECTED_PUBLIC_KEY_SHA256,
 envelopeSha256:process.env.EXPECTED_ENVELOPE_SHA256,
 minimumSequence:Number(process.env.EXPECTED_SEQUENCE),
 expectedSequence:Number(process.env.EXPECTED_SEQUENCE),
};
const filename=".data/ci/cross-runner/evidence.json";
const envelope=JSON.parse(readFileSync(filename,"utf8"));
const check=(value,overrides={})=>verifyCiCrossRunnerEvidence({
 envelope:value,...trusted,...overrides,
});
assert.equal(check(envelope),true);
// All tampering is tested only on metadata; nothing is decrypted, no user
// verifier or real account exists in this independent CI runner.
const changed=structuredClone(envelope);
changed.snapshot.sourceEvents[0].reason="role_revoked";
assert.equal(check(changed),false);
const changedWitness=structuredClone(envelope);
changedWitness.snapshot.witnessRows[0].origin_mac=randomBytes(32).toString("hex");
assert.equal(check(changedWitness),false);
const deleted=structuredClone(envelope);
deleted.snapshot.sourceEvents.pop();
assert.equal(check(deleted),false);
const dup=structuredClone(envelope);
dup.snapshot.witnessRows.push(dup.snapshot.witnessRows[0]);
assert.equal(check(dup),false);
const unexpected=structuredClone(envelope);
unexpected.snapshot.sourceEvents[0].password_hash="must-not-be-accepted";
assert.equal(check(unexpected),false);
const wrongSignature=structuredClone(envelope);
wrongSignature.signature=randomBytes(64).toString("base64url");
assert.equal(check(wrongSignature),false);
assert.equal(check(envelope,{publicKeySha256:randomBytes(32).toString("hex")}),false);
assert.equal(check(envelope,{envelopeSha256:randomBytes(32).toString("hex")}),false);
assert.equal(check(envelope,{minimumSequence:8}),false);
assert.equal(check(envelope,{expectedSequence:8}),false);
// If attacker changes both artifact AND artifact-embedded public key,
// separate run-output pin still denies the substituted identity.
assert.equal(check({...envelope,publicKeySpki:randomBytes(50).toString("base64url")}),false);
const json=JSON.stringify(envelope);
for(const forbidden of ["password_hash","password_salt",
 "private_key","access_token","email","secret_ref","recovery_code"]){
 assert.equal(json.includes(forbidden),false);
}
let db=new DatabaseSync(":memory:");
try{
 // A deliberate failure must rollback schema AND event rows atomically.
 assert.throws(()=>restoreCiCrossRunnerMetadata({
  sqlite:db,envelope,...trusted,injectRollback:true,
 }),/ci_recovery_metadata_unavailable/);
 assert.equal(db.prepare(
  "SELECT count(*) AS n FROM sqlite_master "+
  "WHERE name LIKE 'ci_recovered_%'",
 ).get().n,0);
 const result=restoreCiCrossRunnerMetadata({
  sqlite:db,envelope,...trusted,
 });
 assert.deepEqual(result,{
  fixtureMetadataRecovered:true,
  users:3,sourceEvents:3,witnesses:3,
  productionLoginAuthorized:false,
 });
 assert.equal(db.prepare(
  "SELECT count(*) AS n FROM ci_recovered_events",
 ).get().n,3);
 assert.equal(db.prepare(
  "SELECT count(*) AS n FROM ci_recovered_witnesses",
 ).get().n,3);
 assert.equal(db.prepare(
  "SELECT count(*) AS n FROM ci_recovered_epochs WHERE epoch=1",
 ).get().n,1);
 assert.equal(db.prepare(
  "SELECT count(*) AS n FROM sqlite_master WHERE name='users'",
 ).get().n,0);
 assert.throws(()=>restoreCiCrossRunnerMetadata({
  sqlite:db,envelope:changed,...trusted,
 }),/ci_recovery_evidence_untrusted/);
 // Fresh db never inherits authentication authority; only audit metadata.
}finally{db.close()}
process.stdout.write(JSON.stringify({
 check:"orb-005-cross-runner-restore",
 freshRunner:true,publicKeyFingerprintPinChecked:true,
 detachedArtifactDigestChecked:true,ed25519SignatureVerified:true,
 corruptedAndMissingEpochEvidenceDenied:true,
 tamperedSignerOrSnapshotDenied:true,atomicRestoreRollback:true,
 metadataOnlyRecovery:true,productionDbBackupRestored:false,
 externalWormOrKeyCustody:false,productionLoginAuthorized:false,
})+"\n");
