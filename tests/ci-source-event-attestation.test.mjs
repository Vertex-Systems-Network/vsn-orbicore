import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { createCiSourceEventAttestor } from
  "../apps/api/ci-source-event-attestation.mjs";

test("ORB-005 event attestation requires CI-only gate and external key",()=>{
  const previous={
    GITHUB_ACTIONS:process.env.GITHUB_ACTIONS,
    ORBICORE_CI_SYNTHETIC_REAUTH:process.env.ORBICORE_CI_SYNTHETIC_REAUTH,
    ORBICORE_CI_SYNTHETIC_RECONCILE:
      process.env.ORBICORE_CI_SYNTHETIC_RECONCILE,
    ORBICORE_CI_SYNTHETIC_EVENT_ATTESTATION:
      process.env.ORBICORE_CI_SYNTHETIC_EVENT_ATTESTATION,
  };
  try{
    delete process.env.GITHUB_ACTIONS;
    process.env.ORBICORE_CI_SYNTHETIC_REAUTH="1";
    process.env.ORBICORE_CI_SYNTHETIC_RECONCILE="1";
    process.env.ORBICORE_CI_SYNTHETIC_EVENT_ATTESTATION="1";
    assert.throws(()=>createCiSourceEventAttestor(),
      /ci_source_event_attestation_gate_required/);
    process.env.GITHUB_ACTIONS="true";
    assert.throws(()=>createCiSourceEventAttestor({
      activeKey:{id:"k1",bytes:Buffer.alloc(8)},
    }),/ci_source_attestation_keyring_invalid/);
    assert.throws(()=>createCiSourceEventAttestor({
      activeKey:{id:"k1",bytes:randomBytes(32)},
      previousKeys:[{id:"k1",bytes:randomBytes(32)}],
    }),/ci_source_attestation_keyring_invalid/);
  }finally{
    for(const [name,val] of Object.entries(previous)){
      if(val===undefined)delete process.env[name];else process.env[name]=val;
    }
  }
});

test("ORB-005 source MAC binds immutable tenant, user, epoch, reason, event",()=>{
  const previous={
    GITHUB_ACTIONS:process.env.GITHUB_ACTIONS,
    ORBICORE_CI_SYNTHETIC_REAUTH:process.env.ORBICORE_CI_SYNTHETIC_REAUTH,
    ORBICORE_CI_SYNTHETIC_RECONCILE:
      process.env.ORBICORE_CI_SYNTHETIC_RECONCILE,
    ORBICORE_CI_SYNTHETIC_EVENT_ATTESTATION:
      process.env.ORBICORE_CI_SYNTHETIC_EVENT_ATTESTATION,
  };
  try{
    for(const name of Object.keys(previous))process.env[name]=
      name==="GITHUB_ACTIONS"?"true":"1";
    const attestor=createCiSourceEventAttestor({
      activeKey:{id:"source_k1",bytes:randomBytes(32)},
    });
    const e={
      event_id:randomBytes(32).toString("hex"),
      organization_id:"org-test-a",user_id:"user-test-a",
      source_epoch:2,reason:"disabled",
    };
    const sig=attestor.sign(e);
    const verified={...e,origin_key_id:sig.originKeyId,
      origin_mac:sig.originMac};
    assert.equal(attestor.verify(verified),true);
    for(const patch of [
      {organization_id:"org-test-b"},{user_id:"user-test-b"},
      {source_epoch:3},{reason:"password_reset"},
      {event_id:randomBytes(32).toString("hex")},
      {origin_mac:"f".repeat(64)},
    ])assert.equal(attestor.verify({...verified,...patch}),false);
    assert.equal(attestor.verify({
      ...verified,origin_mac:"invalid",
    }),false);
  }finally{
    for(const [name,val] of Object.entries(previous)){
      if(val===undefined)delete process.env[name];else process.env[name]=val;
    }
  }
});
