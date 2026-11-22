import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createApp } from "../apps/api/server.mjs";
import { copySyntheticFullFeatureSnapshot } from "../apps/api/postgres-identity-core.mjs";
import { FEATURE_TABLES } from "../apps/api/postgres-feature-state.mjs";

if (process.env.GITHUB_ACTIONS !== "true" ||
    process.env.ORBICORE_CI_SYNTHETIC_AUTH_IMPORT !== "1") {
  throw new Error("synthetic_feature_snapshot_ci_only");
}

const pool = new Pool({
  host: process.env.PGHOST ?? "127.0.0.1",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "orbicore",
  database: process.env.PGDATABASE ?? "orbicore",
  password: process.env.PGPASSWORD,
  connectionTimeoutMillis: 5000,
});
const app = createApp({
  dbPath: ":memory:",
  startWorker: false,
  bootstrapToken: "ci-feature-only-bootstrap-token",
});
const now = new Date().toISOString();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const copy = () => copySyntheticFullFeatureSnapshot({
  sqlite: app.db, postgres: pool, consent: "fixture_only_features_offline_copy",
});
const sourceCount = (table) =>
  app.db.prepare("SELECT COUNT(*) AS n FROM " + table).get().n;
const pgCount = async (table) =>
  Number((await pool.query("SELECT COUNT(*)::int AS n FROM " + table)).rows[0].n);
async function readScoped(tenant, statement) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE orbicore_tenant_readonly");
    if (tenant !== null) await client.query(
      "SELECT set_config('orbicore.tenant_id',$1,true)", [tenant],
    );
    return await client.query(statement);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

