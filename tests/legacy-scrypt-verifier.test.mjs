import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { test } from "node:test";
import {
  LEGACY_SQLITE_SCRYPT_PROFILE,
  isLegacySqliteScryptRecord,
  verifyLegacySqliteScryptPassword,
} from "../apps/api/legacy-scrypt-verifier.mjs";

const VECTORS = Object.freeze([
  Object.freeze({
    password: "local-password-74",
    passwordSalt: "0123456789abcdef0123456789abcdef",
    // Independent Python/OpenSSL hashlib.scrypt vector with UTF-8 text salt.
    passwordHash: "62d8ce7d6bb761b15f3338ff5de40e264b270fc3cc341af4e55799621a6af6f7f45ec1d2370746e22deb3e72627db945f5da51749c1c468ea1d26c3e3c30440c",
  }),
  Object.freeze({
    password: "pässwörd-🔐-مرحبا",
    passwordSalt: "fedcba9876543210fedcba9876543210",
    passwordHash: "38a779812f9b871a3e9110d6ccc2f6901173eb54469d903b5083b9489fb2b7868e08aaa072ca91eeaf86ffff8022c591bd92080602a2948172adc041675e1f0f",
  }),
  Object.freeze({
    password: "",
    passwordSalt: "00000000000000000000000000000000",
    passwordHash: "7162679c9724ce7ff8f82cb362fc34448e6265c09d2adc1c738056e3cfa2216cc64707d38e7cbdca9b7b790c2068f8ba09cf6812c02e477206ef801bc97e6975",
  }),
]);

test("ORB-005: legacy SQLite scrypt defaults are explicitly pinned", () => {
  assert.deepEqual(LEGACY_SQLITE_SCRYPT_PROFILE, {
    version: "sqlite-v7-scrypt-node-default",
    keyLength: 64, N: 16384, r: 8, p: 1,
    maxmem: 32 * 1024 * 1024,
  });
});

test("ORB-005: fixed independent ASCII/Unicode/empty password vectors match Node legacy", () => {
  for (const record of VECTORS) {
    assert.equal(
      scryptSync(record.password, record.passwordSalt, 64).toString("hex"),
      record.passwordHash,
    );
    assert.equal(isLegacySqliteScryptRecord(record), true);
    assert.equal(verifyLegacySqliteScryptPassword(record), true);
  }
});

test("ORB-005: historical salt is the hex *text*, not the decoded 16-byte salt", () => {
  const record = VECTORS[0];
  assert.notEqual(
    scryptSync(record.password, Buffer.from(record.passwordSalt, "hex"), 64)
      .toString("hex"),
    record.passwordHash,
  );
});

test("ORB-005: malformed/truncated verifier and invalid salt fail closed", () => {
  const valid = VECTORS[0];
  const invalidRecords = [
    { passwordSalt: "", passwordHash: valid.passwordHash },
    { passwordSalt: "not-a-salt", passwordHash: valid.passwordHash },
    { passwordSalt: valid.passwordSalt.toUpperCase(), passwordHash: valid.passwordHash },
    { passwordSalt: valid.passwordSalt + "00", passwordHash: valid.passwordHash },
    { passwordSalt: valid.passwordSalt, passwordHash: valid.passwordHash.slice(0, -2) },
    { passwordSalt: valid.passwordSalt, passwordHash: valid.passwordHash.toUpperCase() },
    { passwordSalt: valid.passwordSalt, passwordHash: valid.passwordHash + "00" },
    { passwordSalt: valid.passwordSalt, passwordHash: "z".repeat(128) },
    { passwordSalt: valid.passwordSalt, passwordHash: null },
  ];
  for (const record of invalidRecords) {
    assert.equal(isLegacySqliteScryptRecord(record), false);
    assert.equal(verifyLegacySqliteScryptPassword({
      password: valid.password, ...record,
    }), false);
  }
});

test("ORB-005: wrong password, wrong record and invalid input types never authenticate", () => {
  const valid = VECTORS[0];
  assert.equal(verifyLegacySqliteScryptPassword({
    ...valid, password: "wrong-password",
  }), false);
  assert.equal(verifyLegacySqliteScryptPassword({
    ...valid, passwordHash: VECTORS[1].passwordHash,
  }), false);
  for (const password of [null, undefined, 1, {}, [], "x".repeat(257)]) {
    assert.equal(verifyLegacySqliteScryptPassword({ ...valid, password }), false);
  }
  assert.equal(verifyLegacySqliteScryptPassword({}), false);
  assert.equal(isLegacySqliteScryptRecord(), false);
});

test("ORB-005: migration verifier returns a boolean only, never a derived hash", () => {
  const accepted = verifyLegacySqliteScryptPassword(VECTORS[1]);
  const denied = verifyLegacySqliteScryptPassword({
    ...VECTORS[1], password: "not-the-password",
  });
  assert.equal(typeof accepted, "boolean");
  assert.equal(typeof denied, "boolean");
  assert.equal(accepted, true);
  assert.equal(denied, false);
});
