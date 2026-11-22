import {
  createHash, createPublicKey, generateKeyPairSync, sign, verify,
  timingSafeEqual,
} from "node:crypto";

// CI-ONLY export/recovery of generated non-secret witness METADATA.
// No server runtime imports this file. A workflow artifact and GitHub job
// output are NOT independent WORM custody, off-host DB restore, or KMS.
const FORMAT="orbicore:ci:cross-runner-witness:v1";
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KID=/^[a-z][a-z0-9_-]{1,31}$/;
const HEX=/^[0-9a-f]{64}$/;
const B64URL=/^[A-Za-z0-9_-]{1,2000}$/;
const EVENTS=["password_reset","disabled","mfa_enrolled","role_revoked"];
const SOURCE_KEYS=["organization_id","user_id","epoch"];
const EVENT_KEYS=["organization_id","user_id","source_epoch",
  "event_id","origin_key_id","origin_mac","actor_id","reason"];
const WITNESS_KEYS=["organization_id","user_id","source_epoch",
  "event_id","origin_key_id","origin_mac","actor_id"];
const ENVELOPE_KEYS=["format","sequence","snapshot",
  "publicKeySpki","signature"];
const SNAPSHOT_KEYS=["sourceUsers","sourceEvents","witnessRows"];

export function requireCiCrossRunnerEvidence(){
  if(process.env.GITHUB_ACTIONS!=="true" ||
     process.env.ORBICORE_CI_SYNTHETIC_CROSS_RUNNER!=="1")
    throw new Error("ci_cross_runner_evidence_explicit_gate_required");
}
function exactKeys(value,expected){
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const keys=Object.keys(value).sort();
  return keys.length===expected.length &&
    keys.every((x,i)=>x===expected.slice().sort()[i]);
}
function byIdentifier(row){
  return JSON.stringify([row.organization_id,row.user_id,row.source_epoch??row.epoch]);
}
function requireSnapshot(raw){
  if(!exactKeys(raw,SNAPSHOT_KEYS) ||
     !Array.isArray(raw.sourceUsers)||!Array.isArray(raw.sourceEvents)||
     !Array.isArray(raw.witnessRows)||
     raw.sourceUsers.length<1||raw.sourceUsers.length>1000 ||
     raw.sourceEvents.length<1||raw.sourceEvents.length>5000 ||
     raw.witnessRows.length!==raw.sourceEvents.length)
    throw new Error("ci_evidence_snapshot_invalid");
  const users=raw.sourceUsers.map(u=>{
    if(!exactKeys(u,SOURCE_KEYS) ||
       !ID.test(u.organization_id)||!ID.test(u.user_id)||
       !Number.isSafeInteger(u.epoch)||u.epoch<1||u.epoch>100000)
      throw new Error("ci_evidence_source_user_invalid");
    return {...u};
  });
  const source=raw.sourceEvents.map(e=>{
    if(!exactKeys(e,EVENT_KEYS)||
       !ID.test(e.organization_id)||!ID.test(e.user_id)||
       !ID.test(e.actor_id)||!HEX.test(e.event_id) ||
       !HEX.test(e.origin_mac)||!KID.test(e.origin_key_id) ||
       !EVENTS.includes(e.reason) ||
       !Number.isSafeInteger(e.source_epoch)||e.source_epoch<2||
       e.source_epoch>100000)
      throw new Error("ci_evidence_event_invalid");
    return {...e};
  });
  const witness=raw.witnessRows.map(w=>{
    if(!exactKeys(w,WITNESS_KEYS)||
       !ID.test(w.organization_id)||!ID.test(w.user_id)||
       !ID.test(w.actor_id)||!HEX.test(w.event_id) ||
       !HEX.test(w.origin_mac)||!KID.test(w.origin_key_id)||
       !Number.isSafeInteger(w.source_epoch)||w.source_epoch<2||
       w.source_epoch>100000)
      throw new Error("ci_evidence_witness_invalid");
    return {...w};
  });
  const userMap=new Map();
  for(const u of users){
    const key=JSON.stringify([u.organization_id,u.user_id]);
    if(userMap.has(key))throw new Error("ci_evidence_duplicate_user");
    userMap.set(key,u);
  }
  const eventMap=new Map(),eventIds=new Set(),witnessIds=new Set();
  for(const e of source){
    const key=byIdentifier(e);
    if(eventMap.has(key)||eventIds.has(e.event_id)||
       !userMap.has(JSON.stringify([e.organization_id,e.user_id])))
      throw new Error("ci_evidence_duplicate_or_orphan_event");
    eventMap.set(key,e);eventIds.add(e.event_id);
  }
  for(const w of witness){
    const e=eventMap.get(byIdentifier(w));
    if(!e||witnessIds.has(w.event_id)||
       WITNESS_KEYS.some(k=>w[k]!==e[k]))
      throw new Error("ci_evidence_witness_mismatch");
    witnessIds.add(w.event_id);
  }
  let expected=0;
  for(const u of users){
    for(let ep=2;ep<=u.epoch;ep++){
      expected++;
      const key=JSON.stringify([u.organization_id,u.user_id,ep]);
      if(!eventMap.has(key))throw new Error("ci_evidence_epoch_gap");
    }
  }
  if(expected!==source.length)
    throw new Error("ci_evidence_epoch_count_mismatch");
  const sorted=(arr)=>arr.sort((a,b)=>{
    const ak=byIdentifier(a),bk=byIdentifier(b);
    return ak<bk?-1:ak>bk?1:0;
  });
  return {sourceUsers:sorted(users),sourceEvents:sorted(source),
    witnessRows:sorted(witness)};
}
function sha(data){
  return createHash("sha256").update(data).digest("hex");
}
function bytes(e){
  return Buffer.from(JSON.stringify([FORMAT,e.sequence,e.snapshot]));
}
function equalHex(a,b){
  if(typeof a!=="string"||typeof b!=="string"||
     !HEX.test(a)||!HEX.test(b))return false;
  return timingSafeEqual(Buffer.from(a,"hex"),Buffer.from(b,"hex"));
}
export function createCiCrossRunnerEvidence({
  snapshot,sequence=7,
}={}){
  requireCiCrossRunnerEvidence();
  if(!Number.isSafeInteger(sequence)||sequence<1||sequence>10000000)
    throw new TypeError("ci_evidence_sequence_invalid");
  const normalized=requireSnapshot(snapshot);
  const pair=generateKeyPairSync("ed25519");
  // Private signing key is used in memory and NEVER exported or serialized.
  const pub=pair.publicKey.export({format:"der",type:"spki"});
  const envelope={
    format:FORMAT,sequence,snapshot:normalized,
    publicKeySpki:pub.toString("base64url"),
    signature:"",
  };
  envelope.signature=sign(null,bytes(envelope),pair.privateKey)
    .toString("base64url");
  const publicKeySha256=sha(pub);
  return Object.freeze({envelope:Object.freeze(envelope),
    publicKeySha256,
    envelopeSha256:sha(Buffer.from(JSON.stringify(envelope))),
    sequence});
}
export function verifyCiCrossRunnerEvidence({
  envelope,publicKeySha256,envelopeSha256,
  minimumSequence,expectedSequence,
}={}){
  requireCiCrossRunnerEvidence();
  try{
    if(!exactKeys(envelope,ENVELOPE_KEYS) ||
       envelope.format!==FORMAT ||
       !Number.isSafeInteger(envelope.sequence)||
       !Number.isSafeInteger(minimumSequence)||
       !Number.isSafeInteger(expectedSequence)||
       envelope.sequence<minimumSequence||
       envelope.sequence!==expectedSequence ||
       !B64URL.test(envelope.publicKeySpki??"")||
       !B64URL.test(envelope.signature??"")||
       !HEX.test(publicKeySha256??"")||
       !HEX.test(envelopeSha256??""))
      return false;
    const pub=Buffer.from(envelope.publicKeySpki,"base64url");
    const signature=Buffer.from(envelope.signature,"base64url");
    if(pub.length<32||pub.length>300||signature.length!==64 ||
       !equalHex(sha(pub),publicKeySha256)||
       !equalHex(sha(Buffer.from(JSON.stringify(envelope))),
         envelopeSha256))return false;
    const normalized=requireSnapshot(envelope.snapshot);
    // Reject noncanonical snapshots; never normalize away signed ambiguity.
    if(JSON.stringify(normalized)!==JSON.stringify(envelope.snapshot))
      return false;
    const publicKey=createPublicKey({
      key:pub,format:"der",type:"spki",
    });
    if(publicKey.asymmetricKeyType!=="ed25519")return false;
    return verify(null,bytes(envelope),publicKey,signature);
  }catch{return false}
}

