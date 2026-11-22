import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FEATURE_TABLES, insertSyntheticFeatureState,
} from "../apps/api/postgres-feature-state.mjs";
import {
  copySyntheticFullFeatureSnapshot,
} from "../apps/api/postgres-identity-core.mjs";

test("ORB-005: operational schema uses exact seven fixed feature tables", () => {
  assert.deepEqual(FEATURE_TABLES, [
    "capability_snapshots", "migration_plans", "storage_policies",
    "site_snapshots", "automation_rules", "automation_runs", "wp_site_state",
  ]);
  assert.equal(Object.isFrozen(FEATURE_TABLES), true);
});

test("ORB-005: full synthetic feature snapshot demands distinct consent", async () => {
  await assert.rejects(copySyntheticFullFeatureSnapshot({
    sqlite: { prepare() { throw new Error("should_not_read_source"); } },
    postgres: { connect() { throw new Error("should_not_connect"); } },
    consent: "fixture_only_auth_offline_copy",
  }), /explicit_synthetic_offline_copy_required/);
});

test("ORB-005: static field insert preserves JSON source and converts rule flag", async () => {
  const source = Object.fromEntries(FEATURE_TABLES.map((table) => [table, []]));
  source.automation_rules.push({
    id: "rule-fixture", organization_id: "org-fixture", name: "No-op",
    rule_type: "inventory_stale_refresh", approval_mode: "manual_approval",
    daily_run_cap: 3, enabled: 0, last_run_at: null, created_by: "test",
    created_at: "2026-11-22T00:00:00.000Z",
  });
  source.automation_runs.push({
    id: "run-fixture", organization_id: "org-fixture", rule_id: "rule-fixture",
    actor_id: "test", status: "dry_run_only",
    summary_json: '{"z":1,"a":2}', created_at: "2026-11-22T00:00:00.000Z",
  });
  const queries = [];
  await insertSyntheticFeatureState({
    client: { async query(sql, params) { queries.push({ sql, params }); } },
    source,
  });
  assert.equal(queries.length, 2);
  assert.match(queries[0].sql, /^INSERT INTO automation_rules /);
  assert.equal(queries[0].params[6], false);
  assert.equal(queries[1].params[5], '{"z":1,"a":2}');
  assert.match(queries[1].sql, /^INSERT INTO automation_runs /);
});

test("ORB-005: feature importer rejects incomplete snapshots", async () => {
  await assert.rejects(insertSyntheticFeatureState({
    client: { async query() { throw new Error("unexpected_query"); } },
    source: {},
  }), /Complete synthetic feature-table snapshot/);
  await assert.rejects(insertSyntheticFeatureState({
    client: {}, source: {},
  }), /transactional client/);
});
