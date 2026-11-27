import assert from "node:assert/strict";
import { test } from "node:test";
import { LiveCpanelAdapterBoundary } from "../apps/api/cpanel-adapter.mjs";

const ref = { host: "cp.example.org", username: "fixture-owner",
  apiToken: "fixture-only-not-a-real-credential", authorized: true };

test("ORB-002 cPanel probe requires explicit boolean authorization before fetch", async () => {
  let calls = 0;
  const adapter = new LiveCpanelAdapterBoundary({
    fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({ status: 1, data: {} }));
    },
  });
  for (const authorized of [undefined, null, false, "false", "true", 1, [], {}]) {
    const result = await adapter.discoverCapabilities({ ...ref, authorized });
    assert.equal(result.ok, false);
    assert.equal(result.error, "live_credentials_not_authorized");
    assert.equal(result.capabilities, undefined);
  }
  assert.equal(calls, 0);
  assert.equal((await adapter.discoverCapabilities(ref)).ok, true);
  assert.equal(calls, 1);
});

test("ORB-002 cPanel rejects malformed credential header fields without echoing untrusted input", async () => {
  let calls = 0;
  const adapter = new LiveCpanelAdapterBoundary({
    fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({ status: 1, data: {} }));
    },
  });
  const marker = "untrusted-fixture-marker";
  for (const fields of [
    { username: {} }, { apiToken: [] }, { username: 123 },
    { username: " " }, { apiToken: " " }, { username: "bad:name" },
    { username: "bad name" }, { apiToken: "bad token" },
    { apiToken: "bad\r\nvalue" }, { username: "bad\u0000name" },
    { apiToken: null }, { username: "nonascii\u00e9" },
  ]) {
    const result = await adapter.discoverCapabilities({ ...ref, ...fields, host: marker });
    assert.equal(result.ok, false);
    assert.equal(result.error, "live_credentials_not_authorized");
    assert.equal(JSON.stringify(result).includes(marker), false);
    assert.equal(JSON.stringify(result).includes(ref.apiToken), false);
  }
  assert.equal(calls, 0);
  const denied = await adapter.discoverCapabilities({
    ...ref, authorized: false, host: { toString() { throw new Error("must not coerce"); } },
  });
  assert.equal(denied.error, "live_credentials_not_authorized");
});