export function restoreCiCrossRunnerMetadata({
  sqlite,envelope,publicKeySha256,envelopeSha256,expectedSequence,
  injectRollback=false,
}={}){
  requireCiCrossRunnerEvidence();
  if(!sqlite||typeof sqlite.exec!=="function"||
     typeof sqlite.prepare!=="function"||
     !verifyCiCrossRunnerEvidence({
       envelope,publicKeySha256,envelopeSha256,expectedSequence,
       minimumSequence:expectedSequence,
     }))
    throw new Error("ci_recovery_evidence_untrusted");
  let opened=false;
  try{
    sqlite.exec("PRAGMA foreign_keys=ON");
    sqlite.exec("BEGIN IMMEDIATE");opened=true;
    sqlite.exec(`
      CREATE TABLE ci_recovered_epochs(
        organization_id TEXT NOT NULL,user_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        PRIMARY KEY(organization_id,user_id)
      );
      CREATE TABLE ci_recovered_events(
        organization_id TEXT NOT NULL,user_id TEXT NOT NULL,
        source_epoch INTEGER NOT NULL,event_id TEXT NOT NULL UNIQUE,
        origin_key_id TEXT NOT NULL,origin_mac TEXT NOT NULL,
        actor_id TEXT NOT NULL,reason TEXT NOT NULL,
        PRIMARY KEY(organization_id,user_id,source_epoch),
        FOREIGN KEY(organization_id,user_id) REFERENCES ci_recovered_epochs
          (organization_id,user_id)
      );
      CREATE TABLE ci_recovered_witnesses(
        organization_id TEXT NOT NULL,user_id TEXT NOT NULL,
        source_epoch INTEGER NOT NULL,event_id TEXT NOT NULL UNIQUE,
        origin_key_id TEXT NOT NULL,origin_mac TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        PRIMARY KEY(organization_id,user_id,source_epoch),
        FOREIGN KEY(organization_id,user_id,source_epoch)
          REFERENCES ci_recovered_events
          (organization_id,user_id,source_epoch)
      );
    `);
    const insertEpoch=sqlite.prepare(
      "INSERT INTO ci_recovered_epochs VALUES(?,?,?)");
    const insertEvent=sqlite.prepare(
      "INSERT INTO ci_recovered_events VALUES(?,?,?,?,?,?,?,?)");
    const insertWitness=sqlite.prepare(
      "INSERT INTO ci_recovered_witnesses VALUES(?,?,?,?,?,?,?)");
    const snap=envelope.snapshot;
    for(const u of snap.sourceUsers)
      insertEpoch.run(u.organization_id,u.user_id,u.epoch);
    for(const e of snap.sourceEvents)
      insertEvent.run(e.organization_id,e.user_id,e.source_epoch,
        e.event_id,e.origin_key_id,e.origin_mac,e.actor_id,e.reason);
    if(injectRollback)
      throw new Error("ci_recovery_injected_rollback");
    for(const w of snap.witnessRows)
      insertWitness.run(w.organization_id,w.user_id,w.source_epoch,
        w.event_id,w.origin_key_id,w.origin_mac,w.actor_id);
    sqlite.exec("COMMIT");opened=false;
    return Object.freeze({
      fixtureMetadataRecovered:true,
      users:snap.sourceUsers.length,
      sourceEvents:snap.sourceEvents.length,
      witnesses:snap.witnessRows.length,
      productionLoginAuthorized:false,
    });
  }catch{
    if(opened)try{sqlite.exec("ROLLBACK")}catch{/* fail closed */}
    throw new Error("ci_recovery_metadata_unavailable");
  }
}
