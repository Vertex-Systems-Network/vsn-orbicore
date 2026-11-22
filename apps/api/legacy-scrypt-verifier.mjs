import { scryptSync, timingSafeEqual } from "node:crypto";

// ORB-005 migration preparation only. Do not wire this module into production
// authentication, shadow writes, sessions or PostgreSQL authority until the
// independent credential-transition/rollback gates in ADR-0003 pass.
//
// SQLite legacy records generated salt = randomBytes(16).toString("hex"),
// then scryptSync(password, salt /* UTF-8 text, NOT decoded hex */, 64).
// Node.js 24 defaults are pinned here so a future runtime upgrade cannot
// silently reinterpret the stored verifier. These weakly parameterized
// historical records are NOT the profile for new PostgreSQL credentials.
const SALT = /^[0-9a-f]{32}$/;
const HASH = /^[0-9a-f]{128}$/;

export const LEGACY_SQLITE_SCRYPT_PROFILE = Object.freeze({
  version: "sqlite-v7-scrypt-node-default",
  keyLength: 64,
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 32 * 1024 * 1024,
});

export function isLegacySqliteScryptRecord({ passwordSalt, passwordHash } = {}) {
  return typeof passwordSalt === "string" &&
    SALT.test(passwordSalt) &&
    typeof passwordHash === "string" &&
    HASH.test(passwordHash);
}

// Checks a record locally without ever returning the computed verifier.
// Requiring exact stored shapes avoids accidental acceptance of Node's
// permissive Buffer.from(hex) decoding of malformed/truncated hash material.
//
// This is NOT an HTTP credential-check path: unknown-user timing camouflage,
// tenant resolution, throttling and login-failure audit must be supplied at
// the trusted auth boundary before this may be used with real identities.
export function verifyLegacySqliteScryptPassword({
  password, passwordSalt, passwordHash,
} = {}) {
  if (typeof password !== "string" || password.length > 256 ||
      !isLegacySqliteScryptRecord({ passwordSalt, passwordHash })) {
    return false;
  }
  const candidate = scryptSync(
    password,
    passwordSalt, // legacy intentionally uses the ASCII hex characters
    LEGACY_SQLITE_SCRYPT_PROFILE.keyLength,
    {
      N: LEGACY_SQLITE_SCRYPT_PROFILE.N,
      r: LEGACY_SQLITE_SCRYPT_PROFILE.r,
      p: LEGACY_SQLITE_SCRYPT_PROFILE.p,
      maxmem: LEGACY_SQLITE_SCRYPT_PROFILE.maxmem,
    },
  );
  return timingSafeEqual(candidate, Buffer.from(passwordHash, "hex"));
}
