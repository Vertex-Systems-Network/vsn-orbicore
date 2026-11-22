// ORB-004: full synthetic worker's *job* SQL via fixed SECURITY DEFINER
// entrypoints, under an independently authenticated non-owner PG session.
// Hosted CI fixture only; not production worker permissions or live jobs.
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENTRY=/^[0-9]{1,20}-[0-9]{1,20}$/;
function gate(){
  if(process.env.GITHUB_ACTIONS!=="true"||
     process.env.ORBICORE_CI_SYNTHETIC_FULL_WORKER!=="1")
    throw new Error("ci_worker_gateway_explicit_gate_required");
}
function id(value,label){
  if(typeof value!=="string"||!ID.test(value))
    throw new TypeError("ci_worker_invalid_"+label);
}
function int(value,label,min,max){
  if(!Number.isSafeInteger(value)||value<min||value>max)
    throw new TypeError("ci_worker_invalid_"+label);
}
export function createCiScopedWorkerGateway({database}={}){
  gate();
  if(!database||typeof database.query!=="function")
    throw new TypeError("ci_worker_gateway_requires_scoped_database");
  let publishing=false;
  return Object.freeze({
    async publishOne({organizationId,redis,stream}={}){
      gate();id(organizationId,"org");
      if(stream!=="orbicore:synthetic:jobs:v1:"+organizationId ||
         !redis||typeof redis.sendCommand!=="function")
        throw new TypeError("ci_worker_invalid_stream");
      // A single, role-initialized PostgreSQL connection is mandatory:
      // holding SELECT FOR UPDATE across Redis XADD prevents two publishers
      // from concurrently selecting the same pending PG outbox entry.
      if(publishing)throw new Error("ci_worker_concurrent_publish_denied");
      publishing=true;
      let open=false;
      try{
        await database.query("BEGIN");
        open=true;
        const res=await database.query(
          "SELECT outbox_id,job_id FROM public.orbicore_ci_worker_pick_outbox($1)",
          [organizationId],
        );
        const event=res.rows[0];
        if(!event){
          await database.query("COMMIT");open=false;
          return null;
        }
        id(event.job_id,"outbox_job");
        if(typeof event.outbox_id!=="string"||
           !UUID.test(event.outbox_id))
          throw new Error("ci_worker_invalid_outbox_id");
        const redisId=await redis.sendCommand([
          "XADD",stream,"*",
          "organization_id",organizationId,"job_id",event.job_id,
        ]);
        if(typeof redisId!=="string"||!ENTRY.test(redisId))
          throw new Error("ci_worker_redis_publish_unconfirmed");
        const receipt=await database.query(
          "SELECT public.orbicore_ci_worker_confirm_outbox($1,$2::uuid,$3) AS confirmed",
          [organizationId,event.outbox_id,redisId],
        );
        if(receipt.rows[0]?.confirmed!==true)
          throw new Error("ci_worker_outbox_confirm_denied");
        await database.query("COMMIT");open=false;
        return {jobId:event.job_id,redisId};
      }catch(error){
        if(open)try{await database.query("ROLLBACK")}catch{/* fail closed */}
        throw error;
      }finally{publishing=false}
    },
    async reconcileUnfinished({organizationId,olderThanSeconds=60}={}){
      gate();id(organizationId,"org");
      int(olderThanSeconds,"reconcile_window",1,86400);
      const result=await database.query(
        "SELECT job_id FROM public.orbicore_ci_worker_reconcile_outbox($1,$2)",
        [organizationId,olderThanSeconds],
      );
      return result.rows.map(row=>row.job_id);
    },
    async getJob({organizationId,jobId}={}){
      gate();id(organizationId,"org");id(jobId,"job");
      const result=await database.query(
        "SELECT public.orbicore_ci_worker_job_status($1,$2) AS status",
        [organizationId,jobId],
      );
      const status=result.rows[0]?.status;
      if(status===null||status===undefined)return null;
      if(!["queued","running","completed","failed"].includes(status))
        throw new Error("ci_worker_unknown_job_state");
      return Object.freeze({status});
    },
    async claimSignaled({organizationId,jobId,workerId,leaseSeconds}={}){
      gate();id(organizationId,"org");id(jobId,"job");id(workerId,"worker");
      int(leaseSeconds,"lease_seconds",1,3600);
      const result=await database.query(
        "SELECT public.orbicore_ci_worker_claim_signaled($1,$2,$3,$4) AS claim_token",
        [organizationId,jobId,workerId,leaseSeconds],
      );
      const token=result.rows[0]?.claim_token;
      if(token===undefined||token===null)return null;
      if(typeof token!=="string"||!UUID.test(token))
        throw new Error("ci_worker_invalid_claim_token");
      return token;
    },
    async finalize({organizationId,jobId,claimToken}={}){
      gate();id(organizationId,"org");id(jobId,"job");
      if(typeof claimToken!=="string"||!UUID.test(claimToken))
        throw new TypeError("ci_worker_invalid_claim_token");
      const response=await database.query(
        "SELECT public.orbicore_ci_worker_finalize($1,$2,$3::uuid) AS decision",
        [organizationId,jobId,claimToken],
      );
      const decision=response.rows[0]?.decision;
      if(!["completed","policy_denied","lost_lease"].includes(decision))
        throw new Error("ci_worker_invalid_finalize_decision");
      return decision;
    },
    async failExpired({organizationId}={}){
      gate();id(organizationId,"org");
      const response=await database.query(
        "SELECT public.orbicore_ci_worker_fail_expired($1) AS failed_count",
        [organizationId],
      );
      const count=response.rows[0]?.failed_count;
      if(!Number.isSafeInteger(count)||count<0)
        throw new Error("ci_worker_invalid_expiry_result");
      return count;
    },
  });
}
