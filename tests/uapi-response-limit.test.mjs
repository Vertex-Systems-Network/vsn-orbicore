import assert from "node:assert/strict";
import { test } from "node:test";
import { LiveCpanelAdapterBoundary, MAX_UAPI_RESPONSE_BYTES } from "../apps/api/cpanel-adapter.mjs";

const ref = {
  host: "cp.example.org",
  username: "synthetic-user",
  apiToken: "no-network-secret-must-not-leak",
  authorized: true,
};

test("ORB-006 UAPI Content-Length over cap is rejected before consuming response body", async () => {
  let transmitted = 0;
  let called = 0;
  const adapter = new LiveCpanelAdapterBoundary({
    fetchImpl: async (url, init) => {
      called += 1;
      assert.equal(url, "https://cp.example.org:2083/execute/Quota/get_quota_info");
      assert.equal(init.redirect, "manual");
      return new Response(new ReadableStream({
        pull(controller) {
          transmitted += 1;
          controller.enqueue(Buffer.from('{"status":1}'));
          controller.close();
        },
      }), { status: 200, headers: { "content-length": String(MAX_UAPI_RESPONSE_BYTES + 1) } });
    },
  });
  const result = await adapter._callUapi(ref, "Quota", "get_quota_info");
  assert.equal(called, 1);
  assert.equal(result.ok, false);
  assert.equal(result.error, "uapi_response_too_large");
  assert.ok(transmitted <= 1);
  assert.equal(JSON.stringify(result).includes(ref.apiToken), false);
});

test("ORB-006 UAPI streamed bytes cap denies oversized body even if advertised length is tiny", async () => {
  let calls = 0;
  const streamed = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.alloc(MAX_UAPI_RESPONSE_BYTES - 16, 65));
      controller.enqueue(Buffer.alloc(128, 66));
      controller.close();
    },
  });
  const adapter = new LiveCpanelAdapterBoundary({
    fetchImpl: async () => {
      calls += 1;
      return new Response(streamed, { status: 200, headers: { "content-length": "1" } });
    },
  });
  const result = await adapter.fetchInventory(ref);
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.error, "uapi_response_too_large");
  assert.deepEqual(result.sites, []);
  assert.equal(JSON.stringify(result).includes(ref.apiToken), false);
});

test("ORB-006 UAPI small valid JSON, malformed UTF-8 and redirects keep independent fail-closed semantics", async () => {
  let body = new Response(JSON.stringify({ status: 1, data: { main_domain: { domain: "agency.example.org" } } }), { status: 200 });
  const adapter = new LiveCpanelAdapterBoundary({ fetchImpl: async () => body });
  const good = await adapter.fetchInventory(ref);
  assert.equal(good.ok, true);
  assert.equal(good.sites.length, 1);
  body = new Response(Uint8Array.from([0xff, 0xfe]), { status: 200 });
  const badUtf8 = await adapter.fetchInventory(ref);
  assert.equal(badUtf8.error, "invalid_uapi_response");
  body = new Response("{bad-json", { status: 200 });
  const badJson = await adapter.fetchInventory(ref);
  assert.equal(badJson.error, "invalid_uapi_response");
  body = new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
  const redirect = await adapter.fetchInventory(ref);
  assert.equal(redirect.error, "uapi_redirect_denied");
  assert.equal(JSON.stringify({ good, badUtf8, badJson, redirect }).includes(ref.apiToken), false);
});
