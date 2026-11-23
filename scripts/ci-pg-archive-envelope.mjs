import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// CI fixture only, not a production backup mechanism or key vault.
const MAGIC=Buffer.from("ORBICIB1","ascii");
const AAD_PREFIX="orbicore:ci:pg16:archive:v1:";
const NONCE_LENGTH=12,TAG_LENGTH=16,MAX_ARCHIVE=64*1024*1024;
const CONTEXT=new Set(["database","globals"]);
function gate(){
  if(process.env.GITHUB_ACTIONS!=="true"||
     process.env.ORBICORE_CI_PG_ISOLATED_RESTORE!=="1")
    throw new Error("ci_pg_backup_envelope_requires_hosted_fixture_gate");
}
function keyBuffer(keyHex){
  if(typeof keyHex!=="string"||!/^[a-f0-9]{64}$/.test(keyHex))
    throw new Error("ci_pg_backup_key_unavailable");
  return Buffer.from(keyHex,"hex");
}
function validateBuffer(data,context){
  if(!Buffer.isBuffer(data)||data.length<1||
     data.length>MAX_ARCHIVE||!CONTEXT.has(context))
    throw new Error("ci_pg_backup_payload_or_context_invalid");
}
export function sealCiPgArchive(data,{keyHex,context}={}){
  gate();validateBuffer(data,context);
  const key=keyBuffer(keyHex),nonce=randomBytes(NONCE_LENGTH);
  const cipher=createCipheriv("aes-256-gcm",key,nonce,{authTagLength:TAG_LENGTH});
  cipher.setAAD(Buffer.from(AAD_PREFIX+context,"utf8"));
  const content=Buffer.concat([cipher.update(data),cipher.final()]);
  return Buffer.concat([MAGIC,nonce,cipher.getAuthTag(),content]);
}
// The negative recovery fixture must differ even when its original byte
// coincidentally equals the proposed overwrite value. XOR guarantees change.
export function flipCiPgArchiveCiphertextByte(envelope){
  const index=MAGIC.length+NONCE_LENGTH+TAG_LENGTH+3;
  if(!Buffer.isBuffer(envelope)||envelope.length<=index||
     !envelope.subarray(0,MAGIC.length).equals(MAGIC))
    throw new Error("ci_pg_archive_tamper_fixture_invalid");
  const corrupted=Buffer.from(envelope);
  corrupted[index]^=0x01;
  return corrupted;
}

export function openCiPgArchive(envelope,{keyHex,context}={}){
  gate();
  try{
    if(!CONTEXT.has(context)||!Buffer.isBuffer(envelope)||
       envelope.length<=MAGIC.length+NONCE_LENGTH+TAG_LENGTH||
       envelope.length>MAX_ARCHIVE+MAGIC.length+NONCE_LENGTH+TAG_LENGTH||
       !envelope.subarray(0,MAGIC.length).equals(MAGIC))
      throw new Error("invalid envelope");
    const key=keyBuffer(keyHex),offset=MAGIC.length;
    const nonce=envelope.subarray(offset,offset+NONCE_LENGTH);
    const tag=envelope.subarray(offset+NONCE_LENGTH,
      offset+NONCE_LENGTH+TAG_LENGTH);
    const data=envelope.subarray(offset+NONCE_LENGTH+TAG_LENGTH);
    const decipher=createDecipheriv("aes-256-gcm",key,nonce,
      {authTagLength:TAG_LENGTH});
    decipher.setAAD(Buffer.from(AAD_PREFIX+context,"utf8"));
    decipher.setAuthTag(tag);
    const result=Buffer.concat([decipher.update(data),decipher.final()]);
    validateBuffer(result,context);
    return result;
  }catch{
    throw new Error("ci_pg_backup_envelope_rejected");
  }
}
export function runCiPgArchiveCommand({
  action,input,output,context,keyHex,
}={}){
  gate();
  if(!["seal","open"].includes(action)||typeof input!=="string"||
     typeof output!=="string"||resolve(input)===resolve(output))
    throw new Error("ci_pg_backup_command_invalid");
  const data=readFileSync(input);
  const result=action==="seal"?
    sealCiPgArchive(data,{keyHex,context}):
    openCiPgArchive(data,{keyHex,context});
  // A failed tag check must never create the destination file.
  // Refuse overwrite of existing target to avoid mistaking stale output.
  writeFileSync(output,result,{flag:"wx",mode:0o600});
  return {accepted:true,mode:action,context,bytes:result.length,
    fixtureOnly:true,productionRestoreAuthorized:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [action,input,output,context]=process.argv.slice(2);
  try{
    runCiPgArchiveCommand({
      action,input,output,context,
      keyHex:process.env.ORBICORE_CI_PG_ARCHIVE_KEY_HEX,
    });
    // Do not print data, key, path, secrets, or raw SQL in CI logs.
    process.stdout.write(JSON.stringify({
      check:"orb-016-ci-encrypted-archive",action,
      authenticatedEncryption:true,syntheticOnly:true,
      productionRestoreAuthorized:false,
    })+"\n");
  }catch{
    process.stderr.write("ci_pg_archive_operation_failed\n");
    process.exitCode=1;
  }
}
