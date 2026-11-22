import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CI_SHADOW_KDF, createCiReauthenticationShadowPilot,
} from "../apps/api/postgres-ci-credential-shadow.mjs";

test("ORB-005: CI credential shadow KDF is explicitly versioned and frozen",()=>{
  assert.deepEqual(CI_SHADOW_KDF,{
    version:"scrypt-n32768-r8-p3-v1",N:32768,r:8,p:3,
    maxmem:64*1024*1024,keyLength:64,
  });
  assert.equal(Object.isFrozen(CI_SHADOW_KDF),true);
});

test("ORB-005: shadow reauthentication module refuses ordinary runtime use",()=>{
  const previous={
    actions:process.env.GITHUB_ACTIONS,
    reauth:process.env.ORBICORE_CI_SYNTHETIC_REAUTH,
    schema:process.env.ORBICORE_CI_SYNTHETIC_SHADOW_SCHEMA,
  };
  try{
    delete process.env.GITHUB_ACTIONS;
    process.env.ORBICORE_CI_SYNTHETIC_REAUTH="1";
    process.env.ORBICORE_CI_SYNTHETIC_SHADOW_SCHEMA="1";
    assert.throws(()=>createCiReauthenticationShadowPilot(),
      /ci_shadow_reauthentication_explicit_gate_required/);
    process.env.GITHUB_ACTIONS="true";
    delete process.env.ORBICORE_CI_SYNTHETIC_REAUTH;
    assert.throws(()=>createCiReauthenticationShadowPilot(),
      /ci_shadow_reauthentication_explicit_gate_required/);
    process.env.ORBICORE_CI_SYNTHETIC_REAUTH="1";
    delete process.env.ORBICORE_CI_SYNTHETIC_SHADOW_SCHEMA;
    assert.throws(()=>createCiReauthenticationShadowPilot(),
      /ci_shadow_reauthentication_explicit_gate_required/);
    process.env.ORBICORE_CI_SYNTHETIC_SHADOW_SCHEMA="1";
    assert.throws(()=>createCiReauthenticationShadowPilot(),
      /ci_shadow_requires_sqlite_and_restricted_postgres_pool/);
  }finally{
    for(const [k,v] of Object.entries({
      GITHUB_ACTIONS:previous.actions,
      ORBICORE_CI_SYNTHETIC_REAUTH:previous.reauth,
      ORBICORE_CI_SYNTHETIC_SHADOW_SCHEMA:previous.schema,
    })){
      if(v===undefined)delete process.env[k];else process.env[k]=v;
    }
  }
});
