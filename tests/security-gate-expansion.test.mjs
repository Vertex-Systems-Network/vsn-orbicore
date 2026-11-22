import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { isAllowedSpdxExpression, runSupplyChainGate } from "../scripts/security-gate.mjs";

function fixture(callback) {
  const root = mkdtempSync(join(tmpdir(), "orb-010-security-fixture-"));
  const write = (path, content) => {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  const setLicense = (license) => {
    const lock = {
      name: "test-supply-chain",
      version: "0.1.0",
      lockfileVersion: 3,
      packages: {
        "": { name: "test-supply-chain", version: "0.1.0" },
        "node_modules/dummy-lib": { version: "1.0.0", license },
      },
    };
    write("package-lock.json", JSON.stringify(lock));
  };
  try {
    write("package.json", '{"name":"test-supply-chain","version":"0.1.0","private":true}');
    setLicense("MIT");
    return callback({ root, write, setLicense });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("ORB-010: SPDX AND requires every term; OR accepts one full branch; unsupported/malformed fails closed", () => {
  for (const allowed of [
    "MIT", "MIT OR GPL-3.0", "(Apache-2.0 OR MIT) AND ISC",
    "GPL-3.0 OR (MIT AND BSD-3-Clause)",
  ]) assert.equal(isAllowedSpdxExpression(allowed), true, allowed);
  for (const rejected of [
    "MIT AND GPL-3.0", "(MIT OR ISC) AND GPL-3.0", "GPL-3.0",
    "MIT WITH Classpath-exception-2.0", "MIT AND", "OR MIT",
    "(MIT OR ISC", "MIT OR ISC)", "MIT; GPL-3.0", "", null,
  ]) assert.equal(isAllowedSpdxExpression(rejected), false, String(rejected));
  fixture(({ root, setLicense }) => {
    setLicense("MIT AND GPL-3.0");
    const denied = runSupplyChainGate(root);
    assert.equal(denied.passed, false);
    assert.deepEqual(denied.disallowedLicenses, [
      { name: "dummy-lib", version: "1.0.0", license: "MIT AND GPL-3.0" },
    ]);
    setLicense("MIT OR GPL-3.0");
    const permitted = runSupplyChainGate(root);
    assert.equal(permitted.passed, true);
  });
});

test("ORB-010: scope includes docs, root dotenv, workflow and service files; findings never include raw token", () => {
  fixture(({ root, write }) => {
    const githubPat = "gh" + "p_" + "A".repeat(40);
    const awsKey = "AK" + "IA" + "Q".repeat(16);
    const npmToken = "//registry.npmjs.org/:_authToken=" + "n".repeat(40);
    write("docs/OPERATION.md", "Bearer " + githubPat);
    write(".github/workflows/deploy.yml", "AWS_KEY=" + awsKey);
    write(".env.production", "NPM_CONFIG=" + npmToken);
    write("README.md", "Public documentation only");
    const report = runSupplyChainGate(root);
    assert.equal(report.passed, false);
    assert.equal(report.scanScope, "git-tracked-recognized-text-files");
    assert.ok(report.scannedFiles >= 6);
    assert.deepEqual(report.secretFindings, [
      { file: ".env.production", rule: "npm_auth_token" },
      { file: ".github/workflows/deploy.yml", rule: "aws_access_key" },
      { file: "docs/OPERATION.md", rule: "github_pat" },
    ]);
    const serialized = JSON.stringify(report);
    for (const value of [githubPat, awsKey, npmToken]) {
      assert.equal(serialized.includes(value), false, "do not leak credential values into logs");
    }
  });
});

test("ORB-010: generated assets and symlinks are not recursively scanned; oversized tracked text is denied", () => {
  fixture(({ root, write }) => {
    const awsKey = "AS" + "IA" + "A".repeat(16);
    write("node_modules/dependency/README.md", awsKey);
    write(".data/runtime/session.env", awsKey);
    write("dist/bundle.js", awsKey);
    const escapeFile = join(tmpdir(), "orb-010-untracked-private-placeholder");
    try {
      writeFileSync(escapeFile, awsKey);
      symlinkSync(escapeFile, join(root, "linked-secret.md"));
      assert.equal(runSupplyChainGate(root).passed, true,
        "untracked runtime files and external symlinks are outside committed CI scope");
    } finally {
      rmSync(join(root, "linked-secret.md"), { force: true });
      rmSync(escapeFile, { force: true });
    }
    write("README.md", "x".repeat(2 * 1024 * 1024 + 1));
    const denied = runSupplyChainGate(root);
    assert.equal(denied.passed, false);
    assert.deepEqual(denied.secretFindings, [
      { file: "README.md", rule: "source_file_exceeds_scan_limit" },
    ]);
  });
});
