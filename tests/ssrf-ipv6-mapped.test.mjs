import assert from "node:assert/strict";
import { test } from "node:test";
import { isBlockedNetworkAddress, validateExternalEndpoint } from "../apps/api/security.mjs";

test("ORB-010 hex and expanded IPv4-mapped IPv6 cannot bypass network deny list", () => {
  const privateMapped = [
    "::ffff:7f00:1",          // 127.0.0.1
    "0:0:0:0:0:ffff:7f00:1", // same mapped loopback, expanded
    "::ffff:a00:1",           // 10.0.0.1
    "::ffff:ac10:1",          // 172.16.0.1
    "::ffff:c0a8:101",        // 192.168.1.1
    "::ffff:a9fe:a9fe",       // 169.254.169.254
    "::ffff:6440:1",          // 100.64.0.1
    "::ffff:127.0.0.1",       // dotted mapped input
  ];
  for (const literal of privateMapped) {
    assert.equal(isBlockedNetworkAddress(literal), true, literal);
    const result = validateExternalEndpoint(`https://[${literal}]:2083/`);
    assert.equal(result.valid, false, literal);
    assert.equal(result.reason, "blocked_private_or_loopback_host", literal);
  }
});

test("ORB-010 normalized IPv6 guard preserves public literal handling", () => {
  for (const literal of [
    "::ffff:808:808",
    "0:0:0:0:0:ffff:808:808",
    "::ffff:8.8.8.8",
    "2001:4860:4860::8888",
  ]) {
    assert.equal(isBlockedNetworkAddress(literal), false, literal);
    const result = validateExternalEndpoint(`https://[${literal}]:2083/`);
    assert.equal(result.valid, true, literal);
  }
  for (const literal of ["::1", "fc00::1234", "fd12::1", "fe80::42"]) {
    assert.equal(isBlockedNetworkAddress(literal), true, literal);
  }
});
