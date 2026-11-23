import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  createCiActiveQuarantineAttestation,
} from "../apps/api/ci-active-quarantine-cross-runner.mjs";
import {
  evaluateCiActiveQuarantineReplayPreflight,
} from "../apps/api/ci-active-quarantine-replay-preflight.mjs";

const t0="2026-11-23T10:00:00.000Z",t1="2026-11-23T10:01:00.000Z";
const consent="ci_fixture_active_jobs_quarantine_no_replay";
const rows=()=>{
  const data=[
    {id:"ci-queued",organizationId:"org-ci-a",accountId:"acc-ci-a",
     requestedBy:"user-ci-a",status:"queued",idempotencyKey:"org-ci-a:ci-queue-a",
     createdAt:t0,startedAt:null},
    {id:"ci-running",organizationId:"org-ci-b",accountId:"acc-ci-b",
     requestedBy:"user-ci-b",status:"running",idempotencyKey:"org-ci-b:ci-queue-b",
     createdAt:t0,startedAt:t1},
  ];
  return data.map(x=>({...x,digest:createHash("sha256").update(JSON.stringify(x)).digest("hex")}));
};
const fixture=()=>createCiActiveQuarantineAttestation({
  rows:rows(),runId:"45162001819",headSha:"a".repeat(40),
  nonce:"b".repeat(32),consent,
});
const params=a=>({
  envelope:a.envelope,
  publicKeySha256:a.publicKeySha256,
  envelopeSha256:a.envelopeSha256,
  expectedRunId:"45162001819",
  expectedHeadSha:"a".repeat(40),
  expectedSequence:1,expectedCount:2,consent,
});

test("ORB-004/016 authenticated fixture produces only manual-review and investigation dispositions",()=>{
  const a=fixture(), x=params(a);
  // The public preflight requires the same two environmental gates as the
  // hosted independent runner; never turn CI flags into production authority.
  const origA=process.env.GITHUB_ACTIONS,origB=process.env.ORBICORE_CI_ACTIVE_QUARANTINE;
  process.env.GITHUB_ACTIONS="true";
  process.env.ORBICORE_CI_ACTIVE_QUARANTINE="1";
  try {
    const result=evaluateCiActiveQuarantineReplayPreflight(x);
    assert.equal(result.attestedMetadataCount,2);
    assert.equal(result.queuedRequiresManualReview,1);
    assert.equal(result.runningRequiresInvestigation,1);
    assert.deepEqual(result.dispositions.map(d=>d.disposition),
      ["manual_review_only","isolate_and_investigate"]);
    assert.equal(result.executable,false);
    assert.equal(result.replayAuthorized,false);
    assert.equal(result.jobOutboxWrites,0);
    assert.equal(result.redisSignals,0);
    assert.equal(result.providerCalls,0);
    assert.ok(result.productionGatesMissing.includes("owner_authorized_replay_scope"));
    assert.equal("id" in result.dispositions[0],false);
    assert.equal("idempotencyKey" in result.dispositions[0],false);
  } finally {
    if(origA===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=origA;
    if(origB===undefined)delete process.env.ORBICORE_CI_ACTIVE_QUARANTINE;else process.env.ORBICORE_CI_ACTIVE_QUARANTINE=origB;
  }
});

test("ORB-004/016 CI replay preflight refuses tamper, foreign pins and caller approval claims",()=>{
  const a=fixture(), x=params(a);
  const origA=process.env.GITHUB_ACTIONS,origB=process.env.ORBICORE_CI_ACTIVE_QUARANTINE;
  process.env.GITHUB_ACTIONS="true";
  process.env.ORBICORE_CI_ACTIVE_QUARANTINE="1";
  try {
    const forged=structuredClone(a.envelope);
    forged.rows[0].status="running";
    forged.rows[0].startedAt=t1;
    assert.throws(()=>evaluateCiActiveQuarantineReplayPreflight({...x,envelope:forged}),
      /ci_replay_preflight_attestation_invalid/);
    assert.throws(()=>evaluateCiActiveQuarantineReplayPreflight({
      ...x,expectedHeadSha:"f".repeat(40),
    }),/ci_replay_preflight_attestation_invalid/);
    assert.throws(()=>evaluateCiActiveQuarantineReplayPreflight({
      ...x,expectedRunId:"99",
    }),/ci_replay_preflight_attestation_invalid/);
    const unchanged=evaluateCiActiveQuarantineReplayPreflight({
      ...x,approved:true,forceReplay:true,externalOperatorApproved:true,
    });
    assert.equal(unchanged.replayAuthorized,false);
    assert.equal(unchanged.executable,false);
    assert.equal(unchanged.dispositions[1].disposition,"isolate_and_investigate");
  } finally {
    if(origA===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=origA;
    if(origB===undefined)delete process.env.ORBICORE_CI_ACTIVE_QUARANTINE;else process.env.ORBICORE_CI_ACTIVE_QUARANTINE=origB;
  }
});

test("ORB-004/016 policy cannot read or authorize outside CI/consent gates",()=>{
  const a=fixture(), p=params(a);
  assert.throws(()=>evaluateCiActiveQuarantineReplayPreflight({...p,consent:"production"}),
    /ci_replay_preflight_explicit_gate_required/);
});
