import { verifyAuditChain } from "./audit.mjs";

// Deliberately limited offline copy of a synthetic SQLite identity snapshot.
// It does not switch HTTP authentication, migrate MFA/passkeys, or write to an
// existing PostgreSQL destination. The source stays unchanged.
const UNSUPPORTED = [
  "passkeys", "webauthn_challenges", "authenticators", "recovery_codes",
  "login_challenges", "notification_outbox", "recovery_contacts",
  "secret_references", "bootstrap_tokens",
];
const SQL_TABLES = [
  "organizations", "users", "accounts", "sites", "sessions", "audit_events",
];
const HASH = /^[0-9a-f]{64}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function createPostgresIdentityCoreReader(database) {
  if (!database || typeof database.query !== "function") {
    throw new TypeError("PostgreSQL identity reader requires a query(sql, parameters) client");
  }
  return Object.freeze({
    async actorForSession({ tokenHash, at = new Date() }) {
      if (typeof tokenHash !== "string" || !HASH.test(tokenHash)) {
        throw new TypeError("tokenHash must be an SHA-256 hex digest");
      }
      if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
        throw new TypeError("at must be a valid Date");
      }
      const result = await database.query(
        "SELECT u.id, u.organization_id AS \"organizationId\", u.email, u.role, " +
        "u.mfa_enabled AS \"mfaEnabled\" " +
        "FROM sessions s JOIN users u ON u.id = s.user_id " +
        "AND u.organization_id = s.organization_id " +
        "WHERE s.token_hash = $1 AND s.expires_at > $2 AND u.disabled = FALSE " +
        "AND (u.mfa_enabled = FALSE OR s.mfa_verified = TRUE)",
        [tokenHash, at.toISOString()],
      );
      return result.rows[0] ?? null;
    },
    async accountForTenant({ organizationId, accountId }) {
      if (!ID.test(organizationId ?? "") || !ID.test(accountId ?? "")) {
        throw new TypeError("organizationId/accountId must be valid identifiers");
      }
      const result = await database.query(
        "SELECT id, organization_id AS \"organizationId\", label, source " +
        "FROM accounts WHERE organization_id = $1 AND id = $2",
        [organizationId, accountId],
      );
      return result.rows[0] ?? null;
    },
  });
}

function verifySyntheticSource(sqlite) {
  const scoped = {};
  for (const table of SQL_TABLES) scoped[table] = sqlite.prepare("SELECT * FROM " + table).all();

  if (scoped.users.length === 0) throw new Error("identity_snapshot_requires_bootstrapped_user");
  if (scoped.accounts.some((row) => row.source !== "mock_fixture")) {
    throw new Error("live_account_copy_refused");
  }
  if (scoped.users.some((row) => row.mfa_enabled !== 0)) {
    throw new Error("mfa_enabled_copy_not_supported");
  }
  for (const table of UNSUPPORTED) {
    if (sqlite.prepare("SELECT 1 FROM " + table + " LIMIT 1").get()) {
      throw new Error("unsupported_auth_state:" + table);
    }
  }
  const normalizedEmails = new Set();
  for (const user of scoped.users) {
    const normalized = String(user.email ?? "").toLowerCase();
    if (normalizedEmails.has(normalized)) throw new Error("ambiguous_cross_tenant_email");
    normalizedEmails.add(normalized);
  }
  for (const org of scoped.organizations) {
    const check = verifyAuditChain(sqlite, org.id);
    if (!check.valid || check.legacyUnchainedCount > 0) {
      throw new Error("source_audit_chain_unverifiable");
    }
  }
  // Do not return user secrets, password hashes or session hashes in results.
  return scoped;
}

