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

test("ORB-002 malformed UAPI error metadata cannot grant capability or inventory evidence", async () => {
  const marker = "fixture-provider-error-marker";
  const connection = { host: "cp.example.org", username: "fixture-user", apiToken: "fixture-only-token", authorized: true };
  for (const errors of [marker, "", false, true, 0, 1, { detail: marker }]) {
    for (const wrapped of [false, true]) {
      const result = { status: 1, errors, data: { main_domain: { domain: "fixture.example" } } };
      const payload = wrapped ? { result } : result;
      const adapter = new LiveCpanelAdapterBoundary({ fetchImpl: async () => new Response(JSON.stringify(payload)) });
      const capabilities = await adapter.discoverCapabilities(connection);
      assert.deepEqual(capabilities, { ok: false, live: true, error: "invalid_uapi_response" });
      const inventory = await adapter.fetchInventory(connection);
      assert.equal(inventory.ok, false);
      assert.equal(inventory.error, "invalid_uapi_response");
      assert.deepEqual(inventory.sites, []);
      assert.equal(JSON.stringify(inventory).includes(marker), false);
      const health = await adapter.healthCheck(connection);
      assert.equal(health.status, "disabled");
      assert.equal(health.error, "invalid_uapi_response");
    }
  }
  for (const errors of [undefined, null, []]) {
    const adapter = new LiveCpanelAdapterBoundary({ fetchImpl: async () => new Response(JSON.stringify({ status: 1, errors, data: {} })) });
    assert.equal((await adapter.discoverCapabilities(connection)).ok, true);
  }
  const denied = new LiveCpanelAdapterBoundary({ fetchImpl: async () => new Response(JSON.stringify({ status: 1, errors: [marker], data: {} })) });
  assert.deepEqual(await denied.discoverCapabilities(connection), { ok: false, live: true, error: "uapi_call_failed", messagesCount: 1 });
});

test("ORB-002 synthetic adapter does not resolve inherited properties as capability profiles", () => {
  const adapter = createMockCpanelAdapter({});
  for (const capabilityProfile of ["constructor", "__proto__", "toString", null, 1, {}, []]) {
    const snapshot = adapter.discoverCapabilities({ accountId: "fixture", label: "Fixture", capabilityProfile });
    assert.equal(snapshot.profileName, "cpanel_uapi_standard");
    assert.deepEqual(snapshot.capabilities, CAPABILITY_PROFILES.cpanel_uapi_standard);
    assert.equal(snapshot.live, false);
  }
});
