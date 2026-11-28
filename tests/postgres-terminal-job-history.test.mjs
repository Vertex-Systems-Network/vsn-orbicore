import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSyntheticTerminalJobs, insertSyntheticTerminalJobs } from "../apps/api/postgres-terminal-job-history.mjs";
import { copySyntheticTerminalJobHistorySnapshot } from "../apps/api/postgres-identity-core.mjs";

const now = "2026-11-23T09:00:00.000Z";
const later = "2026-11-23T09:01:00.000Z";
const source = { accounts:[{id:"acct-ci",organization_id:"org-ci",source:"mock_fixture"}], users:[{id:"user-ci",organization_id:"org-ci"}] };
const job = () => ({
  id:"job-ci",organization_id:"org-ci",account_id:"acct-ci",requested_by:"user-ci",
  type:"inventory_refresh",status:"completed",idempotency_key:"ci-terminal-sample",
  created_at:now,started_at:now,completed_at:later,error:null,
  result_json:JSON.stringify({source:"mock_fixture",live:false,ciFixture:true,accountId:"acct-ci",sites:2}),
});

test("ORB-004/005 terminal history accepts only closed synthetic tenant-scoped snapshots", () => {
  assert.equal(validateSyntheticTerminalJobs([job()],source).length,1);
  assert.equal(validateSyntheticTerminalJobs([{...job(),idempotency_key:"org-ci:ci-terminal-sample"}],source).length,1,
    "SQLite HTTP route uses a tenant-prefixed idempotency key");
  const generated = {...job(),result_json:JSON.stringify({source:"mock_fixture",live:false,accountId:"acct-ci",sites:2,fetchedAt:now})};
  assert.deepEqual(validateSyntheticTerminalJobs([generated],source)[0],JSON.parse(generated.result_json),
    "real mock worker results have no ciFixture key and must remain importable");
  assert.equal(validateSyntheticTerminalJobs([{...job(), status:"failed",result_json:null,error:"ci_fixture_failure"}],source)[0],null);
  for (const status of ["queued","running","paused"]) {
    assert.throws(() => validateSyntheticTerminalJobs([{...job(),status}],source),/unsupported_nonterminal/);
  }
  assert.throws(()=>validateSyntheticTerminalJobs([{...job(),requested_by:"other"}],source),/tenant_actor_mismatch/);
  assert.throws(()=>validateSyntheticTerminalJobs([{...job(),account_id:"other"}],source),/tenant_actor_mismatch/);
  assert.throws(()=>validateSyntheticTerminalJobs([{...job(),completed_at:now,started_at:later}],source),/invalid_timestamps/);
});

test("ORB-004/005 terminal history fails closed on arbitrary result payloads and credentials", () => {
  for (const result of [
    {source:"mock_fixture",live:true,ciFixture:true,accountId:"acct-ci"},
    {source:"mock_fixture",live:false,ciFixture:true,accountId:"acct-ci",apiToken:"secret"},
    {source:"mock_fixture",live:false,ciFixture:false,accountId:"acct-ci"},
    {source:"mock_fixture",live:false,ciFixture:true,accountId:"different"},
  ]) {
    assert.throws(()=>validateSyntheticTerminalJobs([{...job(),result_json:JSON.stringify(result)}],source),/result_not_fixture_safe/);
  }
  assert.throws(()=>validateSyntheticTerminalJobs([{...job(),idempotency_key:"live-retry-key"}],source),/unsupported_nonterminal/);
  assert.throws(()=>validateSyntheticTerminalJobs([{...job(),idempotency_key:"other-tenant:ci-terminal-sample"}],source),/unsupported_nonterminal/);
  assert.throws(()=>validateSyntheticTerminalJobs([{...job(),result_json:"{"}],source),/result_not_fixture_safe/);
  assert.throws(()=>validateSyntheticTerminalJobs([{...job(),status:"failed",result_json:null,error:"real provider error"}],source),/failure_is_not_fixture_safe/);
});

test("ORB-004/005 terminal history uses parameters and does not enqueue work", async () => {
  const calls=[];
  await insertSyntheticTerminalJobs({client:{async query(sql,params){calls.push({sql,params});}},source:{...source,jobs:[job()]}});
  assert.equal(calls.length,1);
  assert.match(calls[0].sql,/INSERT INTO jobs/);
  assert.match(calls[0].sql,/\$11::jsonb/);
  assert.equal(calls[0].params[5],"completed");
  assert.equal(calls[0].params[6],"ci-terminal-sample");
  assert.equal(JSON.parse(calls[0].params[10]).ciFixture,true);
  await assert.rejects(copySyntheticTerminalJobHistorySnapshot({
    sqlite:{prepare(){throw Error("sqlite accessed");}},
    postgres:{connect(){throw Error("pg connected");}},
  }),/explicit_synthetic_offline_copy_required/);
});

test("ORB-004/005 terminal history rejects provider provenance, non-string identifiers and duplicate identities before insert", async () => {
  const provider = { ...source, accounts: [{ ...source.accounts[0], source: "provider" }] };
  const unknown = { ...source, accounts: [{ id: "acct-ci", organization_id: "org-ci" }] };
  for (const invalidSource of [provider, unknown]) {
    assert.throws(() => validateSyntheticTerminalJobs([job()], invalidSource), /tenant_actor_mismatch/);
  }
  assert.throws(() => validateSyntheticTerminalJobs([{ ...job(), id: 123 }], source), /unsupported_nonterminal/);
  assert.throws(() => validateSyntheticTerminalJobs([job(), { ...job(), idempotency_key: "ci-terminal-other" }], source), /duplicate_terminal_job_identity/);
  assert.throws(() => validateSyntheticTerminalJobs([job(), { ...job(), id: "job-other" }], source), /duplicate_terminal_job_identity/);
  let queries = 0;
  await assert.rejects(() => insertSyntheticTerminalJobs({
    client: { async query() { queries += 1; } },
    source: { ...source, jobs: [job(), { ...job(), id: "job-other" }] },
  }), /duplicate_terminal_job_identity/);
  assert.equal(queries, 0);
});
