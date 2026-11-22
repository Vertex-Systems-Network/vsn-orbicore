import assert from "node:assert/strict";
import { test } from "node:test";
import { syntheticCycleBackoffMs } from "../apps/api/synthetic-worker-backoff.mjs";

test("ORB-004 failed worker cycles back off exponentially but never spin or hang",()=>{
  assert.equal(syntheticCycleBackoffMs(0,{random:()=>0}),187);
  assert.equal(syntheticCycleBackoffMs(1,{random:()=>0}),375);
  assert.equal(syntheticCycleBackoffMs(2,{random:()=>0}),750);
  assert.equal(syntheticCycleBackoffMs(10,{random:()=>0}),6000);
  assert.equal(syntheticCycleBackoffMs(1000,{random:()=>0.999}),7998);
  assert.ok(syntheticCycleBackoffMs(9,{random:()=>0.9})<=8000);
  for(const value of [-1,0.1,NaN,Infinity,"3"]){
    assert.throws(()=>syntheticCycleBackoffMs(value),/invalid_synthetic_worker_backoff_input/);
  }
  assert.throws(()=>syntheticCycleBackoffMs(1,{random:()=>1}),/invalid_synthetic_worker_backoff_sample/);
});
