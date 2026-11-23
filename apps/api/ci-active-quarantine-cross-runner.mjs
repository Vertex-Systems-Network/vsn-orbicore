import {
  createHash, createPublicKey, generateKeyPairSync, randomBytes,
  sign, verify, timingSafeEqual,
} from "node:crypto";

// CI fixture-only. No job payload, credentials or executable work are exported.
// The signer private key is intentionally used in memory and never exported.
const FORMAT = "orbicore_ci_active_quarantine_ed25519_v1";
const CONSENT = "ci_fixture_active_jobs_quarantine_no_replay";
const KEYS = ["format","runId","headSha","nonce","sequence","rows","publicKeySpki","signature"];
const ROW_KEYS = ["id","organizationId","accountId","requestedBy","status","idempotencyKey","createdAt","startedAt","digest"];
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const HEX40 = /^[a-f0-9]{40}$/;
const HEX32 = /^[a-f0-9]{32}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const sameKeys = (object, keys) =>
  object && typeof object === "object" && !Array.isArray(object) &&
  Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object,key));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const iso = value => typeof value === "string" && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const equalHex = (a,b) => typeof a === "string" && typeof b === "string" &&
  HEX64.test(a) && HEX64.test(b) &&
  timingSafeEqual(Buffer.from(a,"hex"),Buffer.from(b,"hex"));

function validateRows(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 20) {
    throw new Error("ci_quarantine_attestation_rows_invalid");
  }
  const ids = new Set(), scopedKeys = new Set();
  for (const row of rows) {
    const prefix = typeof row?.organizationId === "string" ? row.organizationId + ":" : "";
    if (!sameKeys(row,ROW_KEYS) || !ID.test(row.id) ||
      !ID.test(row.organizationId) || !ID.test(row.accountId) ||
      !ID.test(row.requestedBy) || !["queued","running"].includes(row.status) ||
      typeof row.idempotencyKey !== "string" ||
      !row.idempotencyKey.startsWith(prefix) ||
      !/^ci-queue-[A-Za-z0-9._:-]{1,100}$/.test(row.idempotencyKey.slice(prefix.length)) ||
      !iso(row.createdAt) || !(row.startedAt === null || iso(row.startedAt)) ||
      (row.status === "queued" && row.startedAt !== null) ||
      (row.status === "running" &&
        (row.startedAt === null || row.startedAt < row.createdAt)) ||
      !HEX64.test(row.digest)) {
      throw new Error("ci_quarantine_attestation_rows_invalid");
    }
    const plain = {
      id:row.id,organizationId:row.organizationId,accountId:row.accountId,
      requestedBy:row.requestedBy,status:row.status,
      idempotencyKey:row.idempotencyKey,
      createdAt:row.createdAt,startedAt:row.startedAt,
    };
    if (!equalHex(sha256(JSON.stringify(plain)),row.digest)) {
      throw new Error("ci_quarantine_attestation_digest_invalid");
    }
    const scoped = row.organizationId+"\0"+row.idempotencyKey;
    if (ids.has(row.id) || scopedKeys.has(scoped)) {
      throw new Error("ci_quarantine_attestation_duplicate_row");
    }
    ids.add(row.id); scopedKeys.add(scoped);
  }
  const ordered = [...rows].sort((a,b)=>a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (rows.some((row,i)=>ordered[i] !== row)) {
    throw new Error("ci_quarantine_attestation_noncanonical_order");
  }
  return rows;
}
const signedBytes = x => Buffer.from(JSON.stringify([
  x.format,x.runId,x.headSha,x.nonce,x.sequence,x.rows,
]));
export function createCiActiveQuarantineAttestation({
  rows,runId,headSha,nonce=randomBytes(16).toString("hex"),sequence=1,
  consent=null,
}={}) {
  if (consent !== CONSENT || !/^[1-9][0-9]{0,19}$/.test(runId??"") ||
    !HEX40.test(headSha??"") || !HEX32.test(nonce??"") ||
    sequence !== 1) throw new Error("ci_quarantine_attestation_scope_invalid");
  validateRows(rows);
  const keys = generateKeyPairSync("ed25519");
  const pub = keys.publicKey.export({format:"der",type:"spki"});
  const envelope = {
    format:FORMAT,runId,headSha,nonce,sequence,rows,
    publicKeySpki:pub.toString("base64url"),signature:"",
  };
  envelope.signature = sign(null,signedBytes(envelope),keys.privateKey).toString("base64url");
  return Object.freeze({
    envelope:Object.freeze(envelope),
    publicKeySha256:sha256(pub),
    envelopeSha256:sha256(JSON.stringify(envelope)),
    sequence,
    count:rows.length,
  });
}

export function verifyCiActiveQuarantineAttestation({
  envelope,publicKeySha256,envelopeSha256,
  expectedRunId,expectedHeadSha,expectedSequence,expectedCount,
}={}) {
  try {
    if (!sameKeys(envelope,KEYS) || envelope.format !== FORMAT ||
      envelope.runId !== expectedRunId || !/^[1-9][0-9]{0,19}$/.test(expectedRunId??"") ||
      !HEX40.test(expectedHeadSha??"") || envelope.headSha !== expectedHeadSha ||
      !HEX32.test(envelope.nonce??"") || envelope.sequence !== 1 ||
      expectedSequence !== 1 || envelope.rows?.length !== expectedCount ||
      !Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 20 ||
      !B64URL.test(envelope.publicKeySpki??"") ||
      !B64URL.test(envelope.signature??"") ||
      !HEX64.test(publicKeySha256??"") || !HEX64.test(envelopeSha256??""))
      return false;
    const pub = Buffer.from(envelope.publicKeySpki,"base64url");
    const sig = Buffer.from(envelope.signature,"base64url");
    if (pub.length < 32 || pub.length > 300 || sig.length !== 64 ||
      !equalHex(sha256(pub),publicKeySha256) ||
      !equalHex(sha256(JSON.stringify(envelope)),envelopeSha256))
      return false;
    validateRows(envelope.rows);
    const key = createPublicKey({key:pub,format:"der",type:"spki"});
    if (key.asymmetricKeyType !== "ed25519") return false;
    return verify(null,signedBytes(envelope),key,sig);
  } catch { return false; }
}
