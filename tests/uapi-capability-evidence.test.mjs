import assert from "node:assert/strict";
import { test } from "node:test";
import { LiveCpanelAdapterBoundary, createMockCpanelAdapter } from "../apps/api/cpanel-adapter.mjs";
import { CAPABILITY_PROFILES } from "../apps/api/security.mjs";

const ref = { host: "cp.example.org", username: "fixture-owner",
  apiToken: "never-networked-ci-placeholder-secret", authorized: true };

test("ORB-002 quota-only UAPI success does not grant unrelated capabilities", async () => {
  const calls = [];
  const mockBefore = structuredClone(CAPABILITY_PROFILES.cpanel_uapi_standard);
  const adapter = new LiveCpanelAdapterBoundary({
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method });
      return new Response(JSON.stringify({ status: 1, data: {} }));
    },
  });
  const result = await adapter.discoverCapabilities(ref);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ url: "https://cp.example.org:2083/execute/Quota/get_quota_info", method: "GET" }]);
  assert.equal(result.capabilities.length, mockBefore.length);
  assert.deepEqual(result.capabilities.filter(c => c.level !== "unknown").map(c => [c.capability, c.level]),
    [["quotas.read", "read_only"]]);
  assert.equal(result.capabilities.some(c => c.level === "supported"), false);
  assert.equal(JSON.stringify(result).includes(ref.apiToken), false);
  assert.deepEqual(CAPABILITY_PROFILES.cpanel_uapi_standard, mockBefore);
  const mock = createMockCpanelAdapter({}).discoverCapabilities({ accountId: "fixture", label: "Fixture" });
  assert.deepEqual(mock.capabilities, mockBefore);
  assert.equal(mock.live, false);
});

test("ORB-002 denied or malformed quota response yields no capability snapshot", async () => {
  for (const [status, payload, error] of [
    [403, { status: 0 }, "revoked_or_denied_token"],
    [200, { status: 0 }, "uapi_call_failed"],
    [200, { data: {} }, "invalid_uapi_response"],
  ]) {
    const adapter = new LiveCpanelAdapterBoundary({
      fetchImpl: async () => new Response(JSON.stringify(payload), { status }),
    });
    const result = await adapter.discoverCapabilities(ref);
    assert.equal(result.ok, false);
    assert.equal(result.error, error);
    assert.equal(result.capabilities, undefined);
    assert.equal(JSON.stringify(result).includes(ref.apiToken), false);
  }
});
