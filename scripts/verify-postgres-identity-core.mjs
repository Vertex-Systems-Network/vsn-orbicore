import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createApp } from "../apps/api/server.mjs";
import { appendAuditEvent, computeAuditEntryHash, verifyAuditChain } from "../apps/api/audit.mjs";
import {
  copySyntheticIdentitySnapshot, createPostgresIdentityCoreReader,
} from "../apps/api/postgres-identity-core.mjs";

// Disposable CI only: no network hosting provider, no plaintext credentials
// written to a file, no production authentication/cutover.
if (process.env.GITHUB_ACTIONS !== "true") throw new Error("identity_migration_ci_only");
const pool = new Pool({
  host: process.env.PGHOST ?? "127.0.0.1",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "orbicore",
  database: process.env.PGDATABASE ?? "orbicore",
  password: process.env.PGPASSWORD,
  max: 4,
  connectionTimeoutMillis: 5000,
});
const bootstrapToken = "fixture-offline-only-bootstrap-token";
const app = createApp({
  dbPath: ":memory:", startWorker: false, bootstrapToken,
});
let serverStarted = false;
let cookie = "";
const timestamp = new Date().toISOString();
try {
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  serverStarted = true;
  const base = "http://127.0.0.1:" + app.server.address().port;
  const bootstrap = await fetch(base + "/api/auth/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: bootstrapToken,
      email: "pg-core-owner@example.test",
      password: "pg-core-ci-only-password-12345",
    }),
  });
  assert.equal(bootstrap.status, 201);
  cookie = bootstrap.headers.get("set-cookie").split(";")[0];
  const token = cookie.split("=")[1];
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const owner = app.db.prepare("SELECT id FROM users WHERE email = ?").get("pg-core-owner@example.test");
  assert.ok(owner?.id);

  const newOrg = "org-pg-core-isolated";
  app.db.prepare(
    "INSERT INTO organizations(id, name, created_at) VALUES (?,?,?)",
  ).run(newOrg, "Synthetic isolated tenant", timestamp);
  app.db.prepare(
    "INSERT INTO users(id, organization_id, email, password_salt, password_hash, role, disabled, created_at) " +
    "VALUES (?,?,?,?,?,'viewer',0,?)",
  ).run("user-other-ci", newOrg, "other-tenant@example.test", "synthetic-salt", "synthetic-hash", timestamp);
  app.db.prepare(
    "INSERT INTO accounts(id, organization_id, label, provider, host, username, health, " +
    "used_bytes, quota_bytes, source) VALUES (?,?,?,?,?,?,?,0,1,?)",
  ).run("account-other-ci", newOrg, "Synthetic Other", "mock",
    "no-provider.example.invalid", "none", "healthy", "mock_fixture");
  app.db.prepare(
    "INSERT INTO sites(id, account_id, domain, kind, document_root, php_version, status) " +
    "VALUES (?,?,?,?,?,?,?)",
  ).run("site-other-ci", "account-other-ci", "no-provider.example.invalid", "static", "/tmp/nonlive", "8.3", "active");
  appendAuditEvent(app.db, {
    organizationId: newOrg, actor: "user-other-ci", action: "fixture.created",
    targetId: "account-other-ci", outcome: "synthetic", createdAt: timestamp,
    details: { z: 1, a: 2 },
  });
  assert.equal(verifyAuditChain(app.db, newOrg).valid, true);

  // Fail closed if authentication state outside this migration's *core*
  // contract exists; do not silently drop MFA/passkeys/recovery records.
  app.db.prepare(
    "INSERT INTO recovery_contacts(id,user_id,channel,address,created_at) VALUES (?,?,?,?,?)",
  ).run("ci-unsynced-contact", owner.id, "email", "owner@example.invalid", timestamp);
  await assert.rejects(
    copySyntheticIdentitySnapshot({
      sqlite: app.db, postgres: pool, consent: "fixture_only_offline_copy",
    }),
    /unsupported_auth_state:recovery_contacts/,
  );
  app.db.prepare("DELETE FROM recovery_contacts WHERE id = ?").run("ci-unsynced-contact");
  // Also refuse importing a tampered local SHA-256 audit chain.
  const auditRow = app.db.prepare(
    "SELECT id, details_json FROM audit_events WHERE organization_id = ? ORDER BY rowid LIMIT 1",
  ).get(newOrg);
  app.db.prepare("UPDATE audit_events SET details_json = ? WHERE id = ?").run('{"tampered":true}', auditRow.id);
  await assert.rejects(
    copySyntheticIdentitySnapshot({
      sqlite: app.db, postgres: pool, consent: "fixture_only_offline_copy",
    }),
    /source_audit_chain_unverifiable/,
  );
  app.db.prepare("UPDATE audit_events SET details_json = ? WHERE id = ?").run(auditRow.details_json, auditRow.id);

  const result = await copySyntheticIdentitySnapshot({
    sqlite: app.db, postgres: pool, consent: "fixture_only_offline_copy",
  });
  assert.equal(result.scope, "synthetic_core_only");
  assert.equal(result.counts.organizations, 2);
  assert.equal(result.counts.accounts, 4);
  assert.equal(result.counts.users, 2);
  assert.equal(result.counts.sessions, 1);
  assert.ok(result.counts.sites >= 1);
  assert.ok(result.counts.audit_events >= 2);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 2);

  const reader = createPostgresIdentityCoreReader(pool);
  const actor = await reader.actorForSession({ tokenHash });
  assert.equal(actor.id, owner.id);
  assert.equal(actor.organizationId, "org-demo");
  assert.equal(actor.role, "owner");
  assert.equal((await reader.accountForTenant({
    organizationId: "org-demo", accountId: "account-other-ci",
  })), null);
  assert.equal((await reader.accountForTenant({
    organizationId: newOrg, accountId: "account-other-ci",
  })).id, "account-other-ci");

  // Fail closed for expired, disabled, and MFA-required-without-verified-session.
  assert.equal(await reader.actorForSession({ tokenHash, at: new Date("2999-01-01T00:00:00Z") }), null);
  await pool.query("UPDATE users SET disabled = TRUE WHERE id=$1", [owner.id]);
  assert.equal(await reader.actorForSession({ tokenHash }), null);
  await pool.query("UPDATE users SET disabled = FALSE, mfa_enabled=TRUE WHERE id=$1", [owner.id]);
  assert.equal(await reader.actorForSession({ tokenHash }), null);
  await pool.query("UPDATE sessions SET mfa_verified=TRUE WHERE user_id=$1", [owner.id]);
  assert.equal((await reader.actorForSession({ tokenHash })).id, owner.id);
  await pool.query("UPDATE users SET mfa_enabled=FALSE WHERE id=$1", [owner.id]);

  // Composite FK must reject linking another tenant's session to this owner.
  await assert.rejects(
    pool.query(
      "INSERT INTO sessions(token_hash,organization_id,user_id,expires_at) VALUES ($1,$2,$3,NOW()+INTERVAL '1 day')",
      [createHash("sha256").update(randomUUID()).digest("hex"), newOrg, owner.id],
    ),
    (error) => error.code === "23503",
  );

  // Preserves the exact input JSON bytes required by the SQLite audit chain.
  const audit = (await pool.query(
    "SELECT organization_id, actor, action, target_id, outcome, " +
    "created_at, details_raw_json, prev_hash, entry_hash " +
    "FROM audit_events WHERE organization_id=$1",
    [newOrg],
  )).rows[0];
  assert.equal(audit.details_raw_json, '{"z":1,"a":2}');
  assert.equal(computeAuditEntryHash({
    prevHash: audit.prev_hash, organizationId: audit.organization_id,
    actor: audit.actor, action: audit.action, targetId: audit.target_id,
    outcome: audit.outcome, detailsJson: audit.details_raw_json,
    createdAt: audit.created_at.toISOString(),
  }), audit.entry_hash);

  // Real PostgreSQL read-only RLS role cannot see other tenants or edit rows.
  async function asTenant(tenantId, operation) {
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("SET LOCAL ROLE orbicore_tenant_readonly");
      if (tenantId !== null) await connection.query(
        "SELECT set_config('orbicore.tenant_id',$1,true)", [tenantId],
      );
      return await operation(connection);
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
    }
  }
  assert.equal(await asTenant(null, async (client) => {
    const rows = await client.query("SELECT COUNT(*)::int AS n FROM accounts");
    return rows.rows[0].n;
  }), 0);
  assert.equal(await asTenant("org-demo", async (client) => {
    const rows = await client.query("SELECT COUNT(*)::int AS n FROM accounts");
    return rows.rows[0].n;
  }), 3);
  assert.equal(await asTenant(newOrg, async (client) => {
    const rows = await client.query("SELECT COUNT(*)::int AS n FROM accounts");
    return rows.rows[0].n;
  }), 1);
  assert.equal(await asTenant(newOrg, async (client) => {
    const accounts = await client.query("SELECT id FROM accounts ORDER BY id");
    const sites = await client.query("SELECT id FROM sites ORDER BY id");
    const users = await client.query("SELECT id FROM users ORDER BY id");
    const sessions = await client.query("SELECT token_hash FROM sessions");
    const orgs = await client.query("SELECT id FROM organizations");
    const otherOrgJob = await client.query("SELECT id FROM jobs");
    assert.deepEqual(accounts.rows.map(r => r.id), ["account-other-ci"]);
    assert.deepEqual(sites.rows.map(r => r.id), ["site-other-ci"]);
    assert.deepEqual(users.rows.map(r => r.id), ["user-other-ci"]);
    assert.deepEqual(orgs.rows.map(r => r.id), [newOrg]);
    assert.equal(sessions.rowCount, 0);
    assert.equal(otherOrgJob.rowCount, 0);
    return true;
  }), true);
  await assert.rejects(asTenant("org-demo", (client) => client.query(
    "UPDATE users SET disabled=TRUE WHERE id=$1", [owner.id],
  )), (error) => error.code === "42501");

  // Default-safe rerun does not merge partially or overwrite identities.
  await assert.rejects(copySyntheticIdentitySnapshot({
    sqlite: app.db, postgres: pool, consent: "fixture_only_offline_copy",
  }), /nonempty_postgres_target_refused/);
  assert.equal((await pool.query(
    "SELECT COUNT(*)::int AS n FROM sessions",
  )).rows[0].n, 1);

  console.log(JSON.stringify({
    task: "ORB-005",
    kind: "synthetic-sqlite-to-postgres-identity-core-and-readonly-rls",
    sqliteAuditCheckedBeforeCopy: true,
    unsupportedAuthStateRefused: true,
    tamperedAuditRefused: true,
    destinationEmptyGuard: true,
    counts: result.counts,
    postgresIdentitySessionLookup: "passed",
    postgresTenantAndSitesRls: "passed",
    rlsMissingTenantFailsClosed: true,
    roleCannotUpdate: true,
    crossTenantSessionForeignKey: "passed",
    originalAuditHashChainPreserved: true,
    productionCutover: false,
    fullSqliteV7StateMigrated: false,
    multiFactorStateMigrated: false,
    liveProviderActions: false,
  }));
} finally {
  app.close();
  await pool.end();
}
