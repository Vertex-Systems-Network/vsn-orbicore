import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

test("knowledge-bank schemas, record IDs, test links, and local paths validate", () => {
  const output = execFileSync(process.execPath, ["scripts/validate-banks.mjs"], { encoding: "utf8" });
  assert.match(output, /Validated \d+ knowledge-bank records against 6 JSON Schemas/);
});
