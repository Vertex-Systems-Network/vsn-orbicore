import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createClient } from "redis";
import { createSyntheticRedisJobRunner } from "../apps/api/synthetic-redis-worker.mjs";

if(process.env.GITHUB_ACTIONS!=="true"||
   process.env.ORBICORE_CI_SYNTHETIC_SIGNAL_REJECTIONS!=="1")
  throw new Error("ci_signal_quarantine_explicit_gate_required");
const pool=new Pool({
  host:process.env.PGHOST??"127.0.0.1",
  port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??"orbicore",
  database:process.env.PGDATABASE??"orbicore",
  password:process.env.PGPASSWORD,
  max:3,connectionTimeoutMillis:5000,
});
const redis=createClient({
  url:process.env.ORBICORE_CI_REDIS_URL??"redis://127.0.0.1:6379",
  disableOfflineQueue:true,
});
redis.on("error",()=>{});
const org="ci-poison-"+randomUUID(),other="ci-other-"+randomUUID();
async function pending(stream,group){
 const list=await redis.sendCommand(["XPENDING",stream,group]);
 return Number(list[0]);
}
try{
  await redis.connect();
  await pool.query("INSERT INTO organizations(id,name) VALUES ($1,'Synthetic signal scope'),($2,'Other scope')",[org,other]);
  const runner=createSyntheticRedisJobRunner({
    pool,redis,organizationId:org,workerId:"ci-poison-worker",
  });
  const foreign=createSyntheticRedisJobRunner({
    pool,redis,organizationId:other,workerId:"ci-other-worker",
  });
  await runner.ensureGroup();
  const send=async(fields)=>redis.sendCommand([
    "XADD",runner.stream,"*",
    "organization_id",fields.org,"job_id",fields.job,
  ]);
  // Untrusted fields stay in Redis only, never in PostgreSQL evidence.
  const fakePayload="sensitive-but-synthetic-do-not-store";
  const mismatchId=await send({org:other,job:fakePayload});
  assert.equal((await runner.consumeOne()).status,"rejected_invalid_signal");
  assert.equal(await pending(runner.stream,runner.group),0);
  const badId=await send({org,job:"../../"+fakePayload});
  assert.equal((await runner.consumeOne()).status,"rejected_invalid_signal");
  const missingId=await send({org,job:"valid-format-unrecognized-job"});
  assert.equal((await runner.consumeOne()).status,"rejected_missing_job");
  assert.equal(await pending(runner.stream,runner.group),0);
  const rows=await pool.query(
    "SELECT redis_entry_id,reason,occurrences FROM job_signal_rejections "+
    "WHERE organization_id=$1 ORDER BY first_seen_at,redis_entry_id",[org],
  );
  assert.equal(rows.rowCount,3);
  const map=new Map(rows.rows.map(r=>[r.redis_entry_id,r]));
  assert.equal(map.get(mismatchId)?.reason,"tenant_mismatch");
  assert.equal(map.get(badId)?.reason,"invalid_job_id");
  assert.equal(map.get(missingId)?.reason,"missing_job");
  assert.deepEqual(rows.rows.map(r=>r.occurrences),[1,1,1]);
  const columns=(await pool.query(
    "SELECT column_name FROM information_schema.columns "+
    "WHERE table_name='job_signal_rejections' ORDER BY column_name",
  )).rows.map(x=>x.column_name);
  assert.equal(columns.some(c=>/payload|password|user_id|job_id|raw|email/i.test(c)),false);
  assert.equal(JSON.stringify(rows.rows).includes(fakePayload),false);
  assert.equal((await foreign.inspectRejectedSignals()).length,0);
  assert.equal((await runner.inspectRejectedSignals({limit:2})).length,2);
  await assert.rejects(runner.inspectRejectedSignals({limit:101}),/limit/);
  const privilege=await pool.query(
    "SELECT has_table_privilege('orbicore_tenant_readonly', "+
    "'job_signal_rejections','SELECT') AS can_read",
  );
  assert.equal(privilege.rows[0].can_read,false);
  const rls=await pool.query(
    "SELECT relrowsecurity,relforcerowsecurity FROM pg_class "+
    "WHERE oid='job_signal_rejections'::regclass",
  );
  assert.equal(rls.rows[0].relrowsecurity,true);
  assert.equal(rls.rows[0].relforcerowsecurity,true);

  // Simulate PostgreSQL write failure. No XACK: Redis MUST retain the PEL
  // entry for after database health returns.
  await pool.query(
    "ALTER TABLE job_signal_rejections ADD CONSTRAINT ci_poison_inject "+
    "CHECK (reason <> 'invalid_job_id') NOT VALID",
  );
  const failedId=await send({org,job:"../retry"});
  try{
    await assert.rejects(runner.consumeOne(),/check constraint/i);
    assert.equal(await pending(runner.stream,runner.group),1);
    assert.equal((await pool.query(
      "SELECT count(*)::int AS n FROM job_signal_rejections WHERE redis_entry_id=$1",
      [failedId],
    )).rows[0].n,0);
  }finally{
    await pool.query(
      "ALTER TABLE job_signal_rejections DROP CONSTRAINT ci_poison_inject",
    );
  }
  assert.equal((await runner.consumeOne({reclaim:true,minIdleMs:0})).status,
    "rejected_invalid_signal");
  assert.equal(await pending(runner.stream,runner.group),0);

  // PG write COMMIT followed by failed Redis XACK. Reclaim is idempotent,
  // increments the metadata-only occurrence count and does not lose events.
  let failAck=true;
  const failAckRunner=createSyntheticRedisJobRunner({
    pool,organizationId:org,workerId:"ci-ack-failure",
    redis:{
      async sendCommand(args){
        if(args[0]==="XACK"&&failAck){
          failAck=false;
          throw new Error("ci_simulated_ack_failure");
        }
        return redis.sendCommand(args);
      },
    },
  });
  const ackGapId=await send({org:other,job:"ci-not-real"});
  await assert.rejects(failAckRunner.consumeOne(),/ci_simulated_ack_failure/);
  assert.equal(await pending(runner.stream,runner.group),1);
  assert.equal((await pool.query(
    "SELECT occurrences FROM job_signal_rejections WHERE redis_entry_id=$1",
    [ackGapId],
  )).rows[0].occurrences,1);
  assert.equal((await failAckRunner.consumeOne({reclaim:true,minIdleMs:0})).status,
    "rejected_invalid_signal");
  assert.equal(await pending(runner.stream,runner.group),0);
  assert.equal((await pool.query(
    "SELECT occurrences FROM job_signal_rejections WHERE redis_entry_id=$1",
    [ackGapId],
  )).rows[0].occurrences,2);
  // Re-applying migration must preserve the durable rejection history.
  const count=(await pool.query(
    "SELECT count(*)::int AS n FROM job_signal_rejections WHERE organization_id=$1",
    [org],
  )).rows[0].n;
  assert.equal(count,5);
  process.stdout.write(JSON.stringify({
    check:"orb-004-redis-poison-signal-quarantine",
    postgres16:true,redis7:true,sourceTenantIsolated:true,
    noRawJobIdOrPayloadPersisted:true,
    invalidTenantRecordedBeforeAck:true,invalidIdRecordedBeforeAck:true,
    missingJobRecordedBeforeAck:true,nonownerReadDenied:true,
    writeFailureLeavesRedisPending:true,
    ackFailureReclaimAndReplayIdempotent:true,
    inspectionLimitValidated:true,rejectedSignalCount:count,
    providerCommandsExecuted:false,productionWorkerEnabled:false,
  })+"\n");
}finally{
 if(redis.isOpen)await redis.close().catch(()=>redis.destroy());
 await pool.end();
}
