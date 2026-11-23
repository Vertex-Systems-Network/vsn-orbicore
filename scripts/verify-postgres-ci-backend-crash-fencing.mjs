import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

// Destructive backend termination is allowed ONLY against the disposable
// PostgreSQL16 GitHub Actions service. No SQLite, Redis or provider IO.
if (process.env.GITHUB_ACTIONS !== "true" ||
    process.env.ORBICORE_CI_PG_BACKEND_CRASH_FENCE !== "1" ||
    process.env.ORBICORE_CI_NO_PROVIDER_CALLS !== "1") {
  throw new Error("ci_only_pg_backend_crash_fence_gate_required");
}
const pool=new Pool({
  host:process.env.PGHOST ?? "127.0.0.1",
  port:Number(process.env.PGPORT ?? 5432),
  user:process.env.PGUSER ?? "orbicore",
  database:process.env.PGDATABASE ?? "orbicore",
  password:process.env.PGPASSWORD,
  max:6,connectionTimeoutMillis:5000,
});
const prefix="ci-pg-kill-"+randomUUID().slice(0,12);
const tenantA=prefix+"-a",tenantB=prefix+"-b";
const accountA=prefix+"-account-a",accountB=prefix+"-account-b";
const jobA=prefix+"-job-a",jobB=prefix+"-job-b";
async function getJob(id) {
  const result=await pool.query(
    "SELECT organization_id,status,attempts,max_attempts,lease_owner,lease_token,"+
    "lease_expires_at,completed_at FROM jobs WHERE id=$1",[id],
  );
  assert.equal(result.rows.length,1,"fixture job missing");
  return result.rows[0];
}
async function killBackend(pid) {
  assert.ok(Number.isInteger(pid) && pid > 0);
  const r=await pool.query("SELECT pg_terminate_backend($1,5000) AS stopped",[pid]);
  assert.equal(r.rows[0]?.stopped,true,"test failed to terminate PG server backend");
}
function expectedBackendTermination(error) {
  // Node-postgres can surface the PG FATAL code and/or a socket disconnect,
  // depending on whether it was inside a query at the exact signal boundary.
  return error?.code === "57P01" ||
    ["Connection terminated unexpectedly", "Connection terminated",
      "Connection ended unexpectedly"].includes(error?.message);
}
async function terminateClient(client) {
  const result=await client.query("SELECT pg_backend_pid() AS pid");
  await killBackend(result.rows[0].pid);
}
async function claim(organizationId, workerId, seconds=120) {
  const r=await pool.query(
    "SELECT job_id,claim_token,attempt FROM orbicore_claim_job($1,$2,$3)",
    [organizationId,workerId,seconds],
  );
  return r.rows[0] ?? null;
}
try {
  await pool.query(
    "INSERT INTO organizations(id,name) VALUES ($1,'CI synthetic A'),($2,'CI synthetic B')",
    [tenantA,tenantB],
  );
  await pool.query(
    "INSERT INTO accounts(id,organization_id,label,provider,host,username,"+
      "health,used_bytes,quota_bytes,source) VALUES "+
      "($1,$2,'CI fixture','mock','a.invalid','fixture','healthy',0,1,'mock_fixture'),"+
      "($3,$4,'CI fixture','mock','b.invalid','fixture','healthy',0,1,'mock_fixture')",
    [accountA,tenantA,accountB,tenantB],
  );
  await pool.query(
    "INSERT INTO jobs(id,organization_id,account_id,type,status,created_at,"+
      "idempotency_key,max_attempts) VALUES "+
      "($1,$2,$3,'inventory_refresh','queued',NOW(),$4,3),"+
      "($5,$6,$7,'inventory_refresh','queued',NOW(),$8,1)",
    [jobA,tenantA,accountA,prefix+"-key-a",jobB,tenantB,accountB,prefix+"-key-b"],
  );

  // A worker claims under a transaction but is killed before COMMIT.
  // PG16 rollback must atomically undo both status and the attempt counter.
  const preCommit=await pool.connect();
  const preTerminationErrors=[];
  // Terminated checked-out clients emit an asynchronous 'error' event even
  // if COMMIT also rejects. A real worker must handle this crash path.
  preCommit.on("error", error => preTerminationErrors.push(error));
  let tentative;
  try {
    await preCommit.query("BEGIN");
    const row=await preCommit.query(
      "SELECT job_id,claim_token,attempt FROM orbicore_claim_job($1,$2,120)",
      [tenantA,"ci-precommit-worker"],
    );
    tentative=row.rows[0];
    assert.equal(tentative?.job_id,jobA);
    assert.equal(tentative.attempt,1);
    await terminateClient(preCommit);
    await assert.rejects(preCommit.query("COMMIT"),
      /terminat|connect|closed|not queryable/i);
  } finally {
    preCommit.release(true);
  }
  assert.ok(preTerminationErrors.every(expectedBackendTermination),
    "unexpected PostgreSQL client failure during injected termination");
  const undone=await getJob(jobA);
  assert.equal(undone.status,"queued");
  assert.equal(undone.attempts,0);
  assert.equal(undone.lease_token,null);
  assert.equal(undone.lease_owner,null);
  assert.equal(undone.lease_expires_at,null);
  assert.equal(undone.completed_at,null);

  // The next worker can claim exactly once after that aborted transaction.
  const committed=await claim(tenantA,"ci-postcommit-worker");
  assert.equal(committed?.job_id,jobA);
  assert.equal(committed.attempt,1);
  assert.notEqual(committed.claim_token,tentative.claim_token);
  const waiting=await claim(tenantA,"ci-competing-worker");
  assert.equal(waiting,null,"unexpired claim was granted twice");

  // A second crash AFTER COMMIT cannot undo a durable claim. No provider
  // call is invoked here, and ownership remains unresolved until expiry.
  const postCommit=await pool.connect();
  const postTerminationErrors=[];
  postCommit.on("error", error => postTerminationErrors.push(error));
  try {
    await terminateClient(postCommit);
  } finally {
    postCommit.release(true);
  }
  assert.ok(postTerminationErrors.every(expectedBackendTermination),
    "unexpected PostgreSQL client failure after durable claim");
  const durable=await getJob(jobA);
  assert.equal(durable.status,"running");
  assert.equal(durable.attempts,1);
  assert.equal(durable.lease_token,committed.claim_token);
  assert.ok(durable.lease_expires_at);
  assert.equal(await claim(tenantA,"ci-before-expiry"),null);

  // An expired claim reissues a *new* token. Both the pre-commit token and
  // the old committed token are fenced out, including a cross-tenant caller.
  // Force expiry ONLY in the disposable CI DB: no wall-clock sleep or prod IO.
  await pool.query(
    "UPDATE jobs SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' "+
    "WHERE id=$1 AND organization_id=$2",[jobA,tenantA],
  );
  const reclaimed=await claim(tenantA,"ci-replacement-worker");
  assert.equal(reclaimed?.job_id,jobA);
  assert.equal(reclaimed.attempt,2);
  assert.notEqual(reclaimed.claim_token,committed.claim_token);
  assert.notEqual(reclaimed.claim_token,tentative.claim_token);
  const complete=async(org,id,token)=>
    (await pool.query(
      "SELECT orbicore_complete_job($1,$2,$3::uuid,$4::jsonb) AS completed",
      [org,id,token,JSON.stringify({source:"mock_fixture",live:false})],
    )).rows[0].completed;
  assert.equal(await complete(tenantA,jobA,tentative.claim_token),false);
  assert.equal(await complete(tenantA,jobA,committed.claim_token),false);
  assert.equal(await complete(tenantB,jobA,reclaimed.claim_token),false);
  assert.equal(await complete(tenantA,jobA,reclaimed.claim_token),true);
  assert.equal(await complete(tenantA,jobA,reclaimed.claim_token),false,
    "completed jobs cannot be finalized again");
  assert.equal(await claim(tenantA,"ci-after-complete"),null);
  const finalA=await getJob(jobA);
  assert.equal(finalA.status,"completed");
  assert.equal(finalA.attempts,2);
  assert.equal(finalA.lease_token,null);

  // A separate tenant cannot recover an exhausted running job; the
  // owner-tenant failure path is terminal and cannot create a new claim.
  const firstB=await claim(tenantB,"ci-exhausted-worker");
  assert.equal(firstB?.job_id,jobB);
  assert.equal(firstB.attempt,1);
  await pool.query(
    "UPDATE jobs SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' "+
    "WHERE id=$1 AND organization_id=$2",[jobB,tenantB],
  );
  assert.equal((await pool.query(
    "SELECT orbicore_fail_exhausted_jobs($1) AS failed",[tenantA],
  )).rows[0].failed,0);
  assert.equal((await pool.query(
    "SELECT orbicore_fail_exhausted_jobs($1) AS failed",[tenantB],
  )).rows[0].failed,1);
  assert.equal(await claim(tenantB,"ci-after-exhaustion"),null);
  assert.equal((await getJob(jobB)).status,"failed");
  assert.equal(await complete(tenantB,jobB,firstB.claim_token),false);

  const sums=await pool.query(
    "SELECT (SELECT COUNT(*)::int FROM job_outbox) AS outbox, "+
    "(SELECT COUNT(*)::int FROM jobs WHERE id IN ($1,$2)) AS synthetic_jobs",
    [jobA,jobB],
  );
  assert.equal(sums.rows[0].outbox,0,"no recovery outbox was created");
  assert.equal(sums.rows[0].synthetic_jobs,2);

  console.log(JSON.stringify({
    scope:"ci_only_disposable_postgres16_crash_fencing",
    tasks:["ORB-004","ORB-016","ORB-017"],
    preCommitBackendKilled:true,preCommitClaimRolledBack:true,
    attemptCounterRolledBack:true,postCommitBackendKilled:true,
    durablePostCommitClaim:true,unexpiredDoubleClaimDenied:true,
    expiredLeaseReplacementTokenDistinct:true,
    staleAndCrossTenantCompletionDenied:true,terminalCompletionOnce:true,
    exhaustedClaimDenied:true,publicJobOutboxRows:0,
    providerCalls:0,redisSignals:0,productionJobsRestored:0,
    operatorReplayAuthorized:false,productionWorkerCutover:false,
    limitation:"Synthetic PostgreSQL lease and backend termination, not SQLite-to-PG cross-store atomic recovery",
  }));
} finally {
  await pool.end();
}
