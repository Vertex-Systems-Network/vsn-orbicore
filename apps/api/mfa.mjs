import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function encodeBase32(bytes) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(text) {
  let bits = 0;
  let value = 0;
  const output = [];
  for (const character of text.toUpperCase().replace(/=+$/g, "")) {
    const index = BASE32.indexOf(character);
    if (index < 0) throw new Error("Invalid base32 secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function totpAt(secret, epochSeconds, step = 30) {
  const counter = Math.floor(epochSeconds / step);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, "0");
}

export function verifyTotp(secret, code, nowMs = Date.now(), lastAcceptedStep = -1) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return null;
  const step = Math.floor(nowMs / 30_000);
  for (const candidateStep of [step, step - 1]) {
    if (candidateStep <= lastAcceptedStep) continue;
    const expected = totpAt(secret, candidateStep * 30);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return candidateStep;
  }
  return null;
}

export function mfaEncryptionKey(value = process.env.ORBICORE_MFA_ENCRYPTION_KEY) {
  if (typeof value !== "string") return null;
  try {
    const key = Buffer.from(value, "base64");
    return key.length === 32 && key.toString("base64") === value ? key : null;
  } catch {
    return null;
  }
}

export function parseMfaKeyring({ primary = process.env.ORBICORE_MFA_ENCRYPTION_KEY, previous = process.env.ORBICORE_MFA_PREVIOUS_KEYS, primaryId = process.env.ORBICORE_MFA_KEY_ID ?? "k1" } = {}) {
  const keys = new Map();
  const primaryKey = mfaEncryptionKey(primary);
  if (!primaryKey) return null;
  keys.set(primaryId, primaryKey);
  if (typeof previous === "string" && previous.trim()) {
    previous.split(",").map((item) => item.trim()).filter(Boolean).forEach((entry, index) => {
      const [maybeId, maybeValue] = entry.includes(":") ? entry.split(":", 2) : [`prev-${index + 1}`, entry];
      const parsed = mfaEncryptionKey(maybeValue);
      if (parsed && !keys.has(maybeId)) keys.set(maybeId, parsed);
    });
  }
  return { primaryId, primaryKey, keys };
}

export function encryptMfaSecret(secret, key, keyId = null) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const payload = [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
  return keyId ? `v1:${keyId}:${payload}` : payload;
}

export function decryptMfaSecret(value, keyOrKeyring) {
  let payload = value;
  let key = Buffer.isBuffer(keyOrKeyring) ? keyOrKeyring : keyOrKeyring?.primaryKey ?? null;
  if (value.startsWith("v1:")) {
    const parts = value.split(":");
    if (parts.length !== 3) throw new Error("Malformed versioned MFA secret");
    const [, keyId, body] = parts;
    payload = body;
    if (!Buffer.isBuffer(keyOrKeyring)) {
      key = keyOrKeyring?.keys?.get(keyId) ?? null;
    }
  }
  if (!key) throw new Error("Decryption key unavailable");
  const [ivText, tagText, dataText] = payload.split(".");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataText, "base64url")), decipher.final()]).toString("utf8");
}

export function decryptMfaSecretWithFallback(value, keyring) {
  if (!keyring) throw new Error("MFA keyring unavailable");
  if (value.startsWith("v1:")) return decryptMfaSecret(value, keyring);
  for (const candidate of keyring.keys.values()) {
    try {
      return decryptMfaSecret(value, candidate);
    } catch { /* try next key */ }
  }
  throw new Error("Unable to decrypt MFA secret with available keys");
}

export function newRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => randomBytes(16).toString("base64url").toUpperCase());
}

export const recoveryCodeHash = (code) => createHash("sha256").update(code.replaceAll("-", "").toUpperCase()).digest("hex");
