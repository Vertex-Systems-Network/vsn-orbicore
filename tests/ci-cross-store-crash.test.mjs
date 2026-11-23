import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const source=fileURLToPath(new URL("../scripts/verify-postgres-ci-cross-store-crash.mjs",import.meta.url));
const run=env=>spawnSync(process.execPath,[source],{
  env:{...process.env,GITHUB_ACTIONS:"false",
    ORBICORE_CI_ACTIVE_QUARANTINE:"0",
    ORBICORE_CI_CROSS_STORE_CRASH:"0",
    ORBICORE_CI_NO_PROVIDER_CALLS:"0",
    PGPASSWORD:"ci-cross-store-crash-only-password",...env},
  encoding:"utf8",timeout:15000,
});
test("ORB-004/016 two-store crash proof refuses normal runtime and missing individual gates",()=>{
  for(const env of [
    {GITHUB_ACTIONS:"false",ORBICORE_CI_ACTIVE_QUARANTINE:"1",
      ORBICORE_CI_CROSS_STORE_CRASH:"1",ORBICORE_CI_NO_PROVIDER_CALLS:"1"},
    {GITHUB_ACTIONS:"true",ORBICORE_CI_ACTIVE_QUARANTINE:"0",
      ORBICORE_CI_CROSS_STORE_CRASH:"1",ORBICORE_CI_NO_PROVIDER_CALLS:"1"},
    {GITHUB_ACTIONS:"true",ORBICORE_CI_ACTIVE_QUARANTINE:"1",
      ORBICORE_CI_CROSS_STORE_CRASH:"0",ORBICORE_CI_NO_PROVIDER_CALLS:"1"},
    {GITHUB_ACTIONS:"true",ORBICORE_CI_ACTIVE_QUARANTINE:"1",
      ORBICORE_CI_CROSS_STORE_CRASH:"1",ORBICORE_CI_NO_PROVIDER_CALLS:"0"},
  ]){
    const r=run(env);
    assert.notEqual(r.status,0);
    assert.match(r.stderr,/ci_cross_store_crash_disposable_runner_only/);
    assert.doesNotMatch(r.stderr,/ECONNREFUSED|password authentication failed/);
  }
});
test("ORB-004/016 cross-store crash runner refuses external PG hosts and non-CI passwords",()=>{
  for(const env of [
    {GITHUB_ACTIONS:"true",ORBICORE_CI_ACTIVE_QUARANTINE:"1",
      ORBICORE_CI_CROSS_STORE_CRASH:"1",ORBICORE_CI_NO_PROVIDER_CALLS:"1",
      PGHOST:"example.org"},
    {GITHUB_ACTIONS:"true",ORBICORE_CI_ACTIVE_QUARANTINE:"1",
      ORBICORE_CI_CROSS_STORE_CRASH:"1",ORBICORE_CI_NO_PROVIDER_CALLS:"1",
      PGPASSWORD:"not-the-disposable-ci-password"},
  ]){
    const r=run(env);
    assert.notEqual(r.status,0);
    assert.match(r.stderr,/ci_cross_store_crash_disposable_runner_only/);
    assert.doesNotMatch(r.stderr,/ECONNREFUSED|password authentication failed/);
  }
});
