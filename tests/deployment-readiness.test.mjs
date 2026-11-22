import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDeploymentReadiness } from "../apps/api/preflight.mjs";

test("ORB-017: installed environment variables never imply PostgreSQL credential authority", () => {
  const names=[
    "ORBICORE_DATABASE_URL", "DATABASE_URL", "REDIS_URL",
    "ORBICORE_REDIS_URL", "ORBICORE_COOKIE_SECURE",
    "ORBICORE_SMTP_URL", "SMTP_URL",
  ];
  const previous=Object.fromEntries(names.map(k=>[k,process.env[k]]));
  try{
    process.env.ORBICORE_DATABASE_URL="postgresql://localhost/fake";
    process.env.REDIS_URL="redis://localhost:6379";
    process.env.ORBICORE_COOKIE_SECURE="1";
    process.env.ORBICORE_SMTP_URL="smtp://localhost:2525";
    const report=buildDeploymentReadiness({
      mfaKeyring:{primaryId:"demo_key",keys:new Map([["demo_key",Buffer.alloc(32)]])},
      webauthnOrigin:"https://orbicore.example.test",
      webauthnRPID:"orbicore.example.test",
    });
    assert.equal(report.configurationComplete,true,
      "configured inputs are not verified service connections");
    assert.equal(report.productionReady,false,
      "never promote CI shadow auth from configured URLs");
    assert.equal(report.profile,"local_sqlite_prototype");
    assert.equal(report.runtimeAuthAuthority,"sqlite");
    for(const id of ["authority.postgres","migration.complete",
      "audit.custody","recovery.offhost"]){
      assert.equal(report.gates.find(g=>g.id===id)?.status,"blocked");
    }
    assert.ok(report.missingRequiredServices.some(s=>s.includes("runtime authentication")));
    const serialized=JSON.stringify(report);
    assert.equal(serialized.includes("postgresql://localhost/fake"),false);
    assert.equal(serialized.includes("smtp://localhost:2525"),false);
  }finally{
    for(const [k,v] of Object.entries(previous)){
      if(v===undefined)delete process.env[k];
      else process.env[k]=v;
    }
  }
});

test("ORB-017: no deployment env returns local-only with blocked cutover",()=>{
  const report=buildDeploymentReadiness({
    mfaKeyring:null,
    webauthnOrigin:"http://localhost:41751",webauthnRPID:"localhost",
  });
  assert.equal(report.productionReady,false);
  assert.equal(report.runtimeAuthAuthority,"sqlite");
  assert.equal(report.gates.find(g=>g.id==="authority.postgres").status,"blocked");
  assert.equal(report.gates.find(g=>g.id==="migration.complete").status,"blocked");
});
