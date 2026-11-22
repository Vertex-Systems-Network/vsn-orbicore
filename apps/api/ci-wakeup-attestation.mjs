import { createHmac, timingSafeEqual } from "node:crypto";

// CI-only signed Redis wakeup payloads. The source of truth is still PG
// outbox+job state, never Redis; secrets are injected in-memory, never shipped.
const DOMAIN="orbicore:ci:synthetic:redis-wakeup:v1";
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_ID=/^[a-z][a-z0-9_-]{1,31}$/;
const MAC=/^[0-9a-f]{64}$/;
const FIELDS=["organization_id","job_id","outbox_id","origin_key_id","origin_mac"];
function gate(){
  if(process.env.GITHUB_ACTIONS!=="true"||
     process.env.ORBICORE_CI_SYNTHETIC_SIGNED_WAKEUP!=="1")
    throw new Error("ci_wakeup_signature_fixture_gate_required");
}
function secret(entry){
  if(!entry||!KEY_ID.test(entry.id??"")||
     !Buffer.isBuffer(entry.key)||entry.key.length<32||entry.key.length>128)
    throw new TypeError("ci_wakeup_key_invalid");
  return {id:entry.id,key:Buffer.from(entry.key)};
}
function payload({organizationId,jobId,outboxId}={}){
  if(typeof organizationId!=="string"||!ID.test(organizationId)||
     typeof jobId!=="string"||!ID.test(jobId)||
     typeof outboxId!=="string"||!UUID.test(outboxId))
    throw new TypeError("ci_wakeup_identity_invalid");
  return Buffer.from(JSON.stringify([
    DOMAIN,organizationId,jobId,outboxId.toLowerCase(),
  ]),"utf8");
}
export function createCiWakeupAttestor({active,previous=[]}={}){
  gate();
  if(!Array.isArray(previous)||previous.length>3)
    throw new TypeError("ci_wakeup_rotation_keys_invalid");
  const items=[secret(active),...previous.map(secret)];
  if(new Set(items.map(x=>x.id)).size!==items.length)
    throw new TypeError("ci_wakeup_duplicate_key_id");
  const keys=new Map(items.map(x=>[x.id,x.key]));
  return Object.freeze({
    sign({organizationId,jobId,outboxId}={}){
      gate();
      const bytes=payload({organizationId,jobId,outboxId});
      return Object.freeze({
        origin_key_id:items[0].id,
        origin_mac:createHmac("sha256",items[0].key)
          .update(bytes).digest("hex"),
      });
    },
    verify({fields}={}){
      gate();
      if(!fields||typeof fields!=="object"||Array.isArray(fields))
        return false;
      const names=Object.keys(fields).sort();
      if(names.length!==FIELDS.length||
         names.some((name,index)=>name!==FIELDS.toSorted()[index])||
         !KEY_ID.test(fields.origin_key_id??"")||
         !MAC.test(fields.origin_mac??""))
        return false;
      const key=keys.get(fields.origin_key_id);
      if(!key)return false;
      try{
        const bytes=payload({
          organizationId:fields.organization_id,
          jobId:fields.job_id,
          outboxId:fields.outbox_id,
        });
        const expected=createHmac("sha256",key).update(bytes).digest();
        return timingSafeEqual(
          expected,Buffer.from(fields.origin_mac,"hex"),
        );
      }catch{return false}
    },
  });
}