export async function copySyntheticIdentitySnapshot({ sqlite, postgres, consent = null }) {
  if (consent !== "fixture_only_offline_copy") {
    throw new Error("explicit_synthetic_offline_copy_required");
  }
  if (!sqlite || typeof sqlite.prepare !== "function" || typeof sqlite.exec !== "function") {
    throw new TypeError("A SQLite DatabaseSync instance is required");
  }
  if (!postgres || typeof postgres.connect !== "function") {
    throw new TypeError("A PostgreSQL Pool is required");
  }

  sqlite.exec("BEGIN IMMEDIATE");
  let connection;
  let inTransaction = false;
  try {
    const source = verifySyntheticSource(sqlite);
    connection = await postgres.connect();
    await connection.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    inTransaction = true;
    await connection.query("SELECT pg_advisory_xact_lock(564221, 5)");
    const occupied = await connection.query(
      "SELECT " + SQL_TABLES.map((table) =>
        "(SELECT COUNT(*) FROM " + table + ") AS " + table,
      ).join(", "),
    );
    if (SQL_TABLES.some((table) => Number(occupied.rows[0][table]) !== 0)) {
      throw new Error("nonempty_postgres_target_refused");
    }

    for (const row of source.organizations) {
      await connection.query(
        "INSERT INTO organizations(id, name, created_at) VALUES ($1,$2,$3)",
        [row.id, row.name, row.created_at],
      );
    }
    for (const row of source.users) {
      await connection.query(
        "INSERT INTO users(id, organization_id, email, password_salt, password_hash, " +
        "role, disabled, mfa_enabled, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [row.id, row.organization_id, row.email, row.password_salt, row.password_hash,
          row.role, Boolean(row.disabled), Boolean(row.mfa_enabled), row.created_at],
      );
    }
    for (const row of source.accounts) {
      await connection.query(
        "INSERT INTO accounts(id, organization_id, label, provider, host, username, " +
        "health, used_bytes, quota_bytes, last_synced_at, source, capability_profile) " +
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
        [row.id, row.organization_id, row.label, row.provider, row.host, row.username,
          row.health, row.used_bytes, row.quota_bytes, row.last_synced_at, row.source, row.capability_profile],
      );
    }
    for (const row of source.sites) {
      await connection.query(
        "INSERT INTO sites(id, account_id, domain, kind, document_root, php_version, status) " +
        "VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [row.id, row.account_id, row.domain, row.kind, row.document_root, row.php_version, row.status],
      );
    }
    for (const row of source.sessions) {
      const user = source.users.find((entry) => entry.id === row.user_id);
      if (!user) throw new Error("orphaned_source_session_refused");
      await connection.query(
        "INSERT INTO sessions(token_hash, organization_id, user_id, expires_at, " +
        "mfa_verified, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
        [row.token_hash, user.organization_id, row.user_id, row.expires_at,
          Boolean(row.mfa_verified), row.created_at],
      );
    }
    for (const row of source.audit_events) {
      await connection.query(
        "INSERT INTO audit_events(id, organization_id, actor, action, target_id, outcome, " +
        "created_at, details_json, details_raw_json, prev_hash, entry_hash) " +
        // Use distinct bind parameters: PostgreSQL coerces a reused JSONB
        // parameter to canonical text and would break the legacy SHA-256 chain.
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::text,$10,$11)",
        [row.id, row.organization_id, row.actor, row.action, row.target_id,
          row.outcome, row.created_at, row.details_json, row.details_json,
          row.prev_hash, row.entry_hash],
      );
    }
    const result = await connection.query(
      "SELECT " + SQL_TABLES.map((table) =>
        "(SELECT COUNT(*) FROM " + table + ") AS " + table,
      ).join(", "),
    );
    const counts = {};
    for (const table of SQL_TABLES) {
      counts[table] = source[table].length;
      if (Number(result.rows[0][table]) !== counts[table]) {
        throw new Error("postgres_snapshot_count_mismatch");
      }
    }
    // Check *exact* serialized audit JSON bytes survive JSONB conversion.
    const savedAudit = await connection.query(
      "SELECT id, details_raw_json FROM audit_events ORDER BY id",
    );
    const sourceAudit = new Map(source.audit_events.map((row) => [row.id, row.details_json]));
    if (savedAudit.rows.some((row) => row.details_raw_json !== sourceAudit.get(row.id))) {
      throw new Error("audit_serialization_mismatch");
    }
    await connection.query("COMMIT");
    inTransaction = false;
    return Object.freeze({ scope: "synthetic_core_only", counts, target: "postgres" });
  } catch (error) {
    if (connection && inTransaction) {
      try { await connection.query("ROLLBACK"); } catch { /* original failure wins */ }
    }
    throw error;
  } finally {
    if (connection) connection.release();
    sqlite.exec("ROLLBACK"); // Release snapshot lock; no source writes.
  }
}
