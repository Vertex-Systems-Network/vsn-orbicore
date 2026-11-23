import assert from "node:assert/strict";
import { test } from "node:test";
import { isBlockedNetworkAddress, validateExternalEndpoint } from "../apps/api/security.mjs";

test("ORB-010 absolute DNS root-dot and IDNA dot spellings do not bypass local hostname guard", () => {
  const blocked = [
    "localhost.",
    "app.localhost.",
    "svc.local.",
    "metadata.google.internal.",
    "localhost.localdomain.",
    "app.localhost\u3002",
    "svc.local\uFF0E",
    "metadata.google.internal\uFF61",
    "127.0.0.1.",
    "169.254.169.254.",
  ];
  for (const hostname of blocked) {
    assert.equal(isBlockedNetworkAddress(hostname), true, hostname);
    const result = validateExternalEndpoint(`https://${hostname}:2083/execute/DomainInfo/domains_data`);
    assert.equal(result.valid, false, hostname);
    assert.equal(result.reason, "blocked_private_or_loopback_host", hostname);
  }
});

test("ORB-010 ordinary absolute public hostnames and literal IPv6 remain unchanged", () => {
  assert.equal(isBlockedNetworkAddress("example.org."), false);
  assert.equal(validateExternalEndpoint("https://api.example.org.:2083/").valid, true);
  assert.equal(validateExternalEndpoint("https://example.org:2083/").valid, true);
  assert.equal(isBlockedNetworkAddress("2001:4860:4860::8888"), false);
  assert.equal(validateExternalEndpoint("https://[2001:4860:4860::8888]:2083/").valid, true);
  assert.equal(isBlockedNetworkAddress("."), true);
});
