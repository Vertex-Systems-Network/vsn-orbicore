import assert from "node:assert/strict";
import { test } from "node:test";
import {
  initializeCiSourceEpochJournal,changeCiSourceCredential,
  createCiSourceEpochReconciler,
} from "../apps/api/postgres-ci-credential-invalidation.mjs";

test("ORB-005 CI source outbox and reconciliation refuse normal runtime",()=>{
  const original={
    GITHUB_ACTIONS:process.env.GITHUB_ACTIONS,
    ORBICORE_CI_SYNTHETIC_SHADOW_SCHEMA:process.env.ORBICORE_CI_SYNTHETIC_SHADOW_SCHEMA,
    ORBICORE_CI_SYNTHETIC_REAUTH:process.env.ORBICORE_CI_SYNTHETIC_REAUTH,
    ORBICORE_CI_SYNTHETIC_RECONCILE:process.env.ORBICORE_CI_SYNTHETIC_RECONCILE,
  };
  try {
    delete process.env.GITHUB_ACTIONS;
    process.env.ORBICORE_CI_SYNTHETIC_SHADOW_SCHEMA="1";
    process.env.ORBICORE_CI_SYNTHETIC_REAUTH="1";
    process.env.ORBICORE_CI_SYNTHETIC_RECONCILE="1";
    for (const action of [
      ()=>initializeCiSourceEpochJournal(),
      ()=>changeCiSourceCredential(),
      ()=>createCiSourceEpochReconciler(),
    ]) assert.throws(action,/ci_shadow_reconciliation_explicit_gate_required/);
    process.env.GITHUB_ACTIONS="true";
    delete process.env.ORBICORE_CI_SYNTHETIC_RECONCILE;
    assert.throws(()=>createCiSourceEpochReconciler(),
      /ci_shadow_reconciliation_explicit_gate_required/);
  } finally {
    for (const [key,value] of Object.entries(original)) {
      if(value===undefined) delete process.env[key];
      else process.env[key]=value;
    }
  }
});
