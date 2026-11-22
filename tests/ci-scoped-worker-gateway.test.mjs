import assert from "node:assert/strict";
import {test} from "node:test";
import {createCiScopedWorkerGateway} from "../apps/api/ci-scoped-worker-gateway.mjs";

async function withGate(fn){
  const saved={
    GITHUB_ACTIONS:process.env.GITHUB_ACTIONS,
    ORBICORE_CI_SYNTHETIC_FULL_WORKER:process.env.ORBICORE_CI_SYNTHETIC_FULL_WORKER,
  };
  try{
    process.env.GITHUB_ACTIONS="true";
    process.env.ORBICORE_CI_SYNTHETIC_FULL_WORKER="1";
    return await fn();
  }finally{
    for(const [k,v] of Object.entries(saved)){
      if(v===undefined)delete process.env[k];
      else process.env[k]=v;
    }
  }
}
test("ORB-004 full worker gateway is explicitly CI gated",()=>{
  const saved=process.env.GITHUB_ACTIONS;
  try{
    delete process.env.GITHUB_ACTIONS;
    assert.throws(()=>createCiScopedWorkerGateway({database:{query(){}}}),
      /ci_worker_gateway_explicit_gate_required/);
  }finally{
    if(saved===undefined)delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS=saved;
  }
});
test("ORB-004 full worker validates scoped inputs before SQL",async()=>{
  await withGate(async()=>{
    const calls=[];
    const gateway=createCiScopedWorkerGateway({
      database:{
        async query(sql,params){
          calls.push({sql,params});
          if(sql.includes("job_status"))return {rows:[{status:null}]};
          if(sql.includes("fail_expired"))return {rows:[{failed_count:0}]};
          return {rows:[]};
        },
      },
    });
    assert.equal(await gateway.getJob({organizationId:"ci-org",jobId:"ci-job"}),null);
    assert.equal(await gateway.failExpired({organizationId:"ci-org"}),0);
    await assert.rejects(gateway.getJob({
      organizationId:"../../escape",jobId:"ci-job",
    }),/ci_worker_invalid_org/);
    await assert.rejects(gateway.claimSignaled({
      organizationId:"ci-org",jobId:"ci-job",
      workerId:"bad; worker",leaseSeconds:5,
    }),/ci_worker_invalid_worker/);
    await assert.rejects(gateway.reconcileUnfinished({
      organizationId:"ci-org",olderThanSeconds:0,
    }),/ci_worker_invalid_reconcile_window/);
    await assert.rejects(gateway.finalize({
      organizationId:"ci-org",jobId:"ci-job",claimToken:"1-0",
    }),/ci_worker_invalid_claim_token/);
    await assert.rejects(gateway.publishOne({
      organizationId:"ci-org",redis:{sendCommand(){}},
      stream:"orbicore:synthetic:jobs:v1:other",
    }),/ci_worker_invalid_stream/);
    assert.equal(calls.length,2);
  });
});
test("ORB-004 Redis failure rolls back the scoped outbox transaction",async()=>{
  await withGate(async()=>{
    const calls=[];
    const id="550e8400-e29b-41d4-a716-446655440000";
    const gateway=createCiScopedWorkerGateway({
      database:{async query(sql,params){
        calls.push(sql);
        if(sql.includes("pick_outbox"))return {
          rows:[{outbox_id:id,job_id:"ci-job"}],
        };
        return {rows:[]};
      }},
    });
    await assert.rejects(gateway.publishOne({
      organizationId:"ci-org",
      stream:"orbicore:synthetic:jobs:v1:ci-org",
      redis:{async sendCommand(){throw new Error("redis_offline")}},
    }),/redis_offline/);
    assert.deepEqual(calls,[
      "BEGIN",
      "SELECT outbox_id,job_id FROM public.orbicore_ci_worker_pick_outbox($1)",
      "ROLLBACK",
    ]);
  });
});
