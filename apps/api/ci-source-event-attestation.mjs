import { createHmac, timingSafeEqual } from "node:crypto";

// CI-only event provenance. The signing key is injected by the fixture runner;
// it is never saved to SQLite, PostgreSQL, log output or the repository.
const KEY_ID=/^[a-z][a-z0-9_-]{1,31}$/;
const HEX=/^[0-9a-f]{64}$/;
const REASONS=new Set([
  "password_reset","disabled","mfa_enrolled","role_revoked",
]);
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function gate(){
  if (process.env.GITHUB_ACTIONS!=="true" ||
      process.env.ORBICORE_CI_SYNTHETIC_REAUTH!=="1" ||
      process.env.ORBICORE_CI_SYNTHETIC_RECONCILE!=="1" ||
      process.env.ORBICORE_CI_SYNTHETIC_EVENT_ATTESTATION!=="1"){
    throw new Error("ci_source_event_attestation_gate_required");
  }
}
function validKey(k){
  return k && typeof k.id==="string" && KEY_ID.test(k.id) &&
    Buffer.isBuffer(k.bytes) && k.bytes.length>=32;
}
function isValidEvent(e){
  return e && typeof e.event_id==="string" && HEX.test(e.event_id) &&
    typeof e.organization_id==="string" && ID.test(e.organization_id) &&
    typeof e.user_id==="string" && ID.test(e.user_id) &&
    Number.isSafeInteger(e.source_epoch) && e.source_epoch>=2 &&
    REASONS.has(e.reason) &&
    (e.actor_id===null||e.actor_id===undefined||
      (typeof e.actor_id==="string"&&ID.test(e.actor_id)));
}
function message(e){
  if(typeof e.actor_id==="string"){
    return JSON.stringify(["orbicore:ci:source-event:v2",
      e.event_id,e.organization_id,e.user_id,e.source_epoch,e.reason,
      e.actor_id]);
  }
  return JSON.stringify(["orbicore:ci:source-event:v1",
    e.event_id,e.organization_id,e.user_id,e.source_epoch,e.reason]);
}
export function createCiSourceEventAttestor({activeKey,previousKeys=[]}={}){
  gate();
  if(!validKey(activeKey) || !Array.isArray(previousKeys) ||
     previousKeys.length>2 || previousKeys.some(k=>!validKey(k))){
    throw new TypeError("ci_source_attestation_keyring_invalid");
  }
  const keys=[activeKey,...previousKeys].map(k=>({
    id:k.id,bytes:Buffer.from(k.bytes),
  }));
  if(new Set(keys.map(x=>x.id)).size!==keys.length)
    throw new TypeError("ci_source_attestation_keyring_invalid");
  const byId=new Map(keys.map(k=>[k.id,k]));

  function sign(event){
    if(!isValidEvent(event))
      throw new TypeError("ci_source_attestation_event_invalid");
    return Object.freeze({
      originKeyId:keys[0].id,
      originMac:createHmac("sha256",keys[0].bytes)
        .update(message(event)).digest("hex"),
    });
  }
  function verify(event){
    if(!isValidEvent(event) ||
       typeof event.origin_key_id!=="string" ||
       !KEY_ID.test(event.origin_key_id) ||
       typeof event.origin_mac!=="string" ||
       !HEX.test(event.origin_mac)) return false;
    const key=byId.get(event.origin_key_id);
    if(!key)return false;
    const candidate=createHmac("sha256",key.bytes)
      .update(message(event)).digest();
    return timingSafeEqual(candidate,Buffer.from(event.origin_mac,"hex"));
  }
  return Object.freeze({sign,verify});
}
