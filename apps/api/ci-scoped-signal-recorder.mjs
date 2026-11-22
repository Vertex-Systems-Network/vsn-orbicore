// CI-only adapter: separate authenticated PostgreSQL connection for
// poison-signal evidence, with *no* table grants or user credentials.
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ENTRY=/^[0-9]{1,20}-[0-9]{1,20}$/;
const REASONS=new Set(["tenant_mismatch","invalid_job_id","missing_job"]);
function gate(){
  if(process.env.GITHUB_ACTIONS!=="true"||
     process.env.ORBICORE_CI_SYNTHETIC_SIGNAL_SCOPE!=="1")
    throw new Error("ci_signal_scope_explicit_gate_required");
}
export function createCiScopedSignalRecorder({database}={}){
  gate();
  if(!database||typeof database.query!=="function")
    throw new TypeError("scoped PG query client required");
  return Object.freeze({
    async record({organizationId,redisId,reason,workerId}={}){
      gate();
      if(!ID.test(organizationId??"")||!ENTRY.test(redisId??"")||
         !REASONS.has(reason)||!ID.test(workerId??""))
        throw new TypeError("ci_signal_record_invalid_metadata");
      const result=await database.query(
        "SELECT public.orbicore_ci_record_signal_rejection($1,$2,$3,$4) AS accepted",
        [organizationId,redisId,reason,workerId],
      );
      if(result.rows[0]?.accepted!==true)
        throw new Error("ci_signal_record_scope_denied");
    },
    async inspect({organizationId,limit=20}={}){
      gate();
      if(!ID.test(organizationId??"")||
         !Number.isInteger(limit)||limit<1||limit>100)
        throw new TypeError("ci_signal_inspection_invalid_metadata");
      const result=await database.query(
        "SELECT reason,occurrences,first_seen_at,last_seen_at "+
        "FROM public.orbicore_ci_inspect_signal_rejections($1,$2)",
        [organizationId,limit],
      );
      return result.rows.map(x=>({
        reason:x.reason,occurrences:x.occurrences,
        firstSeenAt:x.first_seen_at,lastSeenAt:x.last_seen_at,
      }));
    },
  });
}
