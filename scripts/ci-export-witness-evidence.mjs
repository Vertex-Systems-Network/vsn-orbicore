import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createCiCrossRunnerEvidence,verifyCiCrossRunnerEvidence,
} from "../apps/api/ci-cross-runner-evidence.mjs";
if(process.env.GITHUB_ACTIONS!=="true"||
   process.env.ORBICORE_CI_SYNTHETIC_CROSS_RUNNER!=="1"||
   !process.env.GITHUB_OUTPUT)
 throw new Error("ci_cross_runner_export_hosted_only");
const id=()=>"ci-"+randomBytes(7).toString("hex");
const event=()=>randomBytes(32).toString("hex");
const orgA=id(),orgB=id(),a=id(),b=id(),c=id(),actorA=id(),actorB=id();
const sourceUsers=[
 {organization_id:orgA,user_id:a,epoch:3},
 {organization_id:orgA,user_id:b,epoch:2},
 {organization_id:orgB,user_id:c,epoch:1},
];
const ev=(org,user,epoch,actor,reason)=>({
 organization_id:org,user_id:user,source_epoch:epoch,
 event_id:event(),origin_key_id:"ci_fixture_mac",
 origin_mac:event(),actor_id:actor,reason,
});
const sourceEvents=[
 ev(orgA,a,2,actorA,"password_reset"),
 ev(orgA,a,3,actorA,"disabled"),
 ev(orgA,b,2,actorB,"mfa_enrolled"),
];
const witnessRows=sourceEvents.map((e)=>({
 organization_id:e.organization_id,user_id:e.user_id,
 source_epoch:e.source_epoch,event_id:e.event_id,
 origin_key_id:e.origin_key_id,origin_mac:e.origin_mac,
 actor_id:e.actor_id,
}));
const made=createCiCrossRunnerEvidence({
 sequence:7,snapshot:{sourceUsers,sourceEvents,witnessRows},
});
const outputPath=join(".data","ci","cross-runner","evidence.json");
mkdirSync(dirname(outputPath),{recursive:true});
writeFileSync(outputPath,JSON.stringify(made.envelope)+"\n",{
 flag:"wx",mode:0o600,
});
assert.equal(verifyCiCrossRunnerEvidence({
 envelope:made.envelope,
 publicKeySha256:made.publicKeySha256,
 envelopeSha256:made.envelopeSha256,
 minimumSequence:7,expectedSequence:7,
}),true);
// Job outputs contain ONLY public fingerprint, file checksum and sequence.
// They travel separately from the artifact to a clean second CI runner.
appendFileSync(process.env.GITHUB_OUTPUT,
 "public_key_fingerprint="+made.publicKeySha256+"\n"+
 "envelope_sha256="+made.envelopeSha256+"\n"+
 "sequence="+made.sequence+"\n",
);
process.stdout.write(JSON.stringify({
 check:"orb-005-cross-runner-export",
 sourceFixturesOnly:true,sourceAccounts:sourceUsers.length,
 witnessedEvents:sourceEvents.length,
 privateSigningKeyExported:false,containsPasswordOrVerifier:false,
 publicFingerprintViaJobOutput:true,productionLoginAuthorized:false,
})+"\n");
