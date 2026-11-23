import assert from "node:assert/strict";
import { test } from "node:test";
import { LiveCpanelAdapterBoundary } from "../apps/api/cpanel-adapter.mjs";

const ref = {
  host: "cp.example.org",
  username: "synthetic-owner",
  apiToken: "never-networked-ci-placeholder-secret",
  authorized: true,
};
function fixtureAdapter(data) {
  return new LiveCpanelAdapterBoundary({
    fetchImpl: async (_url, init) => {
      assert.equal(init.redirect, "manual");
      assert.equal(init.method, "GET");
      return new Response(JSON.stringify({ status: 1, data }), { status: 200 });
    },
  });
}

test("ORB-006 malformed HTTP-200 UAPI domain inventory fails closed instead of falsely reporting zero sites", async () => {
  for (const data of [
    null,
    {},
    [],
    { main_domain: "agency.example.org" },
    { main_domain: { documentroot: "/home/test" } },
    { main_domain: { domain: "" } },
    { main_domain: { domain: "agency.example.org" }, addon_domains: "not-an-array" },
    { main_domain: { domain: "agency.example.org" }, sub_domains: { wrong: "type" } },
    { main_domain: { domain: "agency.example.org" }, addon_domains: [null] },
    { main_domain: { domain: "agency.example.org" }, sub_domains: [{ domain: 123 }] },
  ]) {
    const result = await fixtureAdapter(data).fetchInventory(ref);
    assert.equal(result.ok, false, JSON.stringify(data));
    assert.equal(result.error, "invalid_uapi_inventory_response");
    assert.deepEqual(result.sites, []);
    assert.equal(JSON.stringify(result).includes(ref.apiToken), false);
  }
});

test("ORB-006 valid UAPI inventory preserves real metadata and labels omissions as unknown, never fabricated paths", async () => {
  const data = {
    main_domain: {
      domain: "agency.example.org",
      type: "main_domain",
      documentroot: "/home/agency/public_html",
      phpversion: "8.3",
    },
    addon_domains: [
      { domain: "shop.agency.example.org", type: "addon_domain" },
    ],
    sub_domains: [],
  };
  const result = await fixtureAdapter(data).fetchInventory(ref);
  assert.equal(result.ok, true);
  assert.equal(result.sites.length, 2);
  assert.deepEqual(result.sites[0], {
    domain: "agency.example.org",
    documentRoot: "/home/agency/public_html",
    phpVersion: "8.3",
    metadataComplete: true,
    kind: "Primary",
  });
  assert.deepEqual(result.sites[1], {
    domain: "shop.agency.example.org",
    documentRoot: null,
    phpVersion: null,
    metadataComplete: false,
    kind: "Domain",
  });
  assert.equal(JSON.stringify(result).includes(ref.apiToken), false);
});
