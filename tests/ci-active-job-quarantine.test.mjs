import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateSyntheticActiveJobQuarantine, stageSyntheticActiveJobQuarantine,
} from "../apps/api/ci-active-job-quarantine.mjs";

const t0="2026-11-23T10:00:00.000Z",t1="2026-11-23T10:01:00.000Z";
const snapshot=()=>({
  accounts:[{id:"acc-ci",organization_id:"org-ci",source:"mock_fixture"}],
  users:[{id:"user-ci",organization_id:"org-ci",email:"ci-operator@example.test",role:"operator",disabled:0}],
  jobs:[{id:"job-ci",organization_id:"org-ci",account_id:"acc-ci",requested_by:"user-ci",
    type:"inventory_refresh",status:"queued",idempotency_key:"org-ci:ci-queue-one",
    created_at:t0,started_at:null,completed_at:null,result_json:null,error:null}],
  secretReferences:[],
});
test("ORB-004 active-job metadata quarantine accepts only synthetic tenant-scoped work",()=>{
  const base=snapshot();
  const [accepted]=validateSyntheticActiveJobQuarantine(base);
  assert.equal(accepted.status,"queued");
  assert.equal(accepted.digest.length,64);
  assert.equal(accepted.idempotencyKey,"org-ci:ci-queue-one");
  assert.equal(Object.hasOwn(accepted,"result_json"),false);
  const running=snapshot();
  running.jobs[0].status="running";running.jobs[0].started_at=t1;
  assert.equal(validateSyntheticActiveJobQuarantine(running)[0].status,"running");
});

test("ORB-004 quarantine refuses malicious/live/broken source and cannot stage queued work as executable",()=>{
  const cases=[
    [x=>{x.accounts[0].source="provider";},/nonfixture_active_source/],
    [x=>{x.users[0].email="real@example.com";},/nonfixture_active_source/],
    [x=>{x.secretReferences.push({id:"not-copyable"});},/nonfixture_active_source/],
    [x=>{x.jobs[0].idempotency_key="other-org:ci-queue-one";},/unsafe_active_job_idempotency/],
    [x=>{x.jobs[0].requested_by="missing";},/active_job_tenant_or_actor/],
    [x=>{x.users[0].role="viewer";},/active_job_tenant_or_actor/],
    [x=>{x.users[0].disabled=1;},/active_job_tenant_or_actor/],
    [x=>{x.jobs[0].status="completed";},/unsafe_active_job_shape/],
    [x=>{x.jobs[0].started_at=t1;},/unsafe_active_job_shape/],
    [x=>{x.jobs[0].result_json='{"token":"not-allowed"}';},/unsafe_active_job_shape/],
    [x=>{x.jobs[0].error="provider failure";},/unsafe_active_job_shape/],
    [x=>{x.jobs[0].completed_at=t1;},/unsafe_active_job_shape/],
    [x=>{x.jobs[0].created_at="bad";},/unsafe_active_job_shape/],
    [x=>{x.jobs[0].status="running";},/unsafe_active_job_shape/],
    [x=>{x.jobs[0].organization_id="wrong";x.jobs[0].idempotency_key="wrong:ci-queue-one";},/active_job_tenant_or_actor/],
  ];
  for (const [change,matcher] of cases){const x=snapshot();change(x);
    assert.throws(()=>validateSyntheticActiveJobQuarantine(x),matcher);
  }
  const duplicates=snapshot();duplicates.jobs.push({...duplicates.jobs[0],id:"job-ci-other"});
  assert.throws(()=>validateSyntheticActiveJobQuarantine(duplicates),/duplicate_active_job_refused/);
  const over=snapshot();over.jobs=Array.from({length:21},(_,i)=>({...over.jobs[0],id:"job-"+i,idempotency_key:"ci-queue-"+i}));
  assert.throws(()=>validateSyntheticActiveJobQuarantine(over),/active_fixture_job_count_refused/);
});

test("ORB-004 quarantine requires CI runner gate AND explicit consent before source or PG IO",async()=>{
  await assert.rejects(stageSyntheticActiveJobQuarantine({
    sqlite:{exec(){throw Error("sqlite_called");}},
    postgres:{connect(){throw Error("pg_called");}},
    consent:"ci_fixture_active_jobs_quarantine_no_replay",
  }),/ci_active_quarantine_explicit_gate_required/);
});
