import {
 inspectCiSourceWitnessCompleteness,
} from "./ci-source-witness.mjs";
import {
 requireCiDetachedWitnessGate,
} from "./ci-detached-witness-checkpoint.mjs";

// Readiness here means ONLY internal fixture consistency. Promotion remains
// permanently prohibited; no HTTP auth or credential reads invoke this code.
export function inspectCiShadowEvidenceReadiness({
 sqlite,attestor,witnessRows,fenceRows,draftRows,
 signer,checkpoint,pinnedMac,minimumSequence,
}={}){
 requireCiDetachedWitnessGate();
 const denied=Object.freeze({
  fixtureConsistent:false,productionLoginAuthorized:false,
 });
 if(!sqlite||typeof sqlite.prepare!=="function"||
    !attestor||typeof attestor.verify!=="function"||
    !signer||typeof signer.verify!=="function"||
    !Array.isArray(witnessRows)||
    !Array.isArray(fenceRows)||
    !Array.isArray(draftRows))return denied;
 try{
  // The trusted pinned head is controlled by a *separate* CI reader;
  // without it, an old internally valid signed checkpoint is not accepted.
  if(!signer.verify({
   checkpoint,witnessRows,pinnedMac,minimumSequence,
  }))return denied;
  const complete=inspectCiSourceWitnessCompleteness({
   sqlite,witnessRows,attestor,
  });
  if(!complete.complete)return denied;
  const users=sqlite.prepare(
   "SELECT e.user_id,e.epoch,u.organization_id,u.disabled,"+
   "u.mfa_enabled FROM ci_source_credential_epoch e "+
   "JOIN users u ON u.id=e.user_id",
  ).all();
  if(users.length<1)return denied;
  const source=new Map();
  const key=(org,user)=>JSON.stringify([org,user]);
  for(const u of users){
   if(typeof u.organization_id!=="string"||
      typeof u.user_id!=="string"||
      !Number.isSafeInteger(u.epoch)||u.epoch<1 ||
      ![0,1].includes(u.disabled)||![0,1].includes(u.mfa_enabled))
    return denied;
   const id=key(u.organization_id,u.user_id);
   if(source.has(id))return denied;
   source.set(id,u);
  }
  const pending=sqlite.prepare(
   "SELECT COUNT(*) AS count FROM ci_source_credential_outbox "+
   "WHERE status!='reconciled'",
  ).get();
  if(!pending||pending.count!==0)return denied;
  const fences=new Map();
  for(const f of fenceRows){
   const id=key(f.organization_id,f.user_id);
   const epoch=Number(f.confirmed_epoch);
   if(fences.has(id)||!source.has(id)||
      !Number.isSafeInteger(epoch)||epoch<2)
    return denied;
   fences.set(id,epoch);
  }
  let changed=0;
  for(const [id,u] of source){
   if(u.epoch>1){
    changed++;
    if(fences.get(id)!==u.epoch)return denied;
   }else if(fences.has(id))return denied;
  }
  if(changed!==fences.size)return denied;
  for(const d of draftRows){
   const id=key(d.organization_id,d.user_id);
   const u=source.get(id);
   const epoch=Number(d.source_epoch);
   if(!u||!Number.isSafeInteger(epoch)||epoch<1||
      epoch>u.epoch ||
      !["shadow_only","invalidated"].includes(d.state))
    return denied;
   if(d.state==="shadow_only" &&
      (epoch<u.epoch || u.disabled===1 || u.mfa_enabled===1))
    return denied;
  }
  return Object.freeze({
   fixtureConsistent:true,productionLoginAuthorized:false,
   witnessedEvents:complete.witnessedEvents,
  });
 }catch{
  return denied;
 }
}
