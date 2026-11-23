import assert from "node:assert/strict";
import { test } from "node:test";
import {
  flipCiPgArchiveCiphertextByte,
  openCiPgArchive,
  sealCiPgArchive,
} from "../scripts/ci-pg-archive-envelope.mjs";

test("ORB-016 encrypted archive tamper fixture changes ciphertext even when original byte equals X", () => {
  const source = Buffer.alloc(64);
  Buffer.from("ORBICIB1").copy(source);
  source[39] = 0x58; // Exactly the old overwrite value: unchanged in the old test.
  const corrupted = flipCiPgArchiveCiphertextByte(source);
  assert.equal(source[39], 0x58);
  assert.equal(corrupted[39], 0x59);
  assert.notDeepEqual(corrupted, source);
  assert.throws(() => flipCiPgArchiveCiphertextByte(Buffer.from("too short")), /tamper_fixture_invalid/);
});

test("ORB-016 AES-GCM archive fixture rejects deterministic ciphertext bit flip, preserving original", () => {
  const oldActions = process.env.GITHUB_ACTIONS;
  const oldGate = process.env.ORBICORE_CI_PG_ISOLATED_RESTORE;
  process.env.GITHUB_ACTIONS = "true";
  process.env.ORBICORE_CI_PG_ISOLATED_RESTORE = "1";
  try {
    const keyHex = "ab".repeat(32);
    const plaintext = Buffer.from("synthetic-pg16-archive-fixture-never-a-real-backup");
    const sealed = sealCiPgArchive(plaintext, { keyHex, context: "database" });
    const corrupted = flipCiPgArchiveCiphertextByte(sealed);
    assert.deepEqual(openCiPgArchive(sealed, { keyHex, context: "database" }), plaintext);
    assert.throws(
      () => openCiPgArchive(corrupted, { keyHex, context: "database" }),
      /ci_pg_backup_envelope_rejected/,
    );
    assert.equal(sealed[39] ^ corrupted[39], 1);
  } finally {
    if (oldActions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = oldActions;
    if (oldGate === undefined) delete process.env.ORBICORE_CI_PG_ISOLATED_RESTORE;
    else process.env.ORBICORE_CI_PG_ISOLATED_RESTORE = oldGate;
  }
});
