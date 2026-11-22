import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// CI-only detached evidence demonstrator. The digest is held outside SQLite
// and PostgreSQL, but its CI file is NOT off-host, immutable or real WORM.
const IDENTIFIER=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY_ID=/^[a-z][a-z0-9_-]{1,31}$/;
const MAC=/^[0-9a-f]{64}$/;
const VERSION="orbicore:ci:detached-witness:v1";

export function requireCiDetachedWitnessGate(){
 if(process.env.GITHUB_ACTIONS!=="true" ||
    process.env.ORBICORE_CI_SYNTHETIC_DETACHED_CHECKPOINT!=="1" ||
    process.env.ORBICORE_CI_SYNTHETIC_WITNESS!=="1" ||
    process.env.ORBICORE_CI_SYNTHETIC_EVENT_ATTESTATION!=="1")
   throw new Error("ci_detached_witness_explicit_gate_required");
}
function recordTuples(rows){
 if(!Array.isArray(rows) || rows.length<1 || rows.length>10000)
   return null;
 const seen=new Set();
 const list=[];
 for(const r of rows){
  const epoch=Number(r?.source_epoch);
  if(!r || !IDENTIFIER.test(r.organization_id??"") ||
     !IDENTIFIER.test(r.user_id??"") ||
     !IDENTIFIER.test(r.actor_id??"") ||
     !Number.isSafeInteger(epoch)||epoch<2||
     !MAC.test(r.event_id??"") || !MAC.test(r.origin_mac??"") ||
     !KEY_ID.test(r.origin_key_id??"")) return null;
  const tuple=[r.organization_id,r.user_id,epoch,r.event_id,
    r.origin_key_id,r.origin_mac,r.actor_id];
  const index=JSON.stringify(tuple.slice(0,3));
  if(seen.has(index))return null;
  seen.add(index);
  list.push(tuple);
 }
 list.sort((a,b)=>{
   const ax=JSON.stringify(a.slice(0,3));
   const bx=JSON.stringify(b.slice(0,3));
   return ax<bx?-1:ax>bx?1:0;
 });
 return list;
}
function safeEqualHex(a,b){
 if(typeof a!=="string"||typeof b!=="string"||
    !MAC.test(a)||!MAC.test(b))return false;
 return timingSafeEqual(Buffer.from(a,"hex"),Buffer.from(b,"hex"));
}
export function createCiDetachedWitnessSigner({
 activeKey,previousKeys=[],
}={}){
 requireCiDetachedWitnessGate();
 if(!activeKey||!Array.isArray(previousKeys)||previousKeys.length>2)
   throw new TypeError("ci_detached_witness_keyring_invalid");
 const supplied=[activeKey,...previousKeys];
 const keys=new Map();
 for(const k of supplied){
  if(!k || !KEY_ID.test(k.id??"") ||
     !Buffer.isBuffer(k.bytes)||k.bytes.length<32||
     keys.has(k.id))
    throw new TypeError("ci_detached_witness_keyring_invalid");
  keys.set(k.id,Buffer.from(k.bytes));
 }
 function macFor(keyId,sequence,count,rowsSha256){
  const key=keys.get(keyId);
  if(!key)return null;
  return createHmac("sha256",key).update(
   JSON.stringify([VERSION,keyId,sequence,count,rowsSha256]),
  ).digest("hex");
 }
 function snapshotHash(witnessRows){
  const rows=recordTuples(witnessRows);
  if(!rows)return null;
  return {count:rows.length,digest:createHash("sha256")
    .update(JSON.stringify([VERSION,"rows",rows])).digest("hex")};
 }
 function issue({witnessRows,sequence}={}){
  if(!Number.isSafeInteger(sequence)||sequence<1)
   throw new TypeError("ci_detached_witness_sequence_invalid");
  const snapshot=snapshotHash(witnessRows);
  if(!snapshot)
   throw new TypeError("ci_detached_witness_snapshot_invalid");
  const keyId=activeKey.id;
  return Object.freeze({
   version:VERSION,keyId,sequence,
   count:snapshot.count,rowsSha256:snapshot.digest,
   mac:macFor(keyId,sequence,snapshot.count,snapshot.digest),
  });
 }
 function verify({
  checkpoint,witnessRows,pinnedMac,minimumSequence,
 }={}){
  if(!checkpoint||checkpoint.version!==VERSION ||
     !KEY_ID.test(checkpoint.keyId??"") ||
     !Number.isSafeInteger(checkpoint.sequence)||
     checkpoint.sequence<1||
     !Number.isSafeInteger(minimumSequence)||minimumSequence<1||
     checkpoint.sequence<minimumSequence ||
     !Number.isSafeInteger(checkpoint.count) ||
     checkpoint.count<1||
     !MAC.test(checkpoint.rowsSha256??"") ||
     !MAC.test(checkpoint.mac??"")||
     !MAC.test(pinnedMac??""))return false;
  const hash=snapshotHash(witnessRows);
  if(!hash||hash.count!==checkpoint.count ||
     !safeEqualHex(hash.digest,checkpoint.rowsSha256)||
     !safeEqualHex(checkpoint.mac,pinnedMac))return false;
  const expected=macFor(
   checkpoint.keyId,checkpoint.sequence,
   checkpoint.count,checkpoint.rowsSha256,
  );
  return expected!==null&&safeEqualHex(expected,checkpoint.mac);
 }
 return Object.freeze({issue,verify});
}
