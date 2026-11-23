import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const script = new URL("../scripts/verify-postgres-ci-backend-crash-fencing.mjs", import.meta.url);
const execute = overrides => spawnSync(process.execPath,[script.pathname],{
  env:{...process.env,PGPASSWORD:"ci-only-no-connection",
    GITHUB_ACTIONS:"false",ORBICORE_CI_PG_BACKEND_CRASH_FENCE:"0",
    ORBICORE_CI_NO_PROVIDER_CALLS:"0",...overrides},
  encoding:"utf8",timeout:15000,
});

test("ORB-004 crash fencing refuses execution outside disposable GitHub Actions",()=>{
  const result=execute({
    GITHUB_ACTIONS:"false",ORBICORE_CI_PG_BACKEND_CRASH_FENCE:"1",
    ORBICORE_CI_NO_PROVIDER_CALLS:"1",
  });
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/ci_only_pg_backend_crash_fence_gate_required/);
  assert.doesNotMatch(result.stderr,/ECONNREFUSED|password authentication failed/);
});

test("ORB-004 crash fencing requires both CI opt-ins before connecting to PG",()=>{
  for(const overrides of [
    {GITHUB_ACTIONS:"true",ORBICORE_CI_PG_BACKEND_CRASH_FENCE:"0",ORBICORE_CI_NO_PROVIDER_CALLS:"1"},
    {GITHUB_ACTIONS:"true",ORBICORE_CI_PG_BACKEND_CRASH_FENCE:"1",ORBICORE_CI_NO_PROVIDER_CALLS:"0"},
  ]){
    const result=execute(overrides);
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/ci_only_pg_backend_crash_fence_gate_required/);
    assert.doesNotMatch(result.stderr,/ECONNREFUSED|password authentication failed/);
  }
});
