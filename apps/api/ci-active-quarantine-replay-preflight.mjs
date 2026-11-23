import { verifyCiActiveQuarantineAttestation } from "./ci-active-quarantine-cross-runner.mjs";

// Non-executable CI proof: A valid signature is NOT permission to replay a job.
// This module deliberately does not expose a queue, SQL, Redis or HTTP writer.
const CONSENT = "ci_fixture_active_jobs_quarantine_no_replay";
const PRODUCTION_GATES = Object.freeze([
  "owner_authorized_replay_scope",
  "external_signing_key_custody",
  "durable_source_and_target_fencing",
  "cross_store_recovery_and_lease_proof",
  "worker_role_and_tenant_authorization",
  "idempotent_provider_effects_and_rollback",
  "independent_operator_approval_and_audit",
]);

function ciOnly(consent) {
  if (process.env.GITHUB_ACTIONS !== "true" ||
      process.env.ORBICORE_CI_ACTIVE_QUARANTINE !== "1" ||
      consent !== CONSENT) {
    throw new Error("ci_replay_preflight_explicit_gate_required");
  }
}
function decision(row) {
  // Queued work can be discussed with an operator; never emit runnable work.
  const reason = row.status === "running"
    ? "uncertain_side_effect_or_lease_state"
    : "requires_independent_authorization_and_fencing";
  return Object.freeze({
    referenceDigest:row.digest,
    sourceState:row.status,
    disposition:row.status === "running" ? "isolate_and_investigate" : "manual_review_only",
    reason,
    executable:false,
  });
}

/**
 * Evaluates strictly signed, pinned, fixture-only quarantine metadata.
 * Even caller-supplied "approved" or "replay" fields cannot authorize jobs:
 * a valid envelope is insufficient for production execution authority.
 */
export function evaluateCiActiveQuarantineReplayPreflight({
  envelope,publicKeySha256,envelopeSha256,expectedRunId,
  expectedHeadSha,expectedSequence,expectedCount,consent=null,
}={}) {
  ciOnly(consent);
  if (!verifyCiActiveQuarantineAttestation({
    envelope,publicKeySha256,envelopeSha256,expectedRunId,
    expectedHeadSha,expectedSequence,expectedCount,
  })) throw new Error("ci_replay_preflight_attestation_invalid");
  const rows=envelope.rows.map(decision);
  const queued=rows.filter(row=>row.sourceState==="queued").length;
  const running=rows.filter(row=>row.sourceState==="running").length;
  return Object.freeze({
    kind:"ci_only_active_job_recovery_policy_preflight_v1",
    attestedMetadataCount:rows.length,
    queuedRequiresManualReview:queued,
    runningRequiresInvestigation:running,
    productionGatesMissing:PRODUCTION_GATES,
    dispositions:Object.freeze(rows),
    executable:false,
    replayAuthorized:false,
    jobOutboxWrites:0,
    redisSignals:0,
    providerCalls:0,
  });
}
