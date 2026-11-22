import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  canonicalCiAuthIdentifier, createCiKeyedAuthFailureAudit,
  initializeCiAuthFailureAudit, GENERIC_BAD_CREDENTIALS,
  GENERIC_AUTH_LIMITED,
} from "../apps/api/ci-keyed-auth-failure-audit.mjs";

test("ORB-005 keyed failure audit denies normal runtime and invalid keys",()=>{
  const before={
    GITHUB_ACTIONS:process.env.GITHUB_ACTIONS,
    ORBICORE_CI_SYNTHETIC_FAILURE_AUDIT:
      process.env.ORBICORE_CI_SYNTHETIC_FAILURE_AUDIT,
  };
  try{
    delete process.env.GITHUB_ACTIONS;
    process.env.ORBICORE_CI_SYNTHETIC_FAILURE_AUDIT="1";
    assert.throws(()=>initializeCiAuthFailureAudit(),
      /ci_keyed_auth_failure_gate_required/);
    assert.throws(()=>createCiKeyedAuthFailureAudit(),
      /ci_keyed_auth_failure_gate_required/);
    process.env.GITHUB_ACTIONS="true";
    delete process.env.ORBICORE_CI_SYNTHETIC_FAILURE_AUDIT;
    assert.throws(()=>createCiKeyedAuthFailureAudit(),
      /ci_keyed_auth_failure_gate_required/);
    process.env.ORBICORE_CI_SYNTHETIC_FAILURE_AUDIT="1";
    const sqlite={prepare:()=>{},exec:()=>{}};
    assert.throws(()=>createCiKeyedAuthFailureAudit({
      sqlite,activeKey:{id:"k1",bytes:Buffer.alloc(8)},
    }),/keyring_invalid/);
    assert.throws(()=>createCiKeyedAuthFailureAudit({
      sqlite,activeKey:{id:"k1",bytes:randomBytes(32)},
      previousKeys:[{id:"k1",bytes:randomBytes(32)}],
    }),/keyring_invalid/);
  }finally{
    for(const [k,v] of Object.entries(before)){
      if(v===undefined)delete process.env[k];else process.env[k]=v;
    }
  }
});

test("ORB-005 keyed failure normalization matches existing SQLite case folding",()=>{
  assert.equal(canonicalCiAuthIdentifier("  UNKNOWN@EXAMPLE.TEST  "),
    "unknown@example.test");
  assert.equal(canonicalCiAuthIdentifier("UsEr@Example.Test"),
    "user@example.test");
  assert.equal(canonicalCiAuthIdentifier("user@sample.test\nX-Foo: attack"),
    "malformed");
  assert.equal(canonicalCiAuthIdentifier("a".repeat(255)),"malformed");
  assert.equal(canonicalCiAuthIdentifier(null),"malformed");
});

test("ORB-005 generic external rejection contract exposes no identity detail",()=>{
  assert.deepEqual(GENERIC_BAD_CREDENTIALS,{
    status:401,error:"invalid_credentials",
  });
  assert.deepEqual(GENERIC_AUTH_LIMITED,{
    status:429,error:"auth_rate_limited",
  });
  assert.equal(Object.isFrozen(GENERIC_BAD_CREDENTIALS),true);
  assert.equal(Object.isFrozen(GENERIC_AUTH_LIMITED),true);
});