try {
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const bootstrap = await fetch(
    "http://127.0.0.1:" + app.server.address().port + "/api/auth/bootstrap",
    {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "ci-feature-only-bootstrap-token",
        email: "ci-owner@example.test",
        password: "only-synthetic-not-for-any-live-credential",
      }),
    },
  );
  assert.equal(bootstrap.status, 201);
  const owner = app.db.prepare("SELECT id FROM users WHERE email=?")
    .get("ci-owner@example.test").id;
  const accounts = app.db.prepare(
    "SELECT id, organization_id FROM accounts WHERE organization_id='org-demo' ORDER BY id",
  ).all();
  assert.ok(accounts.length >= 2, "fixture requires two accounts");
  const site = app.db.prepare(
    "SELECT s.id, s.account_id FROM sites s WHERE s.account_id=? ORDER BY s.id LIMIT 1",
  ).get(accounts[0].id) ??
    app.db.prepare("SELECT id,account_id FROM sites ORDER BY id LIMIT 1").get();
  assert.ok(site, "fixture requires a site");
  const sourceAccount = app.db.prepare("SELECT id,organization_id FROM accounts WHERE id=?")
    .get(site.account_id);
  const alternateAccount = accounts.find((row) => row.id !== sourceAccount.id);
  assert.ok(alternateAccount, "fixture requires a distinct destination account");

  const otherUser = randomUUID();
  app.db.prepare("INSERT INTO organizations (id,name,created_at) VALUES (?,?,?)")
    .run("org-feature-other", "Synthetic second tenant", now);
  app.db.prepare(
    "INSERT INTO users (id,organization_id,email,password_salt,password_hash,role,created_at)" +
    " VALUES (?,?,?,?,?,'viewer',?)",
  ).run(otherUser, "org-feature-other", "other-feature@example.invalid",
    "fixture-salt", "fixture-hash", now);
  app.db.prepare(
    "INSERT INTO accounts (id,organization_id,label,provider,host,username,health,used_bytes,quota_bytes,source) " +
    "VALUES(?,?,?,?,?,?,?,0,1,?)",
  ).run("account-feature-other", "org-feature-other", "Synthetic fixture", "mock",
    "other-feature.example.invalid", "fixture", "healthy", "mock_fixture");
  app.db.prepare(
    "INSERT INTO sites(id,account_id,domain,kind,document_root,php_version,status) " +
    "VALUES (?,?,?,?,?,?,?)",
  ).run("site-feature-other", "account-feature-other", "other-feature.example.invalid",
    "wordpress", "/tmp/synthetic-only", "8.3", "active");

  const capabilityId = "capability-other-ci";
  app.db.prepare(
    "INSERT INTO capability_snapshots(id,account_id,organization_id,profile_name," +
    "capabilities_json,source,fetched_at) VALUES (?,?,?,?,?,?,?)",
  ).run(capabilityId, "account-feature-other", "org-feature-other",
    "synthetic_no_live_capabilities", '{"readOnly":true,"externalConnections":0}',
    "mock_fixture", now);

  const migrationId = "migration-ci-only";
  app.db.prepare(
    "INSERT INTO migration_plans(id,organization_id,site_id,source_account_id," +
    "target_account_id,strategy,state,preflight_json,created_by,created_at," +
    "updated_at,checkpoint_percent) VALUES (?,?,?,?,?,'wordpress_optimized'," +
    "'planned',?,?,?,?,?)",
  ).run(migrationId, sourceAccount.organization_id, site.id, sourceAccount.id,
    alternateAccount.id, '{"ok":false,"blocked":"fixture_only"}', owner, now, now, 0);
  app.db.prepare(
    "INSERT INTO storage_policies(id,organization_id,account_id,mode,target_endpoint," +
    "target_bucket,threshold_percent,estimated_reclaim_bytes,status,created_by,created_at)" +
    " VALUES (?,?,?,'backup_archival',?,?,70,0,'dry_run_only',?,?)",
  ).run("storage-fixture-ci", sourceAccount.organization_id, sourceAccount.id,
    "https://bucket.example.invalid", "ci-not-a-real-bucket", owner, now);
  app.db.prepare(
    "INSERT INTO site_snapshots(id,organization_id,site_id,action,status," +
    "checksum_sha256,details_json,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run("snapshot-ci-only", sourceAccount.organization_id, site.id, "ci_mock",
    "synthetic", sha256("fake-site-snapshot"), '{"fileCount":0,"dryRun":true}', owner, now);
  app.db.prepare(
    "INSERT INTO automation_rules(id,organization_id,name,rule_type,approval_mode," +
    "daily_run_cap,enabled,created_by,created_at) " +
    "VALUES (?,?,?,'quota_threshold_alert','manual_approval',3,1,?,?)",
  ).run("rule-demo-ci", sourceAccount.organization_id, "Synthetic alert", owner, now);
  app.db.prepare(
    "INSERT INTO automation_runs(id,organization_id,rule_id,actor_id,status,summary_json,created_at)" +
    " VALUES(?,?,?,?,?,?,?)",
  ).run("run-demo-ci", sourceAccount.organization_id, "rule-demo-ci", owner,
    "dry_run_only", '{"status":"no_action","live":false}', now);
  app.db.prepare(
    "INSERT INTO automation_rules(id,organization_id,name,rule_type,approval_mode," +
    "daily_run_cap,enabled,created_by,created_at) " +
    "VALUES(?,?,?,'inventory_stale_refresh','manual_approval',3,1,?,?)",
  ).run("rule-other-ci", "org-feature-other", "Other synthetic rule", otherUser, now);
  app.db.prepare(
    "INSERT INTO automation_runs(id,organization_id,rule_id,actor_id,status,summary_json,created_at)" +
    " VALUES(?,?,?,?,?,?,?)",
  ).run("run-other-ci", "org-feature-other", "rule-other-ci", otherUser,
    "dry_run_only", '{"live":false}', now);
  if (!app.db.prepare("SELECT 1 FROM wp_site_state WHERE site_id=?").get(site.id)) {
    app.db.prepare(
      "INSERT INTO wp_site_state(site_id,organization_id,core_version,pending_updates," +
      "staging_url,updated_at) VALUES (?,?,?,0,?,?)",
    ).run(site.id, sourceAccount.organization_id, "6.7.2",
      "https://staging.example.invalid", now);
  }
  app.db.prepare(
    "INSERT INTO wp_site_state(site_id,organization_id,core_version,pending_updates," +
    "staging_url,updated_at) VALUES (?,?,?,0,?,?)",
  ).run("site-feature-other", "org-feature-other", "6.7.2",
    "https://other-staging.example.invalid", now);

  // Consent must be stronger than the preceding auth-state-only importer.
  await assert.rejects(copySyntheticFullFeatureSnapshot({
    sqlite: app.db, postgres: pool, consent: "fixture_only_auth_offline_copy",
  }), /explicit_synthetic_offline_copy_required/);

  // SQLite allows cross-tenant snapshot references; PostgreSQL composite FK
  // must reject them and roll back all earlier identity/auth/feature inserts.
  app.db.prepare(
    "INSERT INTO site_snapshots(id,organization_id,site_id,action,status," +
    "checksum_sha256,details_json,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run("bad-tenant-snapshot", "org-feature-other", site.id, "ci_mock",
    "synthetic", sha256("wrong-tenant"), '{"ok":false}', otherUser, now);
  await assert.rejects(copy(), (error) => error.code === "23503");
  for (const table of ["organizations", "users", "accounts", "sites",
    "capability_snapshots", "migration_plans", "site_snapshots",
    "automation_rules", "automation_runs", "wp_site_state", "sessions"]) {
    assert.equal(await pgCount(table), 0, "rollback left rows: " + table);
  }
  app.db.prepare("DELETE FROM site_snapshots WHERE id=?")
    .run("bad-tenant-snapshot");

  // Synthetic source rejects every nonempty job and secret table.
  app.db.prepare(
    "INSERT INTO secret_references(id,organization_id,label,kind,reference_uri," +
    "masked_preview,encrypted_payload,key_id,status,created_by,created_at) " +
    "VALUES (?,?,'fixture','cpanel_uapi_token',?,?,?,?, 'active',?,?)",
  ).run("ci-secret-ref", "org-demo", "vault://fake", "masked",
    "dummy-not-real-ciphertext", "ci-key", owner, now);
  await assert.rejects(copy(), /unsupported_auth_state:secret_references/);
  app.db.prepare("DELETE FROM secret_references WHERE id=?").run("ci-secret-ref");

  const result = await copy();
  assert.equal(result.scope, "synthetic_feature_state_only");
  assert.ok(result.counts.capability_snapshots >= 4);
  assert.equal(result.counts.migration_plans, 1);
  assert.equal(result.counts.storage_policies, 1);
  assert.equal(result.counts.site_snapshots, 1);
  assert.equal(result.counts.automation_rules, 2);
  assert.equal(result.counts.automation_runs, 2);
  assert.ok(result.counts.wp_site_state >= 2);

  for (const [table, count] of Object.entries(result.counts)) {
    assert.equal(await pgCount(table), count, "PostgreSQL count: " + table);
    assert.equal(sourceCount(table), count, "SQLite untouched: " + table);
  }
  const storedSite = (await pool.query(
    "SELECT organization_id FROM sites WHERE id=$1", [site.id],
  )).rows[0];
  assert.equal(storedSite.organization_id, sourceAccount.organization_id);
  const storedJSON = (await pool.query(
    "SELECT capabilities_json FROM capability_snapshots WHERE id=$1", [capabilityId],
  )).rows[0].capabilities_json;
  assert.equal(storedJSON, '{"readOnly":true,"externalConnections":0}');

  const query = async (tenant, table) =>
    (await readScoped(tenant, "SELECT organization_id FROM " + table))
      .rows.map((row) => row.organization_id);
  for (const table of FEATURE_TABLES) {
    assert.ok((await query("org-demo", table)).every((x) => x === "org-demo"));
    assert.ok((await query("org-feature-other", table))
      .every((x) => x === "org-feature-other"));
    assert.equal((await query(null, table)).length, 0,
      "missing tenant context exposes " + table);
  }
  assert.equal((await query("org-feature-other","automation_rules")).length,1);
  assert.equal((await query("org-demo","automation_rules")).length,1);

  // The proof role has no read access to raw paths, endpoints, migration
  // preflight payloads, automation summaries, snapshot details or vault data.
  for (const statement of [
    "SELECT document_root FROM sites",
    "SELECT capabilities_json FROM capability_snapshots",
    "SELECT preflight_json FROM migration_plans",
    "SELECT target_endpoint FROM storage_policies",
    "SELECT target_bucket FROM storage_policies",
    "SELECT details_json FROM site_snapshots",
    "SELECT summary_json FROM automation_runs",
    "SELECT staging_url FROM wp_site_state",
    "SELECT encrypted_payload FROM secret_references",
  ]) {
    await assert.rejects(readScoped("org-demo", statement),
      (error) => error.code === "42501", "sensitive column exposed: " + statement);
  }
  await assert.rejects(
    readScoped("org-demo", "DELETE FROM automation_rules WHERE id='rule-demo-ci'"),
    (error) => error.code === "42501",
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO automation_runs(id,organization_id,rule_id,actor_id,status," +
      "summary_json,created_at) VALUES($1,$2,$3,$4,$5,$6,NOW())",
      [randomUUID(), "org-feature-other", "rule-demo-ci",
        otherUser, "dry_run_only", '{"live":false}'],
    ), (error) => error.code === "23503",
  );
  await assert.rejects(copy(), /nonempty_postgres_target_refused/);

  console.log(JSON.stringify({
    task:"ORB-005",kind:"synthetic-postgresql-feature-state-snapshot",
    schemaMigration:"005_postgres_feature_state",
    fixtureOnly:true, sourceUnmodified:true,
    tenantSiteForeignKey:true, crossTenantSnapshotCopyRolledBack:true,
    secretReferenceCopyRefused:true, migratedOperationalTables:FEATURE_TABLES,
    counts:result.counts,
    ciReadRoleMissingTenantFailsClosed:true,
    deniedSensitiveColumnQueries:9,
    ciReadRoleCannotMutate:true,
    productionHttpCutover:false, productionSecretsCopied:false,
    jobHistoryCopied:false, liveProviderActions:false,
  }));
} finally {
  app.close();
  await pool.end();
}
