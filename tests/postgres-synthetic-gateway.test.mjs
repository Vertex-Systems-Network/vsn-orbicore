import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPostgresSyntheticSubmissionGateway,
} from "../apps/api/postgres-synthetic-gateway.mjs";

const TOKEN = "a".repeat(64);
const VALID = {
  tokenHash: TOKEN, organizationId: "org-fixture",
  accountId: "account-fixture", idempotencyKey: "mock-1",
};
function mockPool({failAt = null, response = { jobId:"job-fixture",created:true }} = {}) {
  const calls = [];
  let released = 0;
  const pool = {
    async connect() {
      return {
        async query(sql, values) {
          calls.push({sql,values});
          if (sql.includes(failAt ?? "no-matching-failure")) {
            throw new Error("synthetic_test_failure");
          }
          if (sql.startsWith("SELECT job_id")) return {rows:[response]};
          return {rows:[]};
        },
        release(){ released += 1; },
      };
    },
  };
  return {pool,calls,get released(){return released;}};
}

test("ORB-005: restricted job submission uses one transaction and no raw tenant SQL", async () => {
  const mock = mockPool();
  const api = createPostgresSyntheticSubmissionGateway(mock.pool);
  const result=await api.enqueue(VALID);
  assert.deepEqual(result,{
    jobId:"job-fixture",created:true,source:"mock_fixture",live:false,
  });
  assert.deepEqual(mock.calls.map(x=>x.sql),[
    "BEGIN","SET LOCAL ROLE orbicore_synthetic_submitter",
    'SELECT job_id AS "jobId", created FROM ' +
      "public.orbicore_submit_synthetic_inventory($1,$2,$3,$4)",
    "COMMIT",
  ]);
  assert.deepEqual(mock.calls[2].values,
    [TOKEN,"org-fixture","account-fixture","mock-1"]);
  assert.equal(mock.released,1);
});

test("ORB-005: failed PG function rolls back instead of committing and releases", async () => {
  const mock=mockPool({failAt:"orbicore_submit_synthetic_inventory"});
  await assert.rejects(createPostgresSyntheticSubmissionGateway(mock.pool)
    .enqueue(VALID),/synthetic_test_failure/);
  assert.deepEqual(mock.calls.map(x=>x.sql),[
    "BEGIN","SET LOCAL ROLE orbicore_synthetic_submitter",
    'SELECT job_id AS "jobId", created FROM '+
      "public.orbicore_submit_synthetic_inventory($1,$2,$3,$4)",
    "ROLLBACK",
  ]);
  assert.equal(mock.released,1);
});

test("ORB-005: invalid request fields fail before opening database connection", async () => {
  let connects=0;
  const gateway=createPostgresSyntheticSubmissionGateway({
    async connect(){ connects+=1; throw new Error("should_not_connect"); },
  });
  for(const bad of [
    {...VALID,tokenHash:"raw-session"},
    {...VALID,tokenHash:"B".repeat(64)},
    {...VALID,organizationId:"org' OR TRUE --"},
    {...VALID,accountId:42},
    {...VALID,idempotencyKey:""},
    {...VALID,idempotencyKey:"x".repeat(257)},
  ]) await assert.rejects(gateway.enqueue(bad),/must (?:be|contain)/);
  assert.equal(connects,0);
});

test("ORB-005: unexpected SQL response cannot be reported as success", async () => {
  const mock=mockPool({response:{jobId:null,created:"true"}});
  await assert.rejects(createPostgresSyntheticSubmissionGateway(mock.pool)
    .enqueue(VALID),/synthetic_gateway_invalid_response/);
  assert.equal(mock.released,1);
  assert.equal(mock.calls.at(-1).sql,"ROLLBACK");
});
