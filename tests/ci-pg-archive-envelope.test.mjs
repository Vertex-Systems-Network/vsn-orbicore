import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { sealCiPgArchive, openCiPgArchive } from "../scripts/ci-pg-archive-envelope.mjs";

function withCiGate(fn){
  const previous={
    GITHUB_ACTIONS:process.env.GITHUB_ACTIONS,
    ORBICORE_CI_PG_ISOLATED_RESTORE:
      process.env.ORBICORE_CI_PG_ISOLATED_RESTORE,
  };
  try{
    process.env.GITHUB_ACTIONS="true";
    process.env.ORBICORE_CI_PG_ISOLATED_RESTORE="1";
    return fn();
  }finally{
    for(const [k,v] of Object.entries(previous)){
      if(v===undefined)delete process.env[k];
      else process.env[k]=v;
    }
  }
}
test("ORB-016 encrypted backup never runs without explicit GitHub fixture gate",()=>{
  const p=process.env.GITHUB_ACTIONS;
  try{
    delete process.env.GITHUB_ACTIONS;
    assert.throws(()=>sealCiPgArchive(Buffer.from("fixture"),{
      context:"database",keyHex:randomBytes(32).toString("hex"),
    }),/ci_pg_backup_envelope_requires_hosted_fixture_gate/);
  }finally{
    if(p===undefined)delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS=p;
  }
});
test("ORB-016 encrypted archive denies tamper, wrong key, and archive/globals swaps",()=>{
  withCiGate(()=>{
    const keyHex=randomBytes(32).toString("hex");
    const value=Buffer.from("synthetic PG16 database archive without secrets");
    const encrypted=sealCiPgArchive(value,{keyHex,context:"database"});
    assert.notEqual(encrypted.includes(value),true);
    assert.deepEqual(openCiPgArchive(encrypted,{keyHex,context:"database"}),value);
    assert.notDeepEqual(sealCiPgArchive(value,{keyHex,context:"database"}),encrypted,
      "each archive must have fresh nonce");
    for(const ix of [0,9,20,31,encrypted.length-1]){
      const altered=Buffer.from(encrypted);
      altered[ix]^=0xff;
      assert.throws(()=>openCiPgArchive(altered,{keyHex,context:"database"}),
        /ci_pg_backup_envelope_rejected/);
    }
    assert.throws(()=>openCiPgArchive(encrypted,{
      keyHex:randomBytes(32).toString("hex"),context:"database",
    }),/ci_pg_backup_envelope_rejected/);
    assert.throws(()=>openCiPgArchive(encrypted,{keyHex,context:"globals"}),
      /ci_pg_backup_envelope_rejected/);
    assert.throws(()=>openCiPgArchive(encrypted.subarray(0,28),
      {keyHex,context:"database"}),/ci_pg_backup_envelope_rejected/);
    assert.throws(()=>sealCiPgArchive(value,{keyHex:"ci-fixture",context:"database"}),
      /ci_pg_backup_key_unavailable/);
    assert.throws(()=>sealCiPgArchive(value,{keyHex,context:"production"}),
      /ci_pg_backup_payload_or_context_invalid/);
  });
});
