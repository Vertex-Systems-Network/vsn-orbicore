// ORB-005 CI-only witness of signed, actor-bound, committed source events.
// PostgreSQL stores metadata only; it never accepts a verifier or authenticates.
export function requireCiSourceWitnessGate(){
 if(process.env.GITHUB_ACTIONS!=="true"||
    process.env.ORBICORE_CI_SYNTHETIC_REAUTH!=="1"||
    process.env.ORBICORE_CI_SYNTHETIC_RECONCILE!=="1"||
    process.env.ORBICORE_CI_SYNTHETIC_EVENT_ATTESTATION!=="1"||
    process.env.ORBICORE_CI_SYNTHETIC_ACTOR_AUTH!=="1"||
    process.env.ORBICORE_CI_SYNTHETIC_WITNESS!=="1")
   throw new Error("ci_source_witness_explicit_gate_required");
}
function isEvent(e,attestor){
 return e&&typeof e.actor_id==="string"&&e.actor_id.length>0&&
   attestor.verify(e)===true;
}
const ROWS="event_id,organization_id,user_id,source_epoch,reason,"+
 "origin_key_id,origin_mac,actor_id";

export function createCiSourceWitness({sqlite,postgres,attestor}={}){
 requireCiSourceWitnessGate();
 if(!sqlite||typeof sqlite.prepare!=="function"||
    !postgres||typeof postgres.connect!=="function"||
    !attestor||typeof attestor.verify!=="function")
   throw new TypeError("ci_source_witness_dependencies_required");

 async function anchorPending({limit=100,injectAfterPgCommit=false}={}){
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)
   throw new TypeError("ci_source_witness_limit_invalid");
  // SELECT includes reconciled records: a PG epoch fence is NOT proof that
  // an independent witness has been created after a prior SQLite change.
  const events=sqlite.prepare(
   "SELECT "+ROWS+" FROM ci_source_credential_outbox "+
   "ORDER BY sequence LIMIT ?",
  ).all(limit);
  let anchored=0;
  for(const e of events){
   if(!isEvent(e,attestor))
     throw new Error("ci_source_witness_signature_invalid");
   const identity=sqlite.prepare(
    "SELECT organization_id FROM users WHERE id=?",
   ).get(e.user_id);
   const epoch=sqlite.prepare(
    "SELECT epoch FROM ci_source_credential_epoch WHERE user_id=?",
   ).get(e.user_id);
   if(!identity||identity.organization_id!==e.organization_id||
      !epoch||epoch.epoch<e.source_epoch)
     throw new Error("ci_source_witness_source_provenance_mismatch");
   const client=await postgres.connect();
   let open=false;
   try{
    await client.query("BEGIN");open=true;
    await client.query("SET LOCAL ROLE orbicore_ci_source_witness_writer");
    const result=await client.query(
     "SELECT orbicore_ci_shadow.anchor_source_event_witness("+
     "$1,$2,$3,$4,$5,$6,$7) AS anchored",
     [e.organization_id,e.user_id,e.source_epoch,e.event_id,
      e.origin_key_id,e.origin_mac,e.actor_id],
    );
    if(result.rows[0]?.anchored!==true)
     throw new Error("ci_source_witness_conflict");
    await client.query("COMMIT");open=false;
   }catch{
    if(open)try{await client.query("ROLLBACK");}catch{/* fail closed */}
    throw new Error("ci_source_witness_write_unavailable");
   }finally{client.release()}
   anchored++;
   if(injectAfterPgCommit)
    throw new Error("ci_source_witness_post_commit_interruption");
  }
  return Object.freeze({anchored});
 }
 return Object.freeze({anchorPending});
}

// The witness snapshot MUST come from an independently trusted PostgreSQL
// owner/auditor, not from a client or the source SQLite database. This CI
// inspection is NOT a normal login gate or an approved production control.
export function inspectCiSourceWitnessCompleteness({
 sqlite,witnessRows,attestor,
}={}){
 requireCiSourceWitnessGate();
 if(!sqlite||typeof sqlite.prepare!=="function"||
    !Array.isArray(witnessRows)||
    !attestor||typeof attestor.verify!=="function")
   throw new TypeError("ci_source_witness_inspection_dependencies_required");
 const failed=Object.freeze({complete:false});
 const source=sqlite.prepare(
  "SELECT e.user_id,e.epoch,u.organization_id FROM "+
  "ci_source_credential_epoch AS e JOIN users AS u ON u.id=e.user_id",
 ).all();
 const events=sqlite.prepare(
  "SELECT "+ROWS+" FROM ci_source_credential_outbox ORDER BY sequence",
 ).all();
 const witnesses=new Map();
 const index=(org,user,epoch)=>JSON.stringify([org,user,epoch]);
 for(const w of witnessRows){
  const key=index(w.organization_id,w.user_id,Number(w.source_epoch));
  if(witnesses.has(key))return failed;
  witnesses.set(key,w);
 }
 const actual=new Map();
 for(const e of events){
  const key=index(e.organization_id,e.user_id,e.source_epoch);
  if(actual.has(key)||!isEvent(e,attestor))return failed;
  actual.set(key,e);
 }
 let expected=0;
 for(const u of source){
  if(!Number.isSafeInteger(u.epoch)||u.epoch<1)return failed;
  for(let epoch=2;epoch<=u.epoch;epoch++){
   expected++;
   const key=index(u.organization_id,u.user_id,epoch);
   const e=actual.get(key),w=witnesses.get(key);
   if(!e||!w||w.event_id!==e.event_id||
      w.origin_key_id!==e.origin_key_id||
      w.origin_mac!==e.origin_mac||
      w.actor_id!==e.actor_id) return failed;
  }
 }
 // Detect independently witnessed events missing from SQLite, unexpected
 // source metadata, deleted/extra rows and epoch regressions.
 if(events.length!==expected||witnessRows.length!==expected)
  return failed;
 return Object.freeze({complete:true,witnessedEvents:expected});
}
