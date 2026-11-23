import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync, existsSync, unlinkSync, statSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID, randomBytes, createHash, scryptSync, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { decryptMfaSecret, decryptMfaSecretWithFallback, encodeBase32, encryptMfaSecret, mfaEncryptionKey, newRecoveryCodes, parseMfaKeyring, recoveryCodeHash, verifyTotp } from "./mfa.mjs";
import { CAPABILITY_PROFILES, redactSecrets, resolveContainedPath, validateCpanelApiHost, validateExternalEndpoint } from "./security.mjs";
import { createLocalNotificationAdapter, dispatchRecoveryNotification, issueRecoveryContactVerification, verifyRecoveryContactToken } from "./notifications.mjs";
import { buildDeploymentReadiness, buildDiagnosticBundle, createDatabaseBackup, listBackups, runPreflight, runRestoreDrill, verifyBackupFile } from "./preflight.mjs";
import { createMockCpanelAdapter, LiveCpanelAdapterBoundary } from "./cpanel-adapter.mjs";
import { APPROVAL_MODES, buildAgencyReadinessReport, executePolicyRuleDryRun, generateAdvisoryInsights, RULE_TYPES } from "./automation.mjs";
import { appendAuditEvent, verifyAuditChain } from "./audit.mjs";
import { CI_SOURCE_RECOVERY_HOLD_ERROR, rejectCiSourceRecoveryHold } from "./sqlite-recovery-hold.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const defaultFixturePath = resolve(here, "fixtures/cpanel-uapi-inventory.json");
const distWebDir = resolve(here, "../../dist/web");
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const AUTH_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const AUTH_FAILURE_LIMIT = 10;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const passwordHash = (password, salt) => scryptSync(password, salt, 64).toString("hex");
function safeEqual(left, right) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(header, name) {
  const prefix = `${name}=`;
  return (header ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length) ?? null;
}

const LOOPBACK_PROXY_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// The development Vite proxy uses loopback. Do not accept client-supplied
// forwarded authority/protocol from arbitrary remote network clients.
export function isTrustedLocalProxy(remoteAddress) {
  return LOOPBACK_PROXY_ADDRESSES.has(remoteAddress);
}

export function isForwardedHttps(request) {
  if (!isTrustedLocalProxy(request?.socket?.remoteAddress)) return false;
  const proto = request?.headers?.["x-forwarded-proto"];
  return typeof proto === "string" && proto.split(",")[0].trim().toLowerCase() === "https";
}

export function effectiveOriginHost(request) {
  const forwardedHost = isTrustedLocalProxy(request?.socket?.remoteAddress)
    ? request?.headers?.["x-forwarded-host"] : null;
  return (typeof forwardedHost === "string" ? forwardedHost.split(",")[0].trim() : request?.headers?.host) ?? "";
}

export function configuredApiHost(env = process.env) {
  const host = env.ORBICORE_API_HOST;
  return typeof host === "string" && host.trim() ? host.trim() : "127.0.0.1";
}

function setSessionCookie(response, token, secure, request = null) {
  // HTTPS is a transport signal, not consent to send session cookies in
  // cross-site requests. Keep Strict for both local and HTTPS proxy sessions.
  const transportHttps = request?.socket?.encrypted === true || isForwardedHttps(request);
  const useSecure = secure || transportHttps;
  const flags = `Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${useSecure ? "; Secure" : ""}`;
  response.setHeader("set-cookie", token ? `orbicore_session=${token}; ${flags}` : `orbicore_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${useSecure ? "; Secure" : ""}`);
}

// Origin is a scheme + authority tuple, not just a Host match. A browser
// Origin from HTTPS must not authorize writes over direct HTTP (or vice versa).
// Do not trust X-Forwarded-* from non-loopback peers.
export function isSameOriginRequest(request) {
  const origin = request?.headers?.origin;
  const authority = effectiveOriginHost(request);
  if (typeof origin !== "string" || !origin ||
      typeof authority !== "string" || !authority ||
      /[\s\/?#@\\]/u.test(authority)) return false;
  const scheme = request?.socket?.encrypted === true || isForwardedHttps(request)
    ? "https:" : "http:";
  try {
    const actual = new URL(origin);
    const expected = new URL(`${scheme}//${authority}`);
    // Origin header values must be serialized origins, without a path,
    // query, fragment or user-info. Normalized ports/hostnames compare equal.
    return actual.protocol === scheme &&
      actual.origin === expected.origin &&
      actual.origin !== "null" &&
      actual.pathname === "/" && !actual.search && !actual.hash &&
      !actual.username && !actual.password &&
      expected.pathname === "/" && !expected.search && !expected.hash &&
      !expected.username && !expected.password;
  } catch {
    return false;
  }
}

function allowSameOrigin(request, response) {
  // Missing Origin is allowed for non-browser clients, as before. An
  // explicitly supplied invalid/empty Origin fails closed.
  if (request.headers.origin === undefined) return true;
  if (isSameOriginRequest(request)) return true;
  json(response, 403, { error: "origin_denied" });
  return false;
}

function json(response, status, data) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(data));
}

async function readJson(request, limit = 32768) {
  // Bound bytes, not UTF-16 code units. Decode only after joining chunks so a
  // multibyte UTF-8 sequence split across TCP chunks is never corrupted.
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.byteLength;
    if (totalBytes > limit) throw Object.assign(new Error("Request body is too large."), { status: 413 });
    chunks.push(bytes);
  }
  if (totalBytes === 0) return {};
  let raw;
  try { raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, totalBytes)); }
  catch { throw Object.assign(new Error("Request body must be valid UTF-8."), { status: 400 }); }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 }); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("Request body must be a JSON object."), { status: 400 });
  }
  return parsed;
}

function readFixture(fixturePath) {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  if (!fixture || !Array.isArray(fixture.accounts) || fixture.accounts.length === 0) {
    throw new Error("Inventory fixture must contain at least one account.");
  }
  return fixture;
}

function createDatabase(dbPath, fixture) {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL DEFAULT 'org-demo' REFERENCES organizations(id),
      label TEXT NOT NULL,
      provider TEXT NOT NULL,
      host TEXT NOT NULL,
      username TEXT NOT NULL,
      health TEXT NOT NULL CHECK (health IN ('healthy', 'attention', 'offline')),
      used_bytes INTEGER NOT NULL CHECK (used_bytes >= 0),
      quota_bytes INTEGER NOT NULL CHECK (quota_bytes >= 0),
      last_synced_at TEXT,
      source TEXT NOT NULL CHECK (source IN ('mock_fixture', 'provider')),
      UNIQUE (id, organization_id)
    );
    CREATE TABLE IF NOT EXISTS sites (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      domain TEXT NOT NULL,
      kind TEXT NOT NULL,
      document_root TEXT NOT NULL,
      php_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'attention'))
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      organization_id TEXT NOT NULL DEFAULT 'org-demo' REFERENCES organizations(id),
      account_id TEXT NOT NULL,
      requested_by TEXT,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      result_json TEXT,
      error TEXT,
      FOREIGN KEY (account_id, organization_id) REFERENCES accounts(id, organization_id)
    );
    CREATE INDEX IF NOT EXISTS jobs_state_created ON jobs(status, created_at);
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL DEFAULT 'org-demo' REFERENCES organizations(id),
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      created_at TEXT NOT NULL,
      details_json TEXT NOT NULL,
      prev_hash TEXT,
      entry_hash TEXT
    );
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      email TEXT NOT NULL COLLATE NOCASE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
      disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
      mfa_enabled INTEGER NOT NULL DEFAULT 0 CHECK (mfa_enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      UNIQUE (organization_id, email)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      mfa_verified INTEGER NOT NULL DEFAULT 0 CHECK (mfa_verified IN (0, 1)),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user_expiry ON sessions(user_id, expires_at);
    CREATE TABLE IF NOT EXISTS bootstrap_tokens (
      token_hash TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS passkeys (
      credential_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports_json TEXT NOT NULL DEFAULT '[]',
      device_type TEXT NOT NULL,
      backed_up INTEGER NOT NULL DEFAULT 0 CHECK (backed_up IN (0, 1)),
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id);
    CREATE TABLE IF NOT EXISTS webauthn_challenges (
      handle_hash TEXT PRIMARY KEY,
      challenge TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK (purpose IN ('registration', 'login')),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS authenticators (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      encrypted_secret TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      pending_expires_at TEXT,
      last_totp_step INTEGER NOT NULL DEFAULT -1
    );
    CREATE TABLE IF NOT EXISTS recovery_codes (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      used_at TEXT,
      PRIMARY KEY (user_id, code_hash)
    );
    CREATE TABLE IF NOT EXISTS login_challenges (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notification_outbox (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event TEXT NOT NULL,
      recipient TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recovery_contacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel TEXT NOT NULL,
      address TEXT NOT NULL,
      verified_at TEXT,
      verification_token_hash TEXT,
      verification_expires_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (user_id, channel)
    );
    CREATE TABLE IF NOT EXISTS capability_snapshots (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      profile_name TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      source TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS migration_plans (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      source_account_id TEXT NOT NULL,
      target_account_id TEXT NOT NULL,
      strategy TEXT NOT NULL CHECK (strategy IN ('wordpress_optimized', 'generic_php', 'whm_account_package')),
      state TEXT NOT NULL CHECK (state IN ('planned', 'preflight', 'snapshot', 'transfer', 'restore', 'verify', 'ready_for_cutover', 'cutover', 'monitor', 'completed', 'blocked', 'failed', 'rolled_back')),
      preflight_json TEXT NOT NULL,
      checksum_sha256 TEXT,
      rollback_note TEXT,
      blocker_reason TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (source_account_id, organization_id) REFERENCES accounts(id, organization_id),
      FOREIGN KEY (target_account_id, organization_id) REFERENCES accounts(id, organization_id)
    );
    CREATE TABLE IF NOT EXISTS storage_policies (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      account_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('media_offload', 'backup_archival', 'static_assets')),
      target_endpoint TEXT NOT NULL,
      target_bucket TEXT NOT NULL,
      threshold_percent INTEGER NOT NULL CHECK (threshold_percent >= 50 AND threshold_percent <= 99),
      estimated_reclaim_bytes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('dry_run_only', 'paused')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (account_id, organization_id) REFERENCES accounts(id, organization_id)
    );
    CREATE TABLE IF NOT EXISTS site_snapshots (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      checksum_sha256 TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS automation_rules (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      name TEXT NOT NULL,
      rule_type TEXT NOT NULL CHECK (rule_type IN ('inventory_stale_refresh', 'quota_threshold_alert', 'backup_snapshot_schedule')),
      approval_mode TEXT NOT NULL CHECK (approval_mode IN ('manual_approval', 'dry_run_bounded')),
      daily_run_cap INTEGER NOT NULL DEFAULT 3 CHECK (daily_run_cap >= 1 AND daily_run_cap <= 50),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      last_run_at TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      rule_id TEXT NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL,
      status TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wp_site_state (
      site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      core_version TEXT NOT NULL DEFAULT '6.7.2',
      previous_core_version TEXT,
      pending_updates INTEGER NOT NULL DEFAULT 0,
      previous_pending_updates INTEGER,
      staging_url TEXT,
      staging_created_at TEXT,
      last_restore_point_sha256 TEXT,
      last_action TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS secret_references (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      label TEXT NOT NULL,
      kind TEXT NOT NULL,
      reference_uri TEXT NOT NULL,
      masked_preview TEXT NOT NULL,
      encrypted_payload TEXT NOT NULL,
      key_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
  `);

  const accountColumns = new Set(db.prepare("PRAGMA table_info(accounts)").all().map((column) => column.name));
  if (!accountColumns.has("organization_id")) db.exec("ALTER TABLE accounts ADD COLUMN organization_id TEXT NOT NULL DEFAULT 'org-demo'");
  if (!accountColumns.has("capability_profile")) db.exec("ALTER TABLE accounts ADD COLUMN capability_profile TEXT NOT NULL DEFAULT 'cpanel_uapi_standard'");
  const jobColumns = new Set(db.prepare("PRAGMA table_info(jobs)").all().map((column) => column.name));
  if (!jobColumns.has("organization_id")) db.exec("ALTER TABLE jobs ADD COLUMN organization_id TEXT NOT NULL DEFAULT 'org-demo'");
  if (!jobColumns.has("requested_by")) db.exec("ALTER TABLE jobs ADD COLUMN requested_by TEXT");
  const auditColumns = new Set(db.prepare("PRAGMA table_info(audit_events)").all().map((column) => column.name));
  if (!auditColumns.has("organization_id")) db.exec("ALTER TABLE audit_events ADD COLUMN organization_id TEXT NOT NULL DEFAULT 'org-demo'");
  if (!auditColumns.has("prev_hash")) db.exec("ALTER TABLE audit_events ADD COLUMN prev_hash TEXT");
  if (!auditColumns.has("entry_hash")) db.exec("ALTER TABLE audit_events ADD COLUMN entry_hash TEXT");
  const userColumns = new Set(db.prepare("PRAGMA table_info(users)").all().map((column) => column.name));
  if (!userColumns.has("mfa_enabled")) db.exec("ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0 CHECK (mfa_enabled IN (0, 1))");
  const sessionColumns = new Set(db.prepare("PRAGMA table_info(sessions)").all().map((column) => column.name));
  if (!sessionColumns.has("mfa_verified")) db.exec("ALTER TABLE sessions ADD COLUMN mfa_verified INTEGER NOT NULL DEFAULT 0 CHECK (mfa_verified IN (0, 1))");
  const outboxColumns = new Set(db.prepare("PRAGMA table_info(notification_outbox)").all().map((column) => column.name));
  if (!outboxColumns.has("attempts")) db.exec("ALTER TABLE notification_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
  if (!outboxColumns.has("last_error")) db.exec("ALTER TABLE notification_outbox ADD COLUMN last_error TEXT");
  if (!outboxColumns.has("idempotency_key")) db.exec("ALTER TABLE notification_outbox ADD COLUMN idempotency_key TEXT");
  if (!outboxColumns.has("updated_at")) db.exec("ALTER TABLE notification_outbox ADD COLUMN updated_at TEXT");
  const migrationColumns = new Set(db.prepare("PRAGMA table_info(migration_plans)").all().map((column) => column.name));
  if (!migrationColumns.has("checkpoint_percent")) db.exec("ALTER TABLE migration_plans ADD COLUMN checkpoint_percent INTEGER NOT NULL DEFAULT 0");
  if (!migrationColumns.has("failed_at_stage")) db.exec("ALTER TABLE migration_plans ADD COLUMN failed_at_stage TEXT");
  const storageColumns = new Set(db.prepare("PRAGMA table_info(storage_policies)").all().map((column) => column.name));
  if (!storageColumns.has("last_drill_status")) db.exec("ALTER TABLE storage_policies ADD COLUMN last_drill_status TEXT");
  if (!storageColumns.has("last_drill_at")) db.exec("ALTER TABLE storage_policies ADD COLUMN last_drill_at TEXT");

  const now = new Date().toISOString();
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (1, 'initial_inventory_auth', ?)").run(now);
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (2, 'preflight_contacts_capabilities_migrations_storage', ?)").run(now);
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (3, 'team_rbac_site_snapshots_restore_drill', ?)").run(now);
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (4, 'automation_rules_storage_drills_migration_checkpoints', ?)").run(now);
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (5, 'wordpress_lifecycle_staging_and_rollback', ?)").run(now);
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (6, 'audit_chain_and_job_recovery', ?)").run(now);
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (7, 'secret_references_and_deployment_readiness', ?)").run(now);
  db.prepare("INSERT OR IGNORE INTO organizations (id, name, created_at) VALUES ('org-demo', 'Pella Global', ?)").run(now);

  const accountCount = db.prepare("SELECT COUNT(*) AS count FROM accounts").get().count;
  if (accountCount === 0) {
    const insertAccount = db.prepare(`INSERT INTO accounts
      (id, label, provider, host, username, health, used_bytes, quota_bytes, last_synced_at, source, capability_profile)
      VALUES (?, ?, 'cPanel', ?, ?, ?, ?, ?, ?, 'mock_fixture', ?)`);
    const insertSite = db.prepare(`INSERT INTO sites
      (id, account_id, domain, kind, document_root, php_version, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insertSnapshot = db.prepare(`INSERT INTO capability_snapshots
      (id, account_id, organization_id, profile_name, capabilities_json, source, fetched_at)
      VALUES (?, ?, 'org-demo', ?, ?, 'mock_fixture', ?)`);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const account of fixture.accounts) {
        const profileName = account.health === "attention" ? "cpanel_uapi_restricted" : "cpanel_uapi_standard";
        insertAccount.run(account.id, account.label, account.host, account.username, account.health, account.usedBytes, account.quotaBytes, fixture.metadata.fetchedAt, profileName);
        insertSnapshot.run(randomUUID(), account.id, profileName, JSON.stringify(CAPABILITY_PROFILES[profileName]), fixture.metadata.fetchedAt);
        for (const site of account.sites) {
          insertSite.run(site.id, account.id, site.domain, site.kind, site.documentRoot, site.phpVersion, site.status);
        }
      }
      const seededAt = fixture.metadata.fetchedAt;
      db.prepare(`INSERT OR IGNORE INTO migration_plans (id, organization_id, site_id, source_account_id, target_account_id, strategy, state, checkpoint_percent, failed_at_stage, preflight_json, checksum_sha256, rollback_note, blocker_reason, created_by, created_at, updated_at)
        VALUES (?, 'org-demo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed-demo', ?, ?)`).run(
        "demo-mig-01",
        "site-copperline-blog",
        "acct-copperline",
        "acct-fieldwork",
        "wordpress_optimized",
        "ready_for_cutover",
        85,
        null,
        JSON.stringify({ sameAccount: false, estimatedSiteBytes: 4294967296, targetFreeBytes: 29527900160, quotaFit: true, phpVersion: "8.1", dnsSeparateWorkstream: true, whmRequired: false, whmPermitted: false, dryRunOnly: true }),
        "d4f8c9a1b2e3745198c0a1e2f3456789abcdef0123456789abcdef0123456789",
        "Source files remain untouched until post-cutover retention gate.",
        null,
        seededAt,
        seededAt,
      );
      db.prepare(`INSERT OR IGNORE INTO migration_plans (id, organization_id, site_id, source_account_id, target_account_id, strategy, state, checkpoint_percent, failed_at_stage, preflight_json, checksum_sha256, rollback_note, blocker_reason, created_by, created_at, updated_at)
        VALUES (?, 'org-demo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed-demo', ?, ?)`).run(
        "demo-mig-02",
        "site-northstar-preview",
        "acct-northstar",
        "acct-fieldwork",
        "generic_php",
        "failed",
        30,
        "transfer",
        JSON.stringify({ sameAccount: false, estimatedSiteBytes: 2684354560, targetFreeBytes: 29527900160, quotaFit: true, phpVersion: "8.1", dnsSeparateWorkstream: true, whmRequired: false, whmPermitted: false, dryRunOnly: true }),
        null,
        "Source files remain untouched until post-cutover retention gate.",
        "Simulated 30% archive stream timeout — resume idempotently from checkpoint.",
        seededAt,
        seededAt,
      );
      db.prepare(`INSERT OR IGNORE INTO storage_policies (id, organization_id, account_id, mode, target_endpoint, target_bucket, threshold_percent, estimated_reclaim_bytes, status, last_drill_status, last_drill_at, created_by, created_at)
        VALUES (?, 'org-demo', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed-demo', ?)`).run(
        "demo-pol-01",
        "acct-copperline",
        "media_offload",
        "https://s3.eu-central-1.example.invalid",
        "orbicore-copperline-media-archive",
        80,
        34200000000,
        "dry_run_only",
        "rehydration_verified",
        seededAt,
        seededAt,
      );
      db.prepare(`INSERT OR IGNORE INTO storage_policies (id, organization_id, account_id, mode, target_endpoint, target_bucket, threshold_percent, estimated_reclaim_bytes, status, last_drill_status, last_drill_at, created_by, created_at)
        VALUES (?, 'org-demo', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed-demo', ?)`).run(
        "demo-pol-02",
        "acct-northstar",
        "backup_archival",
        "https://s3.us-east-1.example.invalid",
        "orbicore-northstar-backups",
        85,
        28900000000,
        "paused",
        "outage_fail_closed_verified",
        seededAt,
        seededAt,
      );
      db.prepare(`INSERT OR IGNORE INTO site_snapshots (id, organization_id, site_id, action, status, checksum_sha256, details_json, created_by, created_at)
        VALUES (?, 'org-demo', ?, ?, 'completed', ?, ?, 'seed-demo', ?)`).run(
        "demo-snap-01",
        "site-northstar-main",
        "archive_backup",
        "a1b2c3d4e5f60123456789abcdef0123456789abcdef0123456789abcdef0123",
        JSON.stringify({ domain: "northstar-studio.example", archiveScope: "wp_content_and_db", dryRun: true, sizeEstimateMb: 640 }),
        seededAt,
      );
      db.prepare(`INSERT OR IGNORE INTO site_snapshots (id, organization_id, site_id, action, status, checksum_sha256, details_json, created_by, created_at)
        VALUES (?, 'org-demo', ?, ?, 'completed', ?, ?, 'seed-demo', ?)`).run(
        "demo-snap-02",
        "site-copperline-main",
        "preflight_check",
        "b2c3d4e5f60123456789abcdef0123456789abcdef0123456789abcdef01234a",
        JSON.stringify({ domain: "copperline.example", phpRecommendation: "8.3", dryRun: true }),
        seededAt,
      );
      db.prepare(`INSERT OR IGNORE INTO wp_site_state (site_id, organization_id, core_version, previous_core_version, pending_updates, previous_pending_updates, staging_url, staging_created_at, last_restore_point_sha256, last_action, updated_at)
        VALUES (?, 'org-demo', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "site-northstar-shop",
        "6.7.2",
        "6.6.4",
        1,
        3,
        "https://staging.shop.northstar-studio.example",
        seededAt,
        "c3d4e5f60123456789abcdef0123456789abcdef0123456789abcdef01234ab1",
        "staging_create",
        seededAt,
      );
      db.prepare(`INSERT OR IGNORE INTO wp_site_state (site_id, organization_id, core_version, previous_core_version, pending_updates, previous_pending_updates, staging_url, staging_created_at, last_restore_point_sha256, last_action, updated_at)
        VALUES (?, 'org-demo', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "site-copperline-main",
        "6.6.4",
        null,
        2,
        null,
        null,
        null,
        null,
        "preflight_scanned",
        seededAt,
      );
      db.prepare(`INSERT OR IGNORE INTO automation_rules (id, organization_id, name, rule_type, approval_mode, daily_run_cap, enabled, last_run_at, created_by, created_at)
        VALUES (?, 'org-demo', ?, ?, ?, ?, 1, ?, 'seed-demo', ?)`).run(
        "demo-rule-01",
        "Stale cPanel inventory check (Demo)",
        "inventory_stale_refresh",
        "dry_run_bounded",
        5,
        seededAt,
        seededAt,
      );
      db.prepare(`INSERT OR IGNORE INTO automation_rules (id, organization_id, name, rule_type, approval_mode, daily_run_cap, enabled, last_run_at, created_by, created_at)
        VALUES (?, 'org-demo', ?, ?, ?, ?, 1, ?, 'seed-demo', ?)`).run(
        "demo-rule-02",
        "Quota >85% offload advisory (Demo)",
        "quota_threshold_alert",
        "manual_approval",
        3,
        seededAt,
        seededAt,
      );
      db.prepare(`INSERT OR IGNORE INTO automation_runs (id, organization_id, rule_id, actor_id, status, summary_json, created_at)
        VALUES (?, 'org-demo', ?, 'seed-demo', 'completed', ?, ?)`).run(
        "demo-run-01",
        "demo-rule-01",
        JSON.stringify({ dryRun: true, evaluatedAccounts: 3, candidateRefreshIds: ["acct-northstar", "acct-copperline", "acct-fieldwork"] }),
        seededAt,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return db;
}

function accountFromRow(row) {
  return {
    id: row.id,
    label: row.label,
    provider: row.provider,
    host: row.host,
    username: row.username,
    health: row.health,
    siteCount: row.site_count,
    usedBytes: row.used_bytes,
    quotaBytes: row.quota_bytes,
    lastSyncedAt: row.last_synced_at,
    source: row.source,
    capabilityProfile: row.capability_profile ?? "cpanel_uapi_standard",
  };
}

function jobFromRow(row) {
  return {
    id: row.id,
    type: row.type,
    accountId: row.account_id,
    accountLabel: row.account_label,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error,
  };
}

export function createApp({ dbPath = process.env.ORBICORE_DB_PATH ?? resolve(here, "../../.data/orbicore.sqlite"), fixturePath = defaultFixturePath, startWorker = true, bootstrapToken: suppliedBootstrapToken, mfaKey: suppliedMfaKey, mfaPreviousKeys = process.env.ORBICORE_MFA_PREVIOUS_KEYS, mfaKeyId = process.env.ORBICORE_MFA_KEY_ID ?? "k1", notificationAdapter = createLocalNotificationAdapter(), mfaClock = () => Date.now(), webauthnRPID = process.env.ORBICORE_WEBAUTHN_RP_ID ?? "localhost", webauthnOrigin = process.env.ORBICORE_WEBAUTHN_ORIGIN ?? "http://localhost:41750", jobRepository = null } = {}) {
  // This is a test-only hybrid adapter: identity/accounts are still held in
  // SQLite and cannot be atomically committed with PostgreSQL job/audit rows.
  // Keep the legacy local worker disabled; this mode does not execute jobs.
  if (jobRepository !== null && (
    startWorker || typeof jobRepository.enqueue !== "function" ||
    typeof jobRepository.getJob !== "function" ||
    typeof jobRepository.listJobs !== "function"
  )) {
    throw new TypeError("An injected PostgreSQL job repository requires startWorker:false and enqueue/getJob/listJobs methods.");
  }
  const fixture = readFixture(fixturePath);
  const db = createDatabase(dbPath, fixture);
  // Check a durable CI-only hold in the same SQLite write transaction as
  // normal restart recovery. A held source must never be silently requeued.
  // Ordinary deployments without a hold keep their original recovery policy.
  db.exec("BEGIN IMMEDIATE");
  try {
    rejectCiSourceRecoveryHold(db);
    const orphanedJobs = db.prepare(
      "SELECT id, organization_id, account_id, requested_by FROM jobs WHERE status = 'running'",
    ).all();
    if(orphanedJobs.length>0){
      const recoveredAt=new Date().toISOString();
      db.prepare("UPDATE jobs SET status = 'queued', error = 'recovered_after_restart' WHERE status = 'running'").run();
      for(const orphan of orphanedJobs){
        appendAuditEvent(db,{
          organizationId:orphan.organization_id,
          actor:orphan.requested_by??"system",
          action:"job.crash_recovery",
          targetId:orphan.id,
          outcome:"requeued",
          createdAt:recoveredAt,
          details:{accountId:orphan.account_id,previousStatus:"running"},
        });
      }
    }
    db.exec("COMMIT");
  }catch(error){
    try{db.exec("ROLLBACK");}catch{/* preserve original startup failure */}
    db.close();
    throw error;
  }

  const mockCpanelAdapter = createMockCpanelAdapter(fixture);
  const liveAdapterBoundary = new LiveCpanelAdapterBoundary();
  const packageJson = JSON.parse(readFileSync(resolve(here, "../../package.json"), "utf8"));
  const accountQuery = db.prepare(`SELECT a.*, COUNT(s.id) AS site_count FROM accounts a
    LEFT JOIN sites s ON s.account_id = a.id WHERE a.organization_id = ? GROUP BY a.id ORDER BY a.label`);
  const jobQuery = db.prepare(`SELECT j.*, a.label AS account_label FROM jobs j
    JOIN accounts a ON a.id = j.account_id WHERE j.organization_id = ? ORDER BY j.created_at DESC LIMIT 20`);
  const bootstrapTokenPath = dbPath === ":memory:" ? null : resolve(dirname(dbPath), "first-admin.token");
  let bootstrapToken = suppliedBootstrapToken;
  if (db.prepare("SELECT COUNT(*) AS count FROM users").get().count === 0) {
    const saved = db.prepare("SELECT token_hash FROM bootstrap_tokens LIMIT 1").get();
    if (bootstrapToken) {
      db.prepare("INSERT OR REPLACE INTO bootstrap_tokens (token_hash, created_at) VALUES (?, ?)").run(sha256(bootstrapToken), new Date().toISOString());
    } else if (!saved || (bootstrapTokenPath && !existsSync(bootstrapTokenPath))) {
      bootstrapToken = randomBytes(32).toString("base64url");
      db.prepare("DELETE FROM bootstrap_tokens").run();
      db.prepare("INSERT INTO bootstrap_tokens (token_hash, created_at) VALUES (?, ?)").run(sha256(bootstrapToken), new Date().toISOString());
      if (bootstrapTokenPath) writeFileSync(bootstrapTokenPath, `${bootstrapToken}\n`, { mode: 0o600 });
    }
  }
  const authFailures = new Map();
  const secureCookie = process.env.ORBICORE_COOKIE_SECURE === "1";
  let mfaKeyring = parseMfaKeyring({ primary: suppliedMfaKey ?? process.env.ORBICORE_MFA_ENCRYPTION_KEY, previous: mfaPreviousKeys, primaryId: mfaKeyId });
  const getMfaKey = () => mfaKeyring?.primaryKey ?? null;

  function actorFor(request) {
    const token = cookieValue(request.headers.cookie, "orbicore_session");
    if (!token) return null;
    const row = db.prepare(`SELECT u.id, u.email, u.role, u.organization_id AS organizationId, u.mfa_enabled AS mfaEnabled
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0 AND (u.mfa_enabled = 0 OR s.mfa_verified = 1)`).get(sha256(token), new Date().toISOString());
    return row ?? null;
  }

  function issueSession(user, response, mfaVerified = false, request = null) {
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const expires = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, mfa_verified, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(sha256(token), user.id, expires, mfaVerified ? 1 : 0, now.toISOString());
    setSessionCookie(response, token, secureCookie, request);
  }

  function transaction(operation) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function authRateLimited(request, response) {
    const key = request.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const attempts = (authFailures.get(key) ?? []).filter((time) => now - time < AUTH_FAILURE_WINDOW_MS);
    if (attempts.length >= AUTH_FAILURE_LIMIT) {
      authFailures.set(key, attempts);
      json(response, 429, { error: "auth_rate_limited" });
      return true;
    }
    authFailures.set(key, attempts);
    return false;
  }

  function registerAuthFailure(request) {
    const key = request.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const attempts = (authFailures.get(key) ?? []).filter((time) => now - time < AUTH_FAILURE_WINDOW_MS);
    attempts.push(now);
    authFailures.set(key, attempts);
  }

  function postgresJobForApi(job, organizationId) {
    const account = db.prepare("SELECT label FROM accounts WHERE id = ? AND organization_id = ?").get(job.accountId, organizationId);
    return {
      id: job.id,
      type: job.type,
      accountId: job.accountId,
      accountLabel: account?.label ?? null,
      status: job.status,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      result: job.result ?? null,
      error: job.error ?? null,
    };
  }

  function getOverview(organizationId) {
    const accounts = accountQuery.all(organizationId).map(accountFromRow);
    const jobs = jobQuery.all(organizationId).map(jobFromRow);
    return {
      accounts,
      jobs,
      counts: {
        accounts: accounts.length,
        sites: accounts.reduce((sum, account) => sum + account.siteCount, 0),
        healthy: accounts.filter((account) => account.health === "healthy").length,
        attention: accounts.filter((account) => account.health === "attention").length,
      },
      storage: {
        usedBytes: accounts.reduce((sum, account) => sum + account.usedBytes, 0),
        quotaBytes: accounts.reduce((sum, account) => sum + account.quotaBytes, 0),
      },
      source: "mock_fixture",
      liveConnections: 0,
      fetchedAt: new Date().toISOString(),
    };
  }

  async function processNextJob() {
    // The source hold can be established after app startup. Lock before
    // inspecting the marker and claiming so marker DDL cannot slip between
    // the deny check and the queued -> running transition.
    const candidate = transaction(() => {
      rejectCiSourceRecoveryHold(db);
      const queued = db.prepare("SELECT id, account_id, organization_id, requested_by FROM jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1").get();
      if (!queued) return null;
      const startedAt = new Date().toISOString();
      const claimed = db.prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'").run(startedAt, queued.id);
      return claimed.changes === 1 ? queued : null;
    });
    if (!candidate) return null;
    try {
      const actor = db.prepare("SELECT id, organization_id, role, disabled FROM users WHERE id = ?").get(candidate.requested_by);
      if (!actor || actor.disabled || actor.organization_id !== candidate.organization_id || !["owner", "admin", "operator"].includes(actor.role)) {
        throw new Error("The requesting actor no longer has permission to refresh inventory.");
      }
      const account = db.prepare("SELECT * FROM accounts WHERE id = ? AND organization_id = ?").get(candidate.account_id, candidate.organization_id);
      if (!account) throw new Error("The hosting account no longer exists.");
      const fixtureAccount = fixture.accounts.find((entry) => entry.id === account.id);
      if (!fixtureAccount && account.source !== "mock_fixture") throw new Error("The mock adapter has no fixture for this account.");
      const siteCount = fixtureAccount
        ? fixtureAccount.sites.length
        : db.prepare("SELECT COUNT(*) AS count FROM sites WHERE account_id = ?").get(account.id).count;
      const now = new Date().toISOString();
      const result = { source: "mock_fixture", live: false, accountId: account.id, sites: siteCount, fetchedAt: now };
      transaction(() => {
        // A hold committed after claim but before completion must not allow
        // job/account/audit mutations to advance the signed source snapshot.
        rejectCiSourceRecoveryHold(db);
        db.prepare("UPDATE accounts SET last_synced_at = ?, source = 'mock_fixture' WHERE id = ? AND organization_id = ?").run(now, account.id, candidate.organization_id);
        db.prepare("UPDATE jobs SET status = 'completed', completed_at = ?, result_json = ?, error = NULL WHERE id = ?")
          .run(now, JSON.stringify(result), candidate.id);
        appendAuditEvent(db, { organizationId: candidate.organization_id, actor: actor.id, action: "inventory.refresh", targetId: account.id, outcome: "completed", createdAt: now, details: { source: "mock_fixture", live: false, jobId: candidate.id } });
      });
      return { id: candidate.id, status: "completed", result };
    } catch (error) {
      // A hold is not an ordinary job failure; never rewrite the held row
      // to failed or append a misleading error audit.
      if (error?.message === CI_SOURCE_RECOVERY_HOLD_ERROR) throw error;
      const now = new Date().toISOString();
      const safeError = error instanceof Error ? error.message.slice(0, 240) : "Refresh failed.";
      transaction(() => {
        rejectCiSourceRecoveryHold(db);
        db.prepare("UPDATE jobs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?").run(now, safeError, candidate.id);
        appendAuditEvent(db, { organizationId: candidate.organization_id, actor: candidate.requested_by ?? "system", action: "inventory.refresh", targetId: candidate.account_id, outcome: "failed", createdAt: now, details: { jobId: candidate.id, reason: safeError } });
      });
      return { id: candidate.id, status: "failed", error: safeError };
    }
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/") && (request.method === "GET" || request.method === "HEAD")) {
      const indexFile = resolve(distWebDir, "index.html");
      if (existsSync(indexFile)) {
        let pathname = "/";
        try { pathname = decodeURIComponent(url.pathname); } catch { return json(response, 400, { error: "invalid_path" }); }
        const relativePath = pathname.replace(/^\/+/, "");
        const candidate = relativePath ? resolve(distWebDir, relativePath) : indexFile;
        const safeInsideDist = candidate === distWebDir || candidate.startsWith(`${distWebDir}${sep}`);
        let targetFile = indexFile;
        if (safeInsideDist && existsSync(candidate) && statSync(candidate).isFile()) {
          targetFile = candidate;
        }
        const contentType = MIME_TYPES[extname(targetFile).toLowerCase()] ?? "application/octet-stream";
        const body = readFileSync(targetFile);
        response.writeHead(200, { "content-type": contentType, "content-length": body.byteLength });
        return response.end(request.method === "HEAD" ? undefined : body);
      }
      return json(response, 404, { error: "not_found" });
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      return json(response, 200, { status: "ok", database: "sqlite_local", source: "mock_fixture", liveConnections: 0 });
    }
    if (request.method === "GET" && url.pathname === "/api/auth/bootstrap-status") {
      return json(response, 200, { required: db.prepare("SELECT COUNT(*) AS count FROM users").get().count === 0 });
    }
    if (request.method === "POST" && url.pathname === "/api/auth/bootstrap") {
      if (!allowSameOrigin(request, response)) return;
      if (authRateLimited(request, response)) return;
      try {
        const body = await readJson(request);
        const saved = db.prepare("SELECT token_hash FROM bootstrap_tokens LIMIT 1").get();
        const tokenMatches = saved && typeof body.token === "string" && safeEqual(saved.token_hash, sha256(body.token));
        if (!tokenMatches) {
          registerAuthFailure(request);
          return json(response, 401, { error: "invalid_bootstrap_token" });
        }
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        const password = body.password;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json(response, 400, { error: "invalid_email" });
        if (typeof password !== "string" || password.length < 12 || password.length > 256) return json(response, 400, { error: "password_policy" });
        if (db.prepare("SELECT COUNT(*) AS count FROM users").get().count !== 0) return json(response, 409, { error: "bootstrap_already_completed" });
        const user = { id: randomUUID(), email, role: "owner", organizationId: "org-demo" };
        const salt = randomBytes(16).toString("hex");
        const now = new Date().toISOString();
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("INSERT INTO users (id, organization_id, email, password_salt, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, 'owner', ?)")
            .run(user.id, user.organizationId, email, salt, passwordHash(password, salt), now);
          db.prepare("DELETE FROM bootstrap_tokens").run();
          appendAuditEvent(db, { organizationId: user.organizationId, actor: user.id, action: "auth.bootstrap", targetId: user.id, outcome: "completed", createdAt: now, details: {} });
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
        if (bootstrapTokenPath && existsSync(bootstrapTokenPath)) unlinkSync(bootstrapTokenPath);
        issueSession(user, response, false, request);
        authFailures.delete(request.socket.remoteAddress ?? "unknown");
        return json(response, 201, { user });
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "internal_error" });
      }
    }
    if (request.method === "GET" && url.pathname === "/api/auth/passkeys") {
      const actor = actorFor(request);
      if (!actor) return json(response, 401, { error: "authentication_required" });
      const passkeys = db.prepare("SELECT credential_id AS credentialId, device_type AS deviceType, backed_up AS backedUp, created_at AS createdAt, last_used_at AS lastUsedAt FROM passkeys WHERE user_id = ? ORDER BY created_at, credential_id").all(actor.id);
      return json(response, 200, { passkeys });
    }
    const revokePasskeyMatch = url.pathname.match(/^\/api\/auth\/passkeys\/([^/]+)$/);
    if (request.method === "DELETE" && revokePasskeyMatch) {
      if (!allowSameOrigin(request, response)) return;
      const actor = actorFor(request);
      if (!actor) return json(response, 401, { error: "authentication_required" });
      if (authRateLimited(request, response)) return;
      try {
        const credentialId = decodeURIComponent(revokePasskeyMatch[1]);
        const body = await readJson(request);
        const user = db.prepare("SELECT password_salt, password_hash FROM users WHERE id = ? AND disabled = 0").get(actor.id);
        const candidate = typeof body.password === "string" && body.password.length <= 256 ? passwordHash(body.password, user?.password_salt ?? "orbicore-no-user-salt") : "";
        if (!user || !safeEqual(candidate, user.password_hash)) {
          registerAuthFailure(request);
          return json(response, 401, { error: "reauthentication_required" });
        }
        const now = new Date().toISOString();
        const removed = db.prepare("DELETE FROM passkeys WHERE credential_id = ? AND user_id = ?").run(credentialId, actor.id);
        if (removed.changes !== 1) return json(response, 404, { error: "passkey_not_found" });
        appendAuditEvent(db, { organizationId: actor.organizationId, actor: actor.id, action: "auth.passkey.revoke", targetId: credentialId, outcome: "completed", createdAt: now, details: { passwordReauthenticated: true } });
        authFailures.delete(request.socket.remoteAddress ?? "unknown");
        return json(response, 200, { revoked: true, credentialId });
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "internal_error" });
      }
    }
    if (request.method === "POST" && url.pathname === "/api/auth/passkeys/register/options") {
      if (!allowSameOrigin(request, response)) return;
      const actor = actorFor(request);
      if (!actor) return json(response, 401, { error: "authentication_required" });
      if (!["owner", "admin"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      if (authRateLimited(request, response)) return;
      try {
        const body = await readJson(request);
        const user = db.prepare("SELECT password_salt, password_hash FROM users WHERE id = ? AND disabled = 0").get(actor.id);
        const candidate = typeof body.password === "string" && body.password.length <= 256 ? passwordHash(body.password, user?.password_salt ?? "orbicore-no-user-salt") : "";
        if (!user || !safeEqual(candidate, user.password_hash)) {
          registerAuthFailure(request);
          return json(response, 401, { error: "reauthentication_required" });
        }
        authFailures.delete(request.socket.remoteAddress ?? "unknown");
        const existing = db.prepare("SELECT credential_id, transports_json FROM passkeys WHERE user_id = ?").all(actor.id);
        const options = await generateRegistrationOptions({
          rpName: "VSN ORBICORE",
          rpID: webauthnRPID,
          userName: actor.email,
          userDisplayName: actor.email,
          userID: Buffer.from(actor.id),
          attestationType: "none",
          excludeCredentials: existing.map((row) => ({ id: row.credential_id, transports: JSON.parse(row.transports_json) })),
          authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
          supportedAlgorithmIDs: [-7, -257],
          timeout: 60_000,
        });
        const handle = randomBytes(32).toString("base64url");
        const now = new Date(mfaClock());
        const expires = new Date(now.getTime() + 5 * 60_000).toISOString();
        db.prepare("DELETE FROM webauthn_challenges WHERE user_id = ? OR expires_at <= ?").run(actor.id, now.toISOString());
        db.prepare("INSERT INTO webauthn_challenges (handle_hash, challenge, user_id, purpose, expires_at, created_at) VALUES (?, ?, ?, 'registration', ?, ?)")
          .run(sha256(handle), options.challenge, actor.id, expires, now.toISOString());
        return json(response, 200, { challengeHandle: handle, options, expiresAt: expires });
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "webauthn_unavailable" });
      }
    }
    if (request.method === "POST" && url.pathname === "/api/auth/passkeys/register/verify") {
      if (!allowSameOrigin(request, response)) return;
      const actor = actorFor(request);
      if (!actor) return json(response, 401, { error: "authentication_required" });
      if (authRateLimited(request, response)) return;
      try {
        const body = await readJson(request);
        if (typeof body.challengeHandle !== "string" || !body.response || body.challengeHandle.length > 120) return json(response, 400, { error: "invalid_request" });
        const handleHash = sha256(body.challengeHandle);
        const now = new Date(mfaClock()).toISOString();
        const pending = db.prepare("SELECT challenge, expires_at FROM webauthn_challenges WHERE handle_hash = ? AND user_id = ? AND purpose = 'registration'").get(handleHash, actor.id);
        db.prepare("DELETE FROM webauthn_challenges WHERE handle_hash = ?").run(handleHash);
        if (!pending || pending.expires_at <= now) return json(response, 410, { error: "webauthn_challenge_expired" });
        const result = await verifyRegistrationResponse({
          response: body.response,
          expectedChallenge: pending.challenge,
          expectedOrigin: webauthnOrigin,
          expectedRPID: webauthnRPID,
          requireUserVerification: true,
        });
        if (!result.verified || !result.registrationInfo) {
          registerAuthFailure(request);
          return json(response, 401, { error: "webauthn_verification_failed" });
        }
        const info = result.registrationInfo;
        const credential = info.credential;
        const createdAt = new Date(mfaClock()).toISOString();
        db.prepare("INSERT INTO passkeys (credential_id, user_id, public_key, counter, transports_json, device_type, backed_up, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(credential.id, actor.id, Buffer.from(credential.publicKey).toString("base64"), credential.counter,
            JSON.stringify(credential.transports ?? []), info.credentialDeviceType, info.credentialBackedUp ? 1 : 0, createdAt);
        appendAuditEvent(db, { organizationId: actor.organizationId, actor: actor.id, action: "auth.passkey.enroll", targetId: credential.id, outcome: "completed", createdAt, details: { deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp } });
        authFailures.delete(request.socket.remoteAddress ?? "unknown");
        return json(response, 201, { enrolled: true, credentialId: credential.id, deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp });
      } catch (error) {
        return json(response, error.status ?? 401, { error: error.status ? "invalid_request" : "webauthn_verification_failed" });
      }
    }
    if (request.method === "POST" && url.pathname === "/api/auth/passkeys/login/options") {
      if (!allowSameOrigin(request, response)) return;
      if (authRateLimited(request, response)) return;
      try {
        const body = await readJson(request);
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        const user = email.length <= 254 ? db.prepare("SELECT id FROM users WHERE email = ? AND disabled = 0").get(email) : null;
        const credentials = user ? db.prepare("SELECT credential_id, transports_json FROM passkeys WHERE user_id = ?").all(user.id) : [];
        if (!user || credentials.length === 0) {
          registerAuthFailure(request);
          return json(response, 401, { error: "passkey_unavailable" });
        }
        const options = await generateAuthenticationOptions({
          rpID: webauthnRPID,
          allowCredentials: credentials.map((row) => ({ id: row.credential_id, transports: JSON.parse(row.transports_json) })),
          userVerification: "required",
          timeout: 60_000,
        });
        const handle = randomBytes(32).toString("base64url");
        const now = new Date(mfaClock());
        const expires = new Date(now.getTime() + 5 * 60_000).toISOString();
        db.prepare("DELETE FROM webauthn_challenges WHERE user_id = ? OR expires_at <= ?").run(user.id, now.toISOString());
        db.prepare("INSERT INTO webauthn_challenges (handle_hash, challenge, user_id, purpose, expires_at, created_at) VALUES (?, ?, ?, 'login', ?, ?)")
          .run(sha256(handle), options.challenge, user.id, expires, now.toISOString());
        return json(response, 200, { challengeHandle: handle, options, expiresAt: expires });
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "webauthn_unavailable" });
      }
    }
    if (request.method === "POST" && url.pathname === "/api/auth/passkeys/login/verify") {
      if (!allowSameOrigin(request, response)) return;
      if (authRateLimited(request, response)) return;
      try {
        const body = await readJson(request);
        if (typeof body.challengeHandle !== "string" || !body.response || body.challengeHandle.length > 120) return json(response, 401, { error: "invalid_passkey_challenge" });
        const handleHash = sha256(body.challengeHandle);
        const now = new Date(mfaClock()).toISOString();
        const pending = db.prepare("SELECT c.challenge, c.user_id, c.expires_at, u.id, u.email, u.role, u.organization_id, u.mfa_enabled FROM webauthn_challenges c JOIN users u ON u.id = c.user_id WHERE c.handle_hash = ? AND c.purpose = 'login' AND u.disabled = 0").get(handleHash);
        db.prepare("DELETE FROM webauthn_challenges WHERE handle_hash = ?").run(handleHash);
        if (!pending || pending.expires_at <= now) return json(response, 401, { error: "invalid_passkey_challenge" });
        const credential = db.prepare("SELECT credential_id, public_key, counter, transports_json FROM passkeys WHERE credential_id = ? AND user_id = ?").get(body.response.id, pending.user_id);
        if (!credential) {
          registerAuthFailure(request);
          return json(response, 401, { error: "invalid_passkey" });
        }
        const verification = await verifyAuthenticationResponse({
          response: body.response,
          expectedChallenge: pending.challenge,
          expectedOrigin: webauthnOrigin,
          expectedRPID: webauthnRPID,
          credential: {
            id: credential.credential_id,
            publicKey: new Uint8Array(Buffer.from(credential.public_key, "base64")),
            counter: credential.counter,
            transports: JSON.parse(credential.transports_json),
          },
          requireUserVerification: true,
        });
        if (!verification.verified) {
          registerAuthFailure(request);
          return json(response, 401, { error: "webauthn_verification_failed" });
        }
        const info = verification.authenticationInfo;
        if (info.newCounter <= credential.counter && (credential.counter !== 0 || info.newCounter !== 0)) {
          registerAuthFailure(request);
          return json(response, 401, { error: "webauthn_counter_replay" });
        }
        const updated = db.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ? AND counter = ?")
          .run(info.newCounter, now, credential.credential_id, credential.counter);
        if (updated.changes !== 1) return json(response, 401, { error: "webauthn_counter_replay" });
        const user = { id: pending.id, email: pending.email, role: pending.role, organizationId: pending.organization_id, mfaEnabled: pending.mfa_enabled };
        issueSession(user, response, true, request);
        authFailures.delete(request.socket.remoteAddress ?? "unknown");
        return json(response, 200, { user, method: "passkey" });
      } catch (error) {
        registerAuthFailure(request);
        return json(response, error.status ?? 401, { error: error.status ? "invalid_request" : "webauthn_verification_failed" });
      }
    }
    if (request.method === "POST" && url.pathname === "/api/auth/mfa/enroll") {
      if (!allowSameOrigin(request, response)) return;
      const actor = actorFor(request);
      if (!actor) return json(response, 401, { error: "authentication_required" });
      if (!["owner", "admin"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      if (authRateLimited(request, response)) return;
      const mfaKey = getMfaKey();
      if (!mfaKey) return json(response, 503, { error: "mfa_key_unavailable" });
      try {
        const body = await readJson(request);
        const user = db.prepare("SELECT password_salt, password_hash FROM users WHERE id = ? AND disabled = 0").get(actor.id);
        const candidate = typeof body.password === "string" && body.password.length <= 256 ? passwordHash(body.password, user?.password_salt ?? "orbicore-no-user-salt") : "";
        if (!user || !safeEqual(candidate, user.password_hash)) {
          registerAuthFailure(request);
          return json(response, 401, { error: "reauthentication_required" });
        }
        authFailures.delete(request.socket.remoteAddress ?? "unknown");
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "internal_error" });
      }
      const enabled = db.prepare("SELECT enabled FROM authenticators WHERE user_id = ?").get(actor.id);
      if (enabled?.enabled) return json(response, 409, { error: "mfa_already_enabled" });
      const secret = encodeBase32(randomBytes(20));
      const now = new Date();
      const expires = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
      db.prepare(`INSERT INTO authenticators (user_id, encrypted_secret, enabled, pending_expires_at, last_totp_step)
        VALUES (?, ?, 0, ?, -1) ON CONFLICT(user_id) DO UPDATE SET encrypted_secret = excluded.encrypted_secret, enabled = 0, pending_expires_at = excluded.pending_expires_at, last_totp_step = -1`)
        .run(actor.id, encryptMfaSecret(secret, mfaKey, mfaKeyring.primaryId), expires);
      const label = encodeURIComponent(`VSN ORBICORE:${actor.email}`);
      const uri = `otpauth://totp/${label}?secret=${secret}&issuer=VSN%20ORBICORE&algorithm=SHA1&digits=6&period=30`;
      return json(response, 201, { secret, otpauthUri: uri, expiresAt: expires, assurance: "totp_fallback_not_phishing_resistant" });
    }
    if (request.method === "POST" && url.pathname === "/api/auth/mfa/confirm") {
      if (!allowSameOrigin(request, response)) return;
      const actor = actorFor(request);
      if (!actor) return json(response, 401, { error: "authentication_required" });
      if (!["owner", "admin"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      if (!mfaKeyring) return json(response, 503, { error: "mfa_key_unavailable" });
      try {
        const body = await readJson(request);
        const pending = db.prepare("SELECT encrypted_secret, pending_expires_at FROM authenticators WHERE user_id = ? AND enabled = 0").get(actor.id);
        if (!pending || !pending.pending_expires_at || pending.pending_expires_at <= new Date().toISOString()) return json(response, 410, { error: "mfa_enrollment_expired" });
        const secret = decryptMfaSecretWithFallback(pending.encrypted_secret, mfaKeyring);
        const acceptedStep = verifyTotp(secret, body.code, mfaClock());
        if (acceptedStep === null) {
          registerAuthFailure(request);
          return json(response, 401, { error: "invalid_mfa_code" });
        }
        const codes = newRecoveryCodes();
        const now = new Date().toISOString();
        transaction(() => {
          db.prepare("DELETE FROM sessions WHERE user_id = ?").run(actor.id);
          db.prepare("UPDATE authenticators SET enabled = 1, pending_expires_at = NULL, last_totp_step = ? WHERE user_id = ?").run(acceptedStep, actor.id);
          db.prepare("UPDATE users SET mfa_enabled = 1 WHERE id = ?").run(actor.id);
          db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").run(actor.id);
          const insertCode = db.prepare("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)");
          for (const code of codes) insertCode.run(actor.id, recoveryCodeHash(code));
          appendAuditEvent(db, { organizationId: actor.organizationId, actor: actor.id, action: "auth.mfa.enroll", targetId: actor.id, outcome: "completed", createdAt: now, details: { method: "totp_fallback", recoveryCodesIssued: codes.length } });
        });
        issueSession(actor, response, true, request);
        return json(response, 200, { enabled: true, recoveryCodes: codes, assurance: "totp_fallback_not_phishing_resistant" });
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "internal_error" });
      }
    }
    if (request.method === "POST" && url.pathname === "/api/auth/mfa/challenge") {
      if (!allowSameOrigin(request, response)) return;
      if (authRateLimited(request, response)) return;
      try {
        const body = await readJson(request);
        if (typeof body.challenge !== "string" || typeof body.code !== "string" || body.challenge.length > 120 || body.code.length > 80) {
          registerAuthFailure(request);
          return json(response, 401, { error: "invalid_mfa_challenge" });
        }
        const challengeHash = sha256(body.challenge);
        const challenge = db.prepare(`SELECT c.user_id, c.expires_at, u.organization_id, u.email, u.role, u.mfa_enabled
          FROM login_challenges c JOIN users u ON u.id = c.user_id WHERE c.token_hash = ? AND c.expires_at > ? AND u.disabled = 0`)
          .get(challengeHash, new Date().toISOString());
        if (!challenge || !challenge.mfa_enabled || !mfaKeyring) {
          registerAuthFailure(request);
          return json(response, 401, { error: "invalid_mfa_challenge" });
        }
        const authenticator = db.prepare("SELECT encrypted_secret, last_totp_step FROM authenticators WHERE user_id = ? AND enabled = 1").get(challenge.user_id);
        if (!authenticator) return json(response, 401, { error: "invalid_mfa_challenge" });
        let recovery = false;
        let acceptedStep = null;
        const normalized = body.code.replaceAll("-", "").toUpperCase();
        if (body.code.length >= 20 && /^[A-Z0-9_]{16,32}$/.test(normalized)) {
          const codeRow = db.prepare("SELECT code_hash FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL")
            .get(challenge.user_id, recoveryCodeHash(normalized));
          if (codeRow) recovery = true;
        } else if (mfaKeyring) {
          acceptedStep = verifyTotp(decryptMfaSecretWithFallback(authenticator.encrypted_secret, mfaKeyring), body.code, mfaClock(), authenticator.last_totp_step);
        }
        if (!recovery && acceptedStep === null) {
          registerAuthFailure(request);
          return json(response, 401, { error: "invalid_mfa_code" });
        }
        const now = new Date().toISOString();
        let notificationResult = null;
        transaction(() => {
          db.prepare("DELETE FROM login_challenges WHERE token_hash = ?").run(challengeHash);
          if (recovery) {
            db.prepare("UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL").run(now, challenge.user_id, recoveryCodeHash(normalized));
            db.prepare("DELETE FROM sessions WHERE user_id = ?").run(challenge.user_id);
          } else {
            db.prepare("UPDATE authenticators SET last_totp_step = ? WHERE user_id = ? AND last_totp_step < ?").run(acceptedStep, challenge.user_id, acceptedStep);
          }
        });
        if (recovery) {
          notificationResult = await dispatchRecoveryNotification(db, notificationAdapter, {
            userId: challenge.user_id,
            event: "auth.mfa_recovery_code_used",
            fallbackRecipient: challenge.email,
            idempotencyKey: `recovery:${challengeHash}`,
          });
          const noticeSummary = notificationResult.status === "blocked_unverified_contact"
            ? "queued_contact_unverified"
            : notificationResult.status;
          appendAuditEvent(db, { organizationId: challenge.organization_id, actor: challenge.user_id, action: "auth.mfa_recovery_code_used", targetId: challenge.user_id, outcome: "completed", createdAt: now, details: { sessionsRevoked: true, notification: noticeSummary } });
        }
        const user = { id: challenge.user_id, email: challenge.email, role: challenge.role, organizationId: challenge.organization_id, mfaEnabled: true };
        issueSession(user, response, true, request);
        authFailures.delete(request.socket.remoteAddress ?? "unknown");
        return json(response, 200, {
          user,
          recoveryCodeUsed: recovery,
          notification: recovery ? (notificationResult.status === "blocked_unverified_contact" ? "queued_contact_unverified" : notificationResult.status) : undefined,
        });
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "internal_error" });
      }
    }
    if (request.method === "POST" && url.pathname === "/api/auth/mfa/disable") {
      if (!allowSameOrigin(request, response)) return;
      const actor = actorFor(request);
      if (!actor) return json(response, 401, { error: "authentication_required" });
      if (!["owner", "admin"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      if (authRateLimited(request, response)) return;
      if (!mfaKeyring || !actor.mfaEnabled) return json(response, 409, { error: "mfa_not_enabled_or_key_unavailable" });
      try {
        const body = await readJson(request);
        const userRow = db.prepare("SELECT password_salt, password_hash FROM users WHERE id = ? AND disabled = 0").get(actor.id);
        const candidate = typeof body.password === "string" && body.password.length <= 256 ? passwordHash(body.password, userRow?.password_salt ?? "orbicore-no-user-salt") : "";
        const authenticator = db.prepare("SELECT encrypted_secret, last_totp_step FROM authenticators WHERE user_id = ? AND enabled = 1").get(actor.id);
        const acceptedStep = authenticator && typeof body.code === "string"
          ? verifyTotp(decryptMfaSecretWithFallback(authenticator.encrypted_secret, mfaKeyring), body.code, mfaClock(), authenticator.last_totp_step)
          : null;
        if (!userRow || !safeEqual(candidate, userRow.password_hash) || acceptedStep === null) {
          registerAuthFailure(request);
          return json(response, 401, { error: "reauthentication_required" });
        }
        const now = new Date().toISOString();
        transaction(() => {
          db.prepare("UPDATE users SET mfa_enabled = 0 WHERE id = ?").run(actor.id);
          db.prepare("DELETE FROM authenticators WHERE user_id = ?").run(actor.id);
          db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").run(actor.id);
          db.prepare("DELETE FROM login_challenges WHERE user_id = ?").run(actor.id);
          db.prepare("DELETE FROM sessions WHERE user_id = ?").run(actor.id);
          appendAuditEvent(db, { organizationId: actor.organizationId, actor: actor.id, action: "auth.mfa.disable", targetId: actor.id, outcome: "completed", createdAt: now, details: { sessionsRevoked: true, reauthenticated: true } });
        });
        setSessionCookie(response, null, secureCookie, request);
        authFailures.delete(request.socket.remoteAddress ?? "unknown");
        return json(response, 200, { disabled: true, sessionsRevoked: true });
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "internal_error" });
      }
    }
    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      if (!allowSameOrigin(request, response)) return;
      if (authRateLimited(request, response)) return;
      try {
        const body = await readJson(request);
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        const password = typeof body.password === "string" ? body.password : "";
        if (email.length > 254 || password.length > 256) {
          registerAuthFailure(request);
          return json(response, 401, { error: "invalid_credentials" });
        }
        const userRow = db.prepare("SELECT id, organization_id, email, password_salt, password_hash, role, mfa_enabled FROM users WHERE email = ? AND disabled = 0").get(email);
        const candidate = passwordHash(password, userRow?.password_salt ?? "orbicore-no-user-salt");
        if (!userRow || !safeEqual(candidate, userRow.password_hash)) {
          registerAuthFailure(request);
          return json(response, 401, { error: "invalid_credentials" });
        }
        const user = { id: userRow.id, email: userRow.email, role: userRow.role, organizationId: userRow.organization_id };
        authFailures.delete(request.socket.remoteAddress ?? "unknown");
        if (userRow.mfa_enabled) {
          if (!mfaKeyring) return json(response, 503, { error: "mfa_key_unavailable" });
          const challenge = randomBytes(32).toString("base64url");
          const now = new Date();
          const expires = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
          db.prepare("DELETE FROM login_challenges WHERE user_id = ? OR expires_at <= ?").run(user.id, now.toISOString());
          db.prepare("INSERT INTO login_challenges (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
            .run(sha256(challenge), user.id, expires, now.toISOString());
          return json(response, 202, { mfaRequired: true, challenge, expiresAt: expires });
        }
        issueSession(user, response, false, request);
        return json(response, 200, { user, mfaEnabled: false });
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "internal_error" });
      }
    }
    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      if (!allowSameOrigin(request, response)) return;
      const token = cookieValue(request.headers.cookie, "orbicore_session");
      if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
      setSessionCookie(response, null, secureCookie, request);
      return json(response, 200, { loggedOut: true });
    }
    if (request.method === "GET" && url.pathname === "/api/auth/me") {
      const actor = actorFor(request);
      return actor ? json(response, 200, { user: actor }) : json(response, 401, { error: "authentication_required" });
    }
    const actor = actorFor(request);
    if (!actor) return json(response, 401, { error: "authentication_required" });
    if (request.method === "GET" && url.pathname === "/api/overview") {
      const overview = getOverview(actor.organizationId);
      if (!jobRepository) return json(response, 200, overview);
      try {
        const jobs = await jobRepository.listJobs({ organizationId: actor.organizationId });
        return json(response, 200, { ...overview, jobs: jobs.map((job) => postgresJobForApi(job, actor.organizationId)), jobStorage: "postgres_test_only" });
      } catch {
        return json(response, 503, { error: "job_store_unavailable" });
      }
    }
    if (request.method === "GET" && url.pathname === "/api/accounts") return json(response, 200, { accounts: accountQuery.all(actor.organizationId).map(accountFromRow) });
    if (request.method === "GET" && url.pathname === "/api/audit") {
      if (!["owner", "admin"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
      const limit = Number.isInteger(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 50;
      const rows = db.prepare(`SELECT id, actor, action, target_id AS targetId, outcome, created_at AS createdAt, details_json, prev_hash AS prevHash, entry_hash AS entryHash
        FROM audit_events WHERE organization_id = ? ORDER BY rowid DESC LIMIT ?`).all(actor.organizationId, limit);
      return json(response, 200, { events: rows.map((row) => ({ ...row, details: JSON.parse(row.details_json), details_json: undefined })) });
    }
    if (request.method === "GET" && url.pathname === "/api/audit/verify") {
      if (!["owner", "admin"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      return json(response, 200, verifyAuditChain(db, actor.organizationId));
    }
    const sitesMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/sites$/);
    if (request.method === "GET" && sitesMatch) {
      const accountId = decodeURIComponent(sitesMatch[1]);
      if (!db.prepare("SELECT id FROM accounts WHERE id = ? AND organization_id = ?").get(accountId, actor.organizationId)) return json(response, 404, { error: "account_not_found" });
      const sites = db.prepare("SELECT s.id, s.account_id AS accountId, s.domain, s.kind, s.document_root AS documentRoot, s.php_version AS phpVersion, s.status FROM sites s JOIN accounts a ON a.id = s.account_id WHERE s.account_id = ? AND a.organization_id = ? ORDER BY s.domain").all(accountId, actor.organizationId);
      return json(response, 200, { sites, source: "mock_fixture", live: false });
    }
    if (request.method === "GET" && url.pathname === "/api/jobs") {
      if (!jobRepository) return json(response, 200, { jobs: jobQuery.all(actor.organizationId).map(jobFromRow) });
      try {
        const jobs = await jobRepository.listJobs({ organizationId: actor.organizationId });
        return json(response, 200, { jobs: jobs.map((job) => postgresJobForApi(job, actor.organizationId)), jobStorage: "postgres_test_only" });
      } catch {
        return json(response, 503, { error: "job_store_unavailable" });
      }
    }
    if (request.method === "POST" && url.pathname === "/api/jobs/refresh") {
      if (!allowSameOrigin(request, response)) return;
      if (!["owner", "admin", "operator"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      try {
        const body = await readJson(request);
        if (typeof body.accountId !== "string" || body.accountId.length > 100) return json(response, 400, { error: "invalid_account_id" });
        const account = db.prepare("SELECT id FROM accounts WHERE id = ? AND organization_id = ?").get(body.accountId, actor.organizationId);
        if (!account) return json(response, 404, { error: "account_not_found" });
        const suppliedKey = request.headers["idempotency-key"]?.toString().slice(0, 120) ?? null;
        if (jobRepository) {
          try {
            // The job is durable in PostgreSQL but the SQLite audit is not in
            // the same transaction. Keep this experimental mode test-only.
            const queued = await jobRepository.enqueue({
              organizationId: actor.organizationId,
              accountId: account.id,
              requestedBy: actor.id,
              idempotencyKey: suppliedKey || randomUUID(),
            });
            if (queued.created) {
              appendAuditEvent(db, {
                organizationId: actor.organizationId,
                actor: actor.id,
                action: "inventory.refresh",
                targetId: account.id,
                outcome: "queued",
                details: { source: "postgres_test_only", live: false, jobId: queued.job.id },
              });
            }
            return json(response, queued.created ? 202 : 200, {
              jobId: queued.job.id,
              status: queued.created ? "queued" : "existing",
              source: "mock_fixture",
              live: false,
              jobStorage: "postgres_test_only",
            });
          } catch (error) {
            return json(response, error.message === "idempotency_key_payload_conflict" ? 409 : 503, {
              error: error.message === "idempotency_key_payload_conflict" ? "idempotency_conflict" : "job_store_unavailable",
            });
          }
        }
        const idempotencyKey = suppliedKey ? `${actor.organizationId}:${suppliedKey}` : null;
        const existing = idempotencyKey ? db.prepare("SELECT id FROM jobs WHERE organization_id = ? AND idempotency_key = ?").get(actor.organizationId, idempotencyKey) : null;
        if (existing) return json(response, 200, { jobId: existing.id, status: "existing", source: "mock_fixture" });
        const id = randomUUID();
        const now = new Date().toISOString();
        transaction(() => {
          db.prepare("INSERT INTO jobs (id, type, organization_id, account_id, requested_by, status, idempotency_key, created_at) VALUES (?, 'inventory_refresh', ?, ?, ?, 'queued', ?, ?)")
            .run(id, actor.organizationId, account.id, actor.id, idempotencyKey, now);
          appendAuditEvent(db, { organizationId: actor.organizationId, actor: actor.id, action: "inventory.refresh", targetId: account.id, outcome: "queued", createdAt: now, details: { source: "mock_fixture", live: false, jobId: id } });
        });
        return json(response, 202, { jobId: id, status: "queued", source: "mock_fixture", live: false });
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "internal_error", message: error.message });
      }
    }
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (request.method === "GET" && jobMatch) {
      if (jobRepository) {
        try {
          const record = await jobRepository.getJob({ organizationId: actor.organizationId, id: decodeURIComponent(jobMatch[1]) });
          return record ? json(response, 200, { job: postgresJobForApi(record, actor.organizationId), jobStorage: "postgres_test_only" }) : json(response, 404, { error: "job_not_found" });
        } catch {
          return json(response, 503, { error: "job_store_unavailable" });
        }
      }
      const row = db.prepare("SELECT j.*, a.label AS account_label FROM jobs j JOIN accounts a ON a.id = j.account_id WHERE j.id = ? AND j.organization_id = ?").get(decodeURIComponent(jobMatch[1]), actor.organizationId);
      return row ? json(response, 200, { job: jobFromRow(row) }) : json(response, 404, { error: "job_not_found" });
    }
    if (request.method === "GET" && url.pathname === "/api/system/preflight") {
      if (!["owner", "admin"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      return json(response, 200, runPreflight({ db, dbPath, mfaKeyring, webauthnRPID, webauthnOrigin }));
    }
    if (request.method === "GET" && url.pathname === "/api/system/deployment-readiness") {
      if (!["owner", "admin"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      return json(response, 200, buildDeploymentReadiness({ mfaKeyring, webauthnOrigin, webauthnRPID }));
    }
    if (request.method === "GET" && url.pathname === "/api/secrets") {
      if (!["owner", "admin"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      const secrets = db.prepare(`SELECT id, label, kind, reference_uri AS referenceUri, masked_preview AS maskedPreview, key_id AS keyId, status, created_by AS createdBy, created_at AS createdAt, revoked_at AS revokedAt
        FROM secret_references WHERE organization_id = ? ORDER BY created_at DESC`).all(actor.organizationId);
      return json(response, 200, {
        encryptionReady: Boolean(mfaKeyring),
        activeKeyId: mfaKeyring?.primaryId ?? null,
        secrets,
      });
    }
    if (request.method === "POST" && url.pathname === "/api/secrets") {
      if (!allowSameOrigin(request, response)) return;
      if (!["owner", "admin"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      if (!mfaKeyring) return json(response, 503, { error: "mfa_key_unavailable" });
      try {
        const body = await readJson(request);
        const label = typeof body.label === "string" ? body.label.trim().slice(0, 80) : "";
        const kind = ["cpanel_uapi_token", "s3_access_key", "smtp_credential"].includes(body.kind) ? body.kind : "";
        const referenceUri = typeof body.referenceUri === "string" ? body.referenceUri.trim().slice(0, 180) : "";
        const secretValue = typeof body.secretValue === "string" ? body.secretValue.trim() : "";
        if (!label || !kind || !referenceUri || secretValue.length < 8 || secretValue.length > 512 || /[\r\n\0]/.test(referenceUri)) {
          return json(response, 400, { error: "invalid_secret_reference" });
        }
        if (/^https?:\/\//i.test(referenceUri)) {
          const check = validateExternalEndpoint(referenceUri);
          if (!check.valid) return json(response, 400, { error: check.reason });
        }
        const id = `sec-${randomBytes(5).toString("hex")}`;
        const encryptedPayload = encryptMfaSecret(secretValue, mfaKeyring.primaryKey, mfaKeyring.primaryId);
        const maskedPreview = `••••${secretValue.slice(-4)}`;
        const createdAt = new Date().toISOString();
        transaction(() => {
          db.prepare(`INSERT INTO secret_references
            (id, organization_id, label, kind, reference_uri, masked_preview, encrypted_payload, key_id, status, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
            .run(id, actor.organizationId, label, kind, referenceUri, maskedPreview, encryptedPayload, mfaKeyring.primaryId, actor.id, createdAt);
          appendAuditEvent(db, {
            organizationId: actor.organizationId,
            actor: actor.id,
            action: "secret.reference.create",
            targetId: id,
            outcome: "completed",
            createdAt,
            details: { label, kind, keyId: mfaKeyring.primaryId, maskedPreview },
          });
        });
        return json(response, 201, {
          secret: { id, label, kind, referenceUri, maskedPreview, keyId: mfaKeyring.primaryId, status: "active", createdBy: actor.id, createdAt, revokedAt: null },
        });
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "internal_error" });
      }
    }
    const secretRevokeMatch = url.pathname.match(/^\/api\/secrets\/([^/]+)\/revoke$/);
    if (request.method === "POST" && secretRevokeMatch) {
      if (!allowSameOrigin(request, response)) return;
      if (actor.role !== "owner") return json(response, 403, { error: "permission_denied" });
      const secretId = decodeURIComponent(secretRevokeMatch[1]);
      const existing = db.prepare("SELECT id, label, kind FROM secret_references WHERE id = ? AND organization_id = ?").get(secretId, actor.organizationId);
      if (!existing) return json(response, 404, { error: "secret_not_found" });
      const now = new Date().toISOString();
      transaction(() => {
        db.prepare("UPDATE secret_references SET status = 'revoked', encrypted_payload = '', revoked_at = ? WHERE id = ? AND organization_id = ?")
          .run(now, secretId, actor.organizationId);
        appendAuditEvent(db, {
          organizationId: actor.organizationId,
          actor: actor.id,
          action: "secret.reference.revoke",
          targetId: secretId,
          outcome: "completed",
          createdAt: now,
          details: { label: existing.label, kind: existing.kind },
        });
      });
      return json(response, 200, { id: secretId, status: "revoked", revokedAt: now });
    }
    if (request.method === "POST" && url.pathname === "/api/system/backup") {
      if (!allowSameOrigin(request, response)) return;
      if (actor.role !== "owner") return json(response, 403, { error: "permission_denied" });
      if (dbPath === ":memory:") return json(response, 400, { error: "in_memory_db_unsupported" });
      try {
        const backupsDir = resolve(dirname(dbPath), "backups");
        mkdirSync(backupsDir, { recursive: true });
        const fileName = `orbicore-${Date.now()}-${randomBytes(4).toString("hex")}.sqlite`;
        const destinationPath = resolveContainedPath(backupsDir, fileName);
        const backup = createDatabaseBackup(db, { dbPath, destinationPath });
        const verification = verifyBackupFile(destinationPath, backup.sha256);
        const now = new Date().toISOString();
        appendAuditEvent(db, { organizationId: actor.organizationId, actor: actor.id, action: "system.backup", targetId: fileName, outcome: verification.valid ? "completed" : "failed", createdAt: now, details: { sha256: backup.sha256, sizeBytes: backup.sizeBytes, valid: verification.valid } });
        return json(response, 201, { fileName, sizeBytes: backup.sizeBytes, sha256: backup.sha256, verified: verification.valid, createdAt: backup.createdAt });
      } catch (error) {
        return json(response, error.status ?? 500, { error: "backup_failed" });
      }
    }
    if (request.method === "POST" && url.pathname === "/api/system/mfa/rotate-keys") {
      if (!allowSameOrigin(request, response)) return;
      if (actor.role !== "owner") return json(response, 403, { error: "permission_denied" });
      if (authRateLimited(request, response)) return;
      if (!mfaKeyring) return json(response, 503, { error: "mfa_key_unavailable" });
      try {
        const body = await readJson(request);
        const userRow = db.prepare("SELECT password_salt, password_hash FROM users WHERE id = ? AND disabled = 0").get(actor.id);
        const candidate = typeof body.password === "string" && body.password.length <= 256 ? passwordHash(body.password, userRow?.password_salt ?? "orbicore-no-user-salt") : "";
        if (!userRow || !safeEqual(candidate, userRow.password_hash)) {
          registerAuthFailure(request);
          return json(response, 401, { error: "reauthentication_required" });
        }
        const nextKey = mfaEncryptionKey(body.newKey);
        const nextKeyId = typeof body.newKeyId === "string" && /^[a-zA-Z0-9_-]{2,24}$/.test(body.newKeyId) ? body.newKeyId : `k${Date.now()}`;
        if (!nextKey) return json(response, 400, { error: "invalid_new_key" });
        const rows = db.prepare(`SELECT a.user_id, a.encrypted_secret FROM authenticators a
          JOIN users u ON u.id = a.user_id WHERE u.organization_id = ?`).all(actor.organizationId);
        const reencrypted = rows.map((row) => {
          const plaintext = decryptMfaSecretWithFallback(row.encrypted_secret, mfaKeyring);
          return { userId: row.user_id, encryptedSecret: encryptMfaSecret(plaintext, nextKey, nextKeyId) };
        });
        const now = new Date().toISOString();
        transaction(() => {
          const update = db.prepare("UPDATE authenticators SET encrypted_secret = ? WHERE user_id = ?");
          for (const item of reencrypted) update.run(item.encryptedSecret, item.userId);
          appendAuditEvent(db, { organizationId: actor.organizationId, actor: actor.id, action: "auth.mfa.key_rotate", targetId: nextKeyId, outcome: "completed", createdAt: now, details: { rotatedCount: reencrypted.length, newKeyId: nextKeyId } });
        });
        const nextKeysMap = new Map(mfaKeyring.keys);
        nextKeysMap.set(nextKeyId, nextKey);
        mfaKeyring = { primaryId: nextKeyId, primaryKey: nextKey, keys: nextKeysMap };
        return json(response, 200, { rotated: reencrypted.length, activeKeyId: nextKeyId });
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "key_rotation_failed" });
      }
    }
    if (request.method === "GET" && url.pathname === "/api/auth/recovery-contacts") {
      const contacts = db.prepare(`SELECT id, channel, address, verified_at AS verifiedAt, verification_expires_at AS verificationExpiresAt, created_at AS createdAt
        FROM recovery_contacts WHERE user_id = ? ORDER BY created_at DESC`).all(actor.id);
      const outbox = db.prepare(`SELECT id, event, recipient, status, attempts, last_error AS lastError, created_at AS createdAt
        FROM notification_outbox WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`).all(actor.id);
      return json(response, 200, { contacts, outbox, adapterMode: notificationAdapter.mode, liveDelivery: false });
    }
    if (request.method === "POST" && url.pathname === "/api/auth/recovery-contacts") {
      if (!allowSameOrigin(request, response)) return;
      if (authRateLimited(request, response)) return;
      try {
        const body = await readJson(request);
        const userRow = db.prepare("SELECT password_salt, password_hash FROM users WHERE id = ? AND disabled = 0").get(actor.id);
        const candidate = typeof body.password === "string" && body.password.length <= 256 ? passwordHash(body.password, userRow?.password_salt ?? "orbicore-no-user-salt") : "";
        if (!userRow || !safeEqual(candidate, userRow.password_hash)) {
          registerAuthFailure(request);
          return json(response, 401, { error: "reauthentication_required" });
        }
        const issued = issueRecoveryContactVerification(db, { userId: actor.id, address: body.address });
        const now = new Date().toISOString();
        appendAuditEvent(db, { organizationId: actor.organizationId, actor: actor.id, action: "auth.recovery_contact.update", targetId: issued.contactId, outcome: "pending_verification", createdAt: now, details: { channel: issued.channel } });
        return json(response, 201, {
          contactId: issued.contactId,
          channel: issued.channel,
          address: issued.address,
          expiresAt: issued.expiresAt,
          localVerificationToken: issued.verificationToken,
          liveDelivery: false,
        });
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.code ?? (error.status ? "invalid_request" : "internal_error") });
      }
    }
    if (request.method === "POST" && url.pathname === "/api/auth/recovery-contacts/verify") {
      if (!allowSameOrigin(request, response)) return;
      try {
        const body = await readJson(request);
        const result = verifyRecoveryContactToken(db, { userId: actor.id, token: body.token });
        if (!result.verified) return json(response, 400, { error: result.reason });
        appendAuditEvent(db, { organizationId: actor.organizationId, actor: actor.id, action: "auth.recovery_contact.verify", targetId: result.contactId, outcome: "completed", createdAt: result.verifiedAt, details: { channel: result.channel } });
        return json(response, 200, result);
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "internal_error" });
      }
    }
    if (request.method === "POST" && url.pathname === "/api/accounts/sandbox") {
      if (!allowSameOrigin(request, response)) return;
      if (!["owner", "admin", "operator"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      try {
        const body = await readJson(request);
        const label = typeof body.label === "string" ? body.label.trim().slice(0, 80) : "";
        const username = typeof body.username === "string" ? body.username.trim().slice(0, 40) : "";
        const profileName = typeof body.capabilityProfile === "string" && body.capabilityProfile in CAPABILITY_PROFILES ? body.capabilityProfile : "cpanel_uapi_standard";
        const quotaGb = Number(body.quotaGb ?? 50);
        const hostCheck = validateCpanelApiHost(body.host);
        if (!label || !/^[a-zA-Z0-9_-]{2,32}$/.test(username) || !hostCheck.valid || !Number.isFinite(quotaGb) || quotaGb < 1 || quotaGb > 5000) {
          return json(response, 400, { error: hostCheck.valid ? "invalid_sandbox_account" : hostCheck.reason });
        }
        const id = `acct-${randomBytes(4).toString("hex")}`;
        const now = new Date().toISOString();
        const quotaBytes = Math.round(quotaGb * 1024 ** 3);
        const usedBytes = Math.round(quotaBytes * 0.18);
        const siteDomain = `${username.toLowerCase()}.${hostCheck.hostname}`;
        transaction(() => {
          db.prepare(`INSERT INTO accounts (id, organization_id, label, provider, host, username, health, used_bytes, quota_bytes, last_synced_at, source, capability_profile)
            VALUES (?, ?, ?, 'cPanel', ?, ?, 'healthy', ?, ?, ?, 'mock_fixture', ?)`)
            .run(id, actor.organizationId, label, hostCheck.hostname, username, usedBytes, quotaBytes, now, profileName);
          db.prepare(`INSERT INTO sites (id, account_id, domain, kind, document_root, php_version, status)
            VALUES (?, ?, ?, 'wordpress', ?, '8.3', 'active')`)
            .run(`site-${randomBytes(4).toString("hex")}`, id, siteDomain, `/home/${username}/public_html`);
          db.prepare(`INSERT INTO capability_snapshots (id, account_id, organization_id, profile_name, capabilities_json, source, fetched_at)
            VALUES (?, ?, ?, ?, ?, 'mock_fixture', ?)`)
            .run(randomUUID(), id, actor.organizationId, profileName, JSON.stringify(CAPABILITY_PROFILES[profileName]), now);
          appendAuditEvent(db, { organizationId: actor.organizationId, actor: actor.id, action: "account.sandbox.create", targetId: id, outcome: "completed", createdAt: now, details: { host: hostCheck.hostname, profile: profileName, live: false } });
        });
        const row = db.prepare(`SELECT a.*, COUNT(s.id) AS site_count FROM accounts a LEFT JOIN sites s ON s.account_id = a.id WHERE a.id = ? GROUP BY a.id`).get(id);
        return json(response, 201, { account: accountFromRow(row), source: "mock_fixture", live: false });
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "internal_error" });
      }
    }
    const capabilityMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/capabilities$/);
    if (request.method === "GET" && capabilityMatch) {
      const accountId = decodeURIComponent(capabilityMatch[1]);
      const account = db.prepare("SELECT id, label, capability_profile AS capabilityProfile FROM accounts WHERE id = ? AND organization_id = ?").get(accountId, actor.organizationId);
      if (!account) return json(response, 404, { error: "account_not_found" });
      const snapshot = db.prepare("SELECT profile_name AS profileName, capabilities_json AS capabilitiesJson, source, fetched_at AS fetchedAt FROM capability_snapshots WHERE account_id = ? AND organization_id = ? ORDER BY fetched_at DESC LIMIT 1").get(accountId, actor.organizationId);
      const capabilities = snapshot ? JSON.parse(snapshot.capabilitiesJson) : CAPABILITY_PROFILES[account.capabilityProfile] ?? CAPABILITY_PROFILES.cpanel_uapi_standard;
      return json(response, 200, {
        accountId: account.id,
        accountLabel: account.label,
        profileName: snapshot?.profileName ?? account.capabilityProfile,
        capabilities,
        source: snapshot?.source ?? "mock_fixture",
        fetchedAt: snapshot?.fetchedAt ?? null,
        live: false,
      });
    }
    if (request.method === "GET" && url.pathname === "/api/sites") {
      const sites = db.prepare(`SELECT s.id, s.account_id AS accountId, a.label AS accountLabel, a.host AS accountHost, s.domain, s.kind, s.document_root AS documentRoot, s.php_version AS phpVersion, s.status
        FROM sites s JOIN accounts a ON a.id = s.account_id WHERE a.organization_id = ? ORDER BY s.domain`).all(actor.organizationId);
      return json(response, 200, { sites, source: "mock_fixture", live: false });
    }
    if (request.method === "GET" && url.pathname === "/api/migrations") {
      const rows = db.prepare(`SELECT m.*, s.domain AS site_domain, sa.label AS source_label, ta.label AS target_label
        FROM migration_plans m
        JOIN sites s ON s.id = m.site_id
        JOIN accounts sa ON sa.id = m.source_account_id
        JOIN accounts ta ON ta.id = m.target_account_id
        WHERE m.organization_id = ? ORDER BY m.updated_at DESC`).all(actor.organizationId);
      return json(response, 200, {
        migrations: rows.map((row) => ({
          id: row.id,
          siteId: row.site_id,
          siteDomain: row.site_domain,
          sourceAccountId: row.source_account_id,
          sourceAccountLabel: row.source_label,
          targetAccountId: row.target_account_id,
          targetAccountLabel: row.target_label,
          strategy: row.strategy,
          state: row.state,
          checkpointPercent: row.checkpoint_percent ?? 0,
          failedAtStage: row.failed_at_stage ?? null,
          preflight: JSON.parse(row.preflight_json),
          checksumSha256: row.checksum_sha256,
          rollbackNote: row.rollback_note,
          blockerReason: row.blocker_reason,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          mode: "dry_run_simulation",
        })),
      });
    }
    if (request.method === "POST" && url.pathname === "/api/migrations") {
      if (!allowSameOrigin(request, response)) return;
      if (!["owner", "admin", "operator"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      try {
        const body = await readJson(request);
        const site = db.prepare(`SELECT s.*, a.organization_id, a.used_bytes, a.quota_bytes FROM sites s
          JOIN accounts a ON a.id = s.account_id WHERE s.id = ? AND a.organization_id = ?`).get(body.siteId, actor.organizationId);
        const target = db.prepare("SELECT * FROM accounts WHERE id = ? AND organization_id = ?").get(body.targetAccountId, actor.organizationId);
        if (!site || !target) return json(response, 404, { error: "site_or_target_not_found" });
        const strategy = ["wordpress_optimized", "generic_php", "whm_account_package"].includes(body.strategy) ? body.strategy : "wordpress_optimized";
        const freeTargetBytes = Math.max(0, target.quota_bytes - target.used_bytes);
        const estimatedSiteBytes = Math.max(512 * 1024 * 1024, Math.round(site.used_bytes * 0.35));
        const sameAccount = site.account_id === target.id;
        const targetProfile = CAPABILITY_PROFILES[target.capability_profile ?? "cpanel_uapi_standard"] ?? [];
        const whmAllowed = targetProfile.find((c) => c.capability === "whm.account_transfer")?.level === "supported";
        const whmBlocked = strategy === "whm_account_package" && !whmAllowed;
        const preflight = {
          sameAccount,
          estimatedSiteBytes,
          targetFreeBytes: freeTargetBytes,
          quotaFit: freeTargetBytes >= estimatedSiteBytes,
          phpVersion: site.php_version,
          dnsSeparateWorkstream: true,
          whmRequired: strategy === "whm_account_package",
          whmPermitted: whmAllowed,
          dryRunOnly: true,
        };
        const blockerReason = sameAccount
          ? "Source and destination hosting accounts must differ."
          : !preflight.quotaFit
            ? "Destination account lacks estimated free quota for safe snapshot restore."
            : whmBlocked
              ? "Target account capability profile does not permit WHM account packaging."
              : null;
        const id = randomUUID();
        const now = new Date().toISOString();
        const initialState = blockerReason ? "blocked" : "planned";
        transaction(() => {
          db.prepare(`INSERT INTO migration_plans (id, organization_id, site_id, source_account_id, target_account_id, strategy, state, preflight_json, blocker_reason, rollback_note, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, actor.organizationId, site.id, site.account_id, target.id, strategy, initialState, JSON.stringify(preflight), blockerReason, "Source files remain untouched until post-cutover retention gate.", actor.id, now, now);
          appendAuditEvent(db, { organizationId: actor.organizationId, actor: actor.id, action: "migration.plan.create", targetId: id, outcome: initialState, createdAt: now, details: { siteDomain: site.domain, strategy, dryRun: true } });
        });
        return json(response, 201, { id, state: initialState, checkpointPercent: 0, preflight, blockerReason });
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "internal_error" });
      }
    }
    const migrationAdvanceMatch = url.pathname.match(/^\/api\/migrations\/([^/]+)\/advance$/);
    if (request.method === "POST" && migrationAdvanceMatch) {
      if (!allowSameOrigin(request, response)) return;
      if (!["owner", "admin", "operator"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      try {
        const body = await readJson(request);
        const migrationId = decodeURIComponent(migrationAdvanceMatch[1]);
        const row = db.prepare("SELECT * FROM migration_plans WHERE id = ? AND organization_id = ?").get(migrationId, actor.organizationId);
        if (!row) return json(response, 404, { error: "migration_not_found" });

        const now = new Date().toISOString();
        if (body.simulatePartialFailure === true && row.state === "transfer") {
          const reason = "Simulated transfer interruption at 30% checkpoint; delta block manifest preserved for idempotent resume.";
          transaction(() => {
            db.prepare("UPDATE migration_plans SET state = 'failed', checkpoint_percent = 30, failed_at_stage = 'transfer', blocker_reason = ?, updated_at = ? WHERE id = ? AND organization_id = ?")
              .run(reason, now, row.id, actor.organizationId);
            appendAuditEvent(db, { organizationId: actor.organizationId, actor: actor.id, action: "migration.partial_failure", targetId: row.id, outcome: "failed", createdAt: now, details: { stage: "transfer", checkpointPercent: 30, dryRun: true } });
          });
          return json(response, 200, { id: row.id, state: "failed", checkpointPercent: 30, failedAtStage: "transfer", blockerReason: reason });
        }

        const transitions = {
          planned: "preflight",
          preflight: "snapshot",
          snapshot: "transfer",
          failed: row.failed_at_stage === "transfer" ? "restore" : null,
          transfer: "restore",
          restore: "verify",
          verify: "ready_for_cutover",
          ready_for_cutover: "cutover",
          cutover: "monitor",
          monitor: "completed",
        };
        const nextState = transitions[row.state];
        if (!nextState) return json(response, 409, { error: "migration_cannot_advance", state: row.state });
        if (nextState === "cutover" && body.confirmCutover !== true) {
          return json(response, 409, { error: "cutover_authorization_required" });
        }
        const nextCheckpoint = ["restore", "verify", "ready_for_cutover", "cutover", "monitor", "completed"].includes(nextState)
          ? 100
          : nextState === "transfer"
            ? 30
            : row.checkpoint_percent ?? 0;
        const checksum = row.checksum_sha256 ?? (nextState === "snapshot" ? sha256(`${row.id}:${row.site_id}:${now}`) : null);
        transaction(() => {
          db.prepare("UPDATE migration_plans SET state = ?, checksum_sha256 = ?, checkpoint_percent = ?, failed_at_stage = NULL, blocker_reason = NULL, updated_at = ? WHERE id = ? AND organization_id = ?")
            .run(nextState, checksum, nextCheckpoint, now, row.id, actor.organizationId);
          appendAuditEvent(db, { organizationId: actor.organizationId, actor: actor.id, action: "migration.state.advance", targetId: row.id, outcome: "completed", createdAt: now, details: { from: row.state, to: nextState, checkpointPercent: nextCheckpoint, dryRun: true } });
        });
        return json(response, 200, { id: row.id, state: nextState, checkpointPercent: nextCheckpoint, checksumSha256: checksum });
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "internal_error" });
      }
    }
    const migrationRollbackMatch = url.pathname.match(/^\/api\/migrations\/([^/]+)\/rollback$/);
    if (request.method === "POST" && migrationRollbackMatch) {
      if (!allowSameOrigin(request, response)) return;
      if (!["owner", "admin", "operator"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      const migrationId = decodeURIComponent(migrationRollbackMatch[1]);
      const row = db.prepare("SELECT * FROM migration_plans WHERE id = ? AND organization_id = ?").get(migrationId, actor.organizationId);
      if (!row) return json(response, 404, { error: "migration_not_found" });
      if (row.state === "completed" || row.state === "rolled_back") return json(response, 409, { error: "rollback_unavailable" });
      const now = new Date().toISOString();
      transaction(() => {
        db.prepare("UPDATE migration_plans SET state = 'rolled_back', updated_at = ? WHERE id = ? AND organization_id = ?")
          .run(now, row.id, actor.organizationId);
        appendAuditEvent(db, { organizationId: actor.organizationId, actor: actor.id, action: "migration.rollback", targetId: row.id, outcome: "completed", createdAt: now, details: { previousState: row.state, dryRun: true } });
      });
      return json(response, 200, { id: row.id, state: "rolled_back" });
    }
    if (request.method === "GET" && url.pathname === "/api/storage/summary") {
      const accounts = accountQuery.all(actor.organizationId).map(accountFromRow);
      const policies = db.prepare(`SELECT p.*, a.label AS account_label FROM storage_policies p
        JOIN accounts a ON a.id = p.account_id WHERE p.organization_id = ? ORDER BY p.created_at DESC`).all(actor.organizationId);
      return json(response, 200, {
        accounts: accounts.map((account) => ({
          ...account,
          utilizationPercent: account.quotaBytes ? Math.round((account.usedBytes / account.quotaBytes) * 100) : 0,
          estimatedOffloadableBytes: Math.round(account.usedBytes * 0.28),
        })),
        policies: policies.map((policy) => ({
          id: policy.id,
          accountId: policy.account_id,
          accountLabel: policy.account_label,
          mode: policy.mode,
          targetEndpoint: policy.target_endpoint,
          targetBucket: policy.target_bucket,
          thresholdPercent: policy.threshold_percent,
          estimatedReclaimBytes: policy.estimated_reclaim_bytes,
          status: policy.status,
          lastDrillStatus: policy.last_drill_status ?? null,
          lastDrillAt: policy.last_drill_at ?? null,
          createdAt: policy.created_at,
        })),
        sharedDiskPoolingSupported: false,
        note: "Account quotas are separate per-provider limits; remote object storage does not mount as local cPanel disk.",
      });
    }
    if (request.method === "POST" && url.pathname === "/api/storage/policies") {
      if (!allowSameOrigin(request, response)) return;
      if (!["owner", "admin", "operator"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      try {
        const body = await readJson(request);
        const account = db.prepare("SELECT * FROM accounts WHERE id = ? AND organization_id = ?").get(body.accountId, actor.organizationId);
        if (!account) return json(response, 404, { error: "account_not_found" });
        const mode = ["media_offload", "backup_archival", "static_assets"].includes(body.mode) ? body.mode : "backup_archival";
        const endpointCheck = validateExternalEndpoint(body.targetEndpoint, { requireHttps: true });
        if (!endpointCheck.valid) return json(response, 400, { error: endpointCheck.reason });
        const bucket = typeof body.targetBucket === "string" && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(body.targetBucket.trim()) ? body.targetBucket.trim() : "";
        const threshold = Number(body.thresholdPercent ?? 80);
        if (!bucket || !Number.isInteger(threshold) || threshold < 50 || threshold > 99) {
          return json(response, 400, { error: "invalid_storage_policy" });
        }
        const ratio = mode === "media_offload" ? 0.32 : mode === "backup_archival" ? 0.24 : 0.18;
        const estimatedReclaimBytes = Math.round(account.used_bytes * ratio);
        const id = randomUUID();
        const now = new Date().toISOString();
        transaction(() => {
          db.prepare(`INSERT INTO storage_policies (id, organization_id, account_id, mode, target_endpoint, target_bucket, threshold_percent, estimated_reclaim_bytes, status, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'dry_run_only', ?, ?)`)
            .run(id, actor.organizationId, account.id, mode, endpointCheck.origin, bucket, threshold, estimatedReclaimBytes, actor.id, now);
          appendAuditEvent(db, { organizationId: actor.organizationId, actor: actor.id, action: "storage.policy.create", targetId: id, outcome: "completed", createdAt: now, details: { mode, targetBucket: bucket, estimatedReclaimBytes, dryRunOnly: true } });
        });
        return json(response, 201, { id, mode, targetEndpoint: endpointCheck.origin, targetBucket: bucket, thresholdPercent: threshold, estimatedReclaimBytes, status: "dry_run_only" });
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "internal_error" });
      }
    }
    if (request.method === "GET" && url.pathname === "/api/team/members") {
      if (!["owner", "admin"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      const members = db.prepare(`SELECT id, email, role, disabled, mfa_enabled AS mfaEnabled, created_at AS createdAt
        FROM users WHERE organization_id = ? ORDER BY created_at, email`).all(actor.organizationId);
      return json(response, 200, { members });
    }
    if (request.method === "POST" && url.pathname === "/api/team/members") {
      if (!allowSameOrigin(request, response)) return;
      if (!["owner", "admin"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      try {
        const body = await readJson(request);
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        const password = body.password;
        const role = typeof body.role === "string" ? body.role : "operator";
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json(response, 400, { error: "invalid_email" });
        if (typeof password !== "string" || password.length < 12 || password.length > 256) return json(response, 400, { error: "password_policy" });
        if (!["admin", "operator", "viewer", "owner"].includes(role)) return json(response, 400, { error: "invalid_role" });
        if (role === "owner" && actor.role !== "owner") return json(response, 403, { error: "owner_role_required" });
        const existing = db.prepare("SELECT id FROM users WHERE organization_id = ? AND email = ?").get(actor.organizationId, email);
        if (existing) return json(response, 409, { error: "member_already_exists" });
        const id = randomUUID();
        const salt = randomBytes(16).toString("hex");
        const now = new Date().toISOString();
        transaction(() => {
          db.prepare(`INSERT INTO users (id, organization_id, email, password_salt, password_hash, role, disabled, mfa_enabled, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`)
            .run(id, actor.organizationId, email, salt, passwordHash(password, salt), role, now);
          appendAuditEvent(db, { organizationId: actor.organizationId, actor: actor.id, action: "team.member.create", targetId: id, outcome: "completed", createdAt: now, details: { role } });
        });
        return json(response, 201, { member: { id, email, role, disabled: 0, mfaEnabled: 0, createdAt: now } });
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "internal_error" });
      }
    }
    const teamMemberMatch = url.pathname.match(/^\/api\/team\/members\/([^/]+)$/);
    if (request.method === "PATCH" && teamMemberMatch) {
      if (!allowSameOrigin(request, response)) return;
      if (!["owner", "admin"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      try {
        const targetId = decodeURIComponent(teamMemberMatch[1]);
        const target = db.prepare("SELECT id, email, role, disabled, mfa_enabled AS mfaEnabled, created_at AS createdAt FROM users WHERE id = ? AND organization_id = ?")
          .get(targetId, actor.organizationId);
        if (!target) return json(response, 404, { error: "member_not_found" });
        const body = await readJson(request);
        const nextRole = typeof body.role === "string" ? body.role : target.role;
        const nextDisabled = typeof body.disabled === "boolean" ? (body.disabled ? 1 : 0) : target.disabled;
        if (!["owner", "admin", "operator", "viewer"].includes(nextRole)) return json(response, 400, { error: "invalid_role" });
        if (target.id === actor.id && (nextDisabled === 1 || nextRole !== actor.role)) {
          return json(response, 400, { error: "cannot_modify_own_access" });
        }
        if ((target.role === "owner" || nextRole === "owner") && actor.role !== "owner") {
          return json(response, 403, { error: "owner_role_required" });
        }
        if (target.role === "owner" && (nextRole !== "owner" || nextDisabled === 1)) {
          const activeOwners = db.prepare("SELECT COUNT(*) AS count FROM users WHERE organization_id = ? AND role = 'owner' AND disabled = 0").get(actor.organizationId).count;
          if (activeOwners <= 1) return json(response, 409, { error: "last_owner_protected" });
        }
        const now = new Date().toISOString();
        transaction(() => {
          db.prepare("UPDATE users SET role = ?, disabled = ? WHERE id = ? AND organization_id = ?").run(nextRole, nextDisabled, target.id, actor.organizationId);
          if (nextDisabled === 1 || nextRole !== target.role) {
            db.prepare("DELETE FROM sessions WHERE user_id = ?").run(target.id);
          }
          appendAuditEvent(db, { organizationId: actor.organizationId, actor: actor.id, action: "team.member.update", targetId: target.id, outcome: "completed", createdAt: now, details: { role: nextRole, disabled: Boolean(nextDisabled) } });
        });
        return json(response, 200, { member: { ...target, role: nextRole, disabled: nextDisabled } });
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "internal_error" });
      }
    }
    const siteInspectionMatch = url.pathname.match(/^\/api\/sites\/([^/]+)\/inspection$/);
    if (request.method === "GET" && siteInspectionMatch) {
      const siteId = decodeURIComponent(siteInspectionMatch[1]);
      const site = db.prepare(`SELECT s.id, s.account_id AS accountId, s.domain, s.kind, s.document_root AS documentRoot, s.php_version AS phpVersion, s.status
        FROM sites s JOIN accounts a ON a.id = s.account_id WHERE s.id = ? AND a.organization_id = ?`).get(siteId, actor.organizationId);
      if (!site) return json(response, 404, { error: "site_not_found" });
      const account = db.prepare("SELECT id, label, host, source, capability_profile AS capabilityProfile FROM accounts WHERE id = ? AND organization_id = ?")
        .get(site.accountId, actor.organizationId);
      const snapshots = db.prepare(`SELECT id, action, status, checksum_sha256 AS checksumSha256, details_json AS detailsJson, created_at AS createdAt
        FROM site_snapshots WHERE site_id = ? AND organization_id = ? ORDER BY created_at DESC LIMIT 10`).all(site.id, actor.organizationId)
        .map((row) => ({ ...row, details: JSON.parse(row.detailsJson), detailsJson: undefined }));
      const wpState = db.prepare(`SELECT core_version AS coreVersion, previous_core_version AS previousCoreVersion,
        pending_updates AS pendingUpdates, staging_url AS stagingUrl, staging_created_at AS stagingCreatedAt,
        last_restore_point_sha256 AS lastRestorePointSha256, last_action AS lastAction
        FROM wp_site_state WHERE site_id = ? AND organization_id = ?`).get(site.id, actor.organizationId) ?? null;
      return json(response, 200, mockCpanelAdapter.inspectSiteHealth({ site, account, snapshots, wpState }));
    }
    const wpStagingMatch = url.pathname.match(/^\/api\/sites\/([^/]+)\/wordpress\/staging$/);
    if (request.method === "POST" && wpStagingMatch) {
      if (!allowSameOrigin(request, response)) return;
      if (!["owner", "admin", "operator"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      try {
        const siteId = decodeURIComponent(wpStagingMatch[1]);
        const site = db.prepare(`SELECT s.id, s.account_id AS accountId, s.domain, s.kind, s.status
          FROM sites s JOIN accounts a ON a.id = s.account_id WHERE s.id = ? AND a.organization_id = ?`).get(siteId, actor.organizationId);
        if (!site) return json(response, 404, { error: "site_not_found" });
        if (!/wordpress|woo/i.test(site.kind)) return json(response, 400, { error: "not_a_wordpress_site" });
        const body = await readJson(request);
        if (!["create", "destroy"].includes(body.action)) return json(response, 400, { error: "invalid_staging_action" });
        const now = new Date().toISOString();
        const existing = db.prepare("SELECT * FROM wp_site_state WHERE site_id = ? AND organization_id = ?").get(site.id, actor.organizationId);
        const stagingUrl = body.action === "create" ? `https://staging.${site.domain}` : null;
        const stagingCreatedAt = body.action === "create" ? now : null;
        const restoreSha = existing?.last_restore_point_sha256 ?? sha256(`wp-staging:${site.id}:${now}`);
        const initialPending = existing ? existing.pending_updates : (site.status === "attention" ? 3 : 0);
        const coreVersion = existing?.core_version ?? "6.7.2";
        transaction(() => {
          db.prepare(`INSERT INTO wp_site_state (site_id, organization_id, core_version, previous_core_version, pending_updates, previous_pending_updates, staging_url, staging_created_at, last_restore_point_sha256, last_action, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(site_id) DO UPDATE SET staging_url = excluded.staging_url, staging_created_at = excluded.staging_created_at, last_restore_point_sha256 = excluded.last_restore_point_sha256, last_action = excluded.last_action, updated_at = excluded.updated_at`)
            .run(site.id, actor.organizationId, coreVersion, existing?.previous_core_version ?? null, initialPending, existing?.previous_pending_updates ?? null, stagingUrl, stagingCreatedAt, restoreSha, `staging_${body.action}`, now);
          appendAuditEvent(db, { organizationId: actor.organizationId, actor: actor.id, action: `wordpress.staging.${body.action}`, targetId: site.id, outcome: "completed", createdAt: now, details: { domain: site.domain, stagingUrl, sourceFilesUntouched: true, dryRun: true } });
        });
        return json(response, 200, { siteId: site.id, stagingUrl, stagingCreatedAt, restorePointSha256: restoreSha, dryRun: true });
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "internal_error" });
      }
    }
    const wpUpdateMatch = url.pathname.match(/^\/api\/sites\/([^/]+)\/wordpress\/update$/);
    if (request.method === "POST" && wpUpdateMatch) {
      if (!allowSameOrigin(request, response)) return;
      if (!["owner", "admin", "operator"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      try {
        const siteId = decodeURIComponent(wpUpdateMatch[1]);
        const site = db.prepare(`SELECT s.id, s.account_id AS accountId, s.domain, s.kind, s.status
          FROM sites s JOIN accounts a ON a.id = s.account_id WHERE s.id = ? AND a.organization_id = ?`).get(siteId, actor.organizationId);
        if (!site) return json(response, 404, { error: "site_not_found" });
        if (!/wordpress|woo/i.test(site.kind)) return json(response, 400, { error: "not_a_wordpress_site" });
        const body = await readJson(request);
        if (!["apply_updates", "rollback"].includes(body.action)) return json(response, 400, { error: "invalid_wordpress_action" });
        const now = new Date().toISOString();
        const existing = db.prepare("SELECT * FROM wp_site_state WHERE site_id = ? AND organization_id = ?").get(site.id, actor.organizationId);

        if (body.action === "rollback") {
          if (!existing?.previous_core_version) return json(response, 409, { error: "no_restore_point_available" });
          const restoredCore = existing.previous_core_version;
          const restoredPending = existing.previous_pending_updates ?? 0;
          transaction(() => {
            db.prepare(`UPDATE wp_site_state SET core_version = ?, previous_core_version = NULL, pending_updates = ?, previous_pending_updates = NULL, last_action = 'rollback', updated_at = ?
              WHERE site_id = ? AND organization_id = ?`)
              .run(restoredCore, restoredPending, now, site.id, actor.organizationId);
            appendAuditEvent(db, { organizationId: actor.organizationId, actor: actor.id, action: "wordpress.update.rollback", targetId: site.id, outcome: "completed", createdAt: now, details: { domain: site.domain, restoredCoreVersion: restoredCore, restoredPendingUpdates: restoredPending, dryRun: true } });
          });
          return json(response, 200, { siteId: site.id, action: "rollback", coreVersion: restoredCore, pendingUpdates: restoredPending, canRollback: false, dryRun: true });
        }

        const prevCore = existing?.core_version ?? "6.7.2";
        const prevPending = existing ? existing.pending_updates : (site.status === "attention" ? 3 : 1);
        const restoreSha = sha256(`wp-restore:${site.id}:${prevCore}:${now}`);
        const nextCore = "6.8.1";
        transaction(() => {
          db.prepare(`INSERT INTO wp_site_state (site_id, organization_id, core_version, previous_core_version, pending_updates, previous_pending_updates, staging_url, staging_created_at, last_restore_point_sha256, last_action, updated_at)
            VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 'apply_updates', ?)
            ON CONFLICT(site_id) DO UPDATE SET previous_core_version = excluded.previous_core_version, core_version = excluded.core_version, previous_pending_updates = excluded.previous_pending_updates, pending_updates = 0, last_restore_point_sha256 = excluded.last_restore_point_sha256, last_action = 'apply_updates', updated_at = excluded.updated_at`)
            .run(site.id, actor.organizationId, nextCore, prevCore, prevPending, existing?.staging_url ?? null, existing?.staging_created_at ?? null, restoreSha, now);
          appendAuditEvent(db, { organizationId: actor.organizationId, actor: actor.id, action: "wordpress.update.dry_run", targetId: site.id, outcome: "completed", createdAt: now, details: { domain: site.domain, fromVersion: prevCore, toVersion: nextCore, restorePointSha256: restoreSha, dryRun: true } });
        });
        return json(response, 200, { siteId: site.id, action: "apply_updates", coreVersion: nextCore, pendingUpdates: 0, restorePointSha256: restoreSha, canRollback: true, dryRun: true });
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "internal_error" });
      }
    }
    const siteActionMatch = url.pathname.match(/^\/api\/sites\/([^/]+)\/actions$/);
    if (request.method === "POST" && siteActionMatch) {
      if (!allowSameOrigin(request, response)) return;
      if (!["owner", "admin", "operator"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      try {
        const siteId = decodeURIComponent(siteActionMatch[1]);
        const site = db.prepare(`SELECT s.id, s.account_id AS accountId, s.domain, s.kind, s.document_root AS documentRoot, s.php_version AS phpVersion, s.status
          FROM sites s JOIN accounts a ON a.id = s.account_id WHERE s.id = ? AND a.organization_id = ?`).get(siteId, actor.organizationId);
        if (!site) return json(response, 404, { error: "site_not_found" });
        const account = db.prepare("SELECT id, label, host, source, capability_profile AS capabilityProfile FROM accounts WHERE id = ? AND organization_id = ?")
          .get(site.accountId, actor.organizationId);
        const body = await readJson(request);
        if (!["backup_dry_run", "wp_preflight", "dns_ssl_check"].includes(body.action)) {
          return json(response, 400, { error: "unsupported_site_action" });
        }
        const execution = mockCpanelAdapter.executeDryRunSiteAction({ site, account, action: body.action });
        if (!execution.allowed) {
          return json(response, 403, { error: execution.reason, message: execution.message });
        }
        const snapshotId = randomUUID();
        transaction(() => {
          db.prepare(`INSERT INTO site_snapshots (id, organization_id, site_id, action, status, checksum_sha256, details_json, created_by, created_at)
            VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?)`)
            .run(snapshotId, actor.organizationId, site.id, body.action, execution.checksumSha256, JSON.stringify(execution.details), actor.id, execution.createdAt);
          appendAuditEvent(db, { organizationId: actor.organizationId, actor: actor.id, action: `site.${body.action}`, targetId: site.id, outcome: "completed", createdAt: execution.createdAt, details: { domain: site.domain, dryRun: true, checksumSha256: execution.checksumSha256 } });
        });
        return json(response, 201, { id: snapshotId, action: body.action, status: "completed", checksumSha256: execution.checksumSha256, details: execution.details, createdAt: execution.createdAt });
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "internal_error" });
      }
    }
    if (request.method === "GET" && url.pathname === "/api/system/backups") {
      if (!["owner", "admin"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      if (dbPath === ":memory:") return json(response, 200, { backups: [], inMemory: true });
      const backupsDir = resolve(dirname(dbPath), "backups");
      return json(response, 200, { backups: listBackups(backupsDir), inMemory: false });
    }
    if (request.method === "POST" && url.pathname === "/api/system/restore-drill") {
      if (!allowSameOrigin(request, response)) return;
      if (actor.role !== "owner") return json(response, 403, { error: "permission_denied" });
      if (dbPath === ":memory:") return json(response, 400, { error: "in_memory_db_unsupported" });
      try {
        const body = await readJson(request);
        if (typeof body.fileName !== "string" || !/^[a-zA-Z0-9_.-]+\.sqlite$/.test(body.fileName)) {
          return json(response, 400, { error: "invalid_backup_filename" });
        }
        const backupsDir = resolve(dirname(dbPath), "backups");
        const targetPath = resolveContainedPath(backupsDir, body.fileName);
        if (!existsSync(targetPath)) return json(response, 404, { error: "backup_not_found" });
        const drill = runRestoreDrill(targetPath, { mfaKeyring });
        const now = new Date().toISOString();
        appendAuditEvent(db, { organizationId: actor.organizationId, actor: actor.id, action: "system.restore_drill", targetId: body.fileName, outcome: drill.passed ? "completed" : "failed", createdAt: now, details: { sha256: drill.sha256, schemaVersion: drill.schemaVersion, mfaSecretsVerified: drill.mfaSecretsVerified, passed: drill.passed } });
        return json(response, 200, drill);
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "restore_drill_failed" });
      }
    }
    if (request.method === "GET" && url.pathname === "/api/system/diagnostics/bundle") {
      if (!["owner", "admin"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      const bundle = buildDiagnosticBundle({ db, dbPath, mfaKeyring, webauthnRPID, webauthnOrigin, packageJson });
      bundle.adapterBoundary = { mockMode: mockCpanelAdapter.mode, liveBoundary: liveAdapterBoundary.mode, liveConnections: 0 };
      return json(response, 200, bundle);
    }
    if (request.method === "POST" && url.pathname === "/api/auth/recovery-contacts/outbox/retry") {
      if (!allowSameOrigin(request, response)) return;
      try {
        const body = await readJson(request);
        if (typeof body.outboxId !== "string") return json(response, 400, { error: "invalid_outbox_id" });
        const entry = db.prepare("SELECT id, event, recipient, status FROM notification_outbox WHERE id = ? AND user_id = ?").get(body.outboxId, actor.id);
        if (!entry) return json(response, 404, { error: "outbox_item_not_found" });
        const delivery = await dispatchRecoveryNotification(db, notificationAdapter, {
          userId: actor.id,
          event: entry.event,
          fallbackRecipient: entry.recipient,
          idempotencyKey: `retry:${entry.id}:${Date.now()}`,
        });
        return json(response, 200, { retriedFrom: entry.id, ...delivery });
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "internal_error" });
      }
    }
    const storageDrillMatch = url.pathname.match(/^\/api\/storage\/policies\/([^/]+)\/drill$/);
    if (request.method === "POST" && storageDrillMatch) {
      if (!allowSameOrigin(request, response)) return;
      if (!["owner", "admin", "operator"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      try {
        const body = await readJson(request);
        const policyId = decodeURIComponent(storageDrillMatch[1]);
        const policy = db.prepare("SELECT * FROM storage_policies WHERE id = ? AND organization_id = ?").get(policyId, actor.organizationId);
        if (!policy) return json(response, 404, { error: "storage_policy_not_found" });
        const drillType = body.drillType;
        if (!["dry_run_offload", "simulate_outage", "rehydrate_verify"].includes(drillType)) {
          return json(response, 400, { error: "unsupported_storage_drill" });
        }
        const now = new Date().toISOString();
        const drillStatus = drillType === "simulate_outage"
          ? "remote_outage_fail_closed"
          : drillType === "rehydrate_verify"
            ? "rehydration_checksum_verified"
            : "dry_run_manifest_verified";
        const nextPolicyStatus = drillType === "simulate_outage" ? "paused" : "dry_run_only";
        transaction(() => {
          db.prepare("UPDATE storage_policies SET status = ?, last_drill_status = ?, last_drill_at = ? WHERE id = ? AND organization_id = ?")
            .run(nextPolicyStatus, drillStatus, now, policy.id, actor.organizationId);
          appendAuditEvent(db, { organizationId: actor.organizationId, actor: actor.id, action: `storage.drill.${drillType}`, targetId: policy.id, outcome: drillType === "simulate_outage" ? "failed_safe" : "completed", createdAt: now, details: { drillStatus, nextPolicyStatus, sourceFilesUntouched: true } });
        });
        return json(response, 200, { id: policy.id, status: nextPolicyStatus, lastDrillStatus: drillStatus, lastDrillAt: now, sourceFilesUntouched: true });
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "internal_error" });
      }
    }
    if (request.method === "GET" && url.pathname === "/api/automation/insights") {
      return json(response, 200, generateAdvisoryInsights(db, actor.organizationId));
    }
    if (request.method === "GET" && url.pathname === "/api/automation/rules") {
      const rules = db.prepare(`SELECT id, name, rule_type AS ruleType, approval_mode AS approvalMode, daily_run_cap AS dailyRunCap, enabled, last_run_at AS lastRunAt, created_at AS createdAt
        FROM automation_rules WHERE organization_id = ? ORDER BY created_at DESC`).all(actor.organizationId);
      const runs = db.prepare(`SELECT r.id, r.rule_id AS ruleId, ar.name AS ruleName, r.status, r.summary_json AS summaryJson, r.created_at AS createdAt
        FROM automation_runs r JOIN automation_rules ar ON ar.id = r.rule_id
        WHERE r.organization_id = ? ORDER BY r.created_at DESC LIMIT 20`).all(actor.organizationId)
        .map((row) => ({ ...row, summary: JSON.parse(row.summaryJson), summaryJson: undefined }));
      return json(response, 200, { rules, runs });
    }
    if (request.method === "POST" && url.pathname === "/api/automation/rules") {
      if (!allowSameOrigin(request, response)) return;
      if (!["owner", "admin"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      try {
        const body = await readJson(request);
        const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
        const ruleType = RULE_TYPES.includes(body.ruleType) ? body.ruleType : "";
        const approvalMode = APPROVAL_MODES.includes(body.approvalMode) ? body.approvalMode : "manual_approval";
        const dailyRunCap = Number(body.dailyRunCap ?? 3);
        if (!name || !ruleType || !Number.isInteger(dailyRunCap) || dailyRunCap < 1 || dailyRunCap > 50) {
          return json(response, 400, { error: "invalid_automation_rule" });
        }
        const id = randomUUID();
        const createdAt = new Date().toISOString();
        transaction(() => {
          db.prepare(`INSERT INTO automation_rules (id, organization_id, name, rule_type, approval_mode, daily_run_cap, enabled, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
            .run(id, actor.organizationId, name, ruleType, approvalMode, dailyRunCap, actor.id, createdAt);
          appendAuditEvent(db, { organizationId: actor.organizationId, actor: actor.id, action: "automation.rule.create", targetId: id, outcome: "completed", createdAt, details: { ruleType, approvalMode, dailyRunCap } });
        });
        return json(response, 201, { rule: { id, name, ruleType, approvalMode, dailyRunCap, enabled: 1, lastRunAt: null, createdAt } });
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "internal_error" });
      }
    }
    const ruleRunMatch = url.pathname.match(/^\/api\/automation\/rules\/([^/]+)\/run$/);
    if (request.method === "POST" && ruleRunMatch) {
      if (!allowSameOrigin(request, response)) return;
      if (!["owner", "admin", "operator"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      const ruleId = decodeURIComponent(ruleRunMatch[1]);
      const rule = db.prepare("SELECT * FROM automation_rules WHERE id = ? AND organization_id = ?").get(ruleId, actor.organizationId);
      if (!rule) return json(response, 404, { error: "automation_rule_not_found" });
      const result = executePolicyRuleDryRun(db, { organizationId: actor.organizationId, actorId: actor.id, rule });
      if (!result.executed) return json(response, 429, result);
      return json(response, 201, result);
    }
    if (request.method === "POST" && url.pathname === "/api/accounts/cpanel/probe") {
      if (!allowSameOrigin(request, response)) return;
      if (!["owner", "admin"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      try {
        const body = await readJson(request);
        const host = typeof body.host === "string" ? body.host : "";
        const endpoint = validateCpanelApiHost(host);
        if (!host || !endpoint.valid) return json(response, 400, { error: endpoint.reason || "invalid_host" });
        const boundary = await liveAdapterBoundary.discoverCapabilities({ host: endpoint.hostname, authorized: false });
        return json(response, 200, {
          host: endpoint.hostname,
          ssrfPolicyPassed: true,
          liveConnections: 0,
          probe: boundary,
        });
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "internal_error" });
      }
    }
    if (request.method === "GET" && url.pathname === "/api/agency/report") {
      return json(response, 200, buildAgencyReadinessReport(db, actor.organizationId));
    }
    if (request.method === "POST" && url.pathname === "/api/system/demo-seed") {
      if (!allowSameOrigin(request, response)) return;
      if (!["owner", "admin"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      const now = new Date().toISOString();
      const extraAccounts = [
        {
          id: "acct-bluewave",
          label: "Bluewave Agency",
          host: "cp-sin-02.example.invalid",
          username: "bluewave_demo",
          health: "healthy",
          usedBytes: 68_719_476_736,
          quotaBytes: 161_061_273_600,
          profile: "cpanel_uapi_standard",
          sites: [
            { id: "site-bluewave-main", domain: "bluewave.example", kind: "WordPress", root: "/home/bluewave/public_html", php: "8.3", status: "active" },
            { id: "site-bluewave-cdn", domain: "cdn.bluewave.example", kind: "Static", root: "/home/bluewave/cdn", php: "N/A", status: "active" },
          ],
        },
        {
          id: "acct-summit",
          label: "Summit Cloud Sandbox",
          host: "whm-tor-04.example.invalid",
          username: "summit_whm",
          health: "attention",
          usedBytes: 94_489_280_512,
          quotaBytes: 107_374_182_400,
          profile: "whm_reseller",
          sites: [
            { id: "site-summit-portal", domain: "portal.summit-cloud.example", kind: "WooCommerce", root: "/home/summit/portal", php: "8.2", status: "attention" },
          ],
        },
      ];
      let accountsAdded = 0;
      let sitesAdded = 0;
      let teamAdded = 0;
      transaction(() => {
        for (const acc of extraAccounts) {
          const accRes = db.prepare(`INSERT OR IGNORE INTO accounts
            (id, organization_id, label, provider, host, username, health, used_bytes, quota_bytes, last_synced_at, source, capability_profile)
            VALUES (?, ?, ?, 'cPanel', ?, ?, ?, ?, ?, ?, 'mock_fixture', ?)`)
            .run(acc.id, actor.organizationId, acc.label, acc.host, acc.username, acc.health, acc.usedBytes, acc.quotaBytes, now, acc.profile);
          if (accRes.changes > 0) {
            accountsAdded += 1;
            db.prepare(`INSERT OR IGNORE INTO capability_snapshots (id, account_id, organization_id, profile_name, capabilities_json, source, fetched_at)
              VALUES (?, ?, ?, ?, ?, 'mock_fixture', ?)`)
              .run(randomUUID(), acc.id, actor.organizationId, acc.profile, JSON.stringify(CAPABILITY_PROFILES[acc.profile]), now);
            db.prepare(`INSERT OR IGNORE INTO jobs (id, type, organization_id, account_id, requested_by, status, idempotency_key, created_at, started_at, completed_at, result_json)
              VALUES (?, 'inventory_refresh', ?, ?, ?, 'completed', ?, ?, ?, ?, ?)`)
              .run(randomUUID(), actor.organizationId, acc.id, actor.id, `demo-seed-${acc.id}`, now, now, now, JSON.stringify({ source: "mock_fixture", live: false, accountId: acc.id, sites: acc.sites.length, fetchedAt: now }));
          }
          for (const s of acc.sites) {
            const siteRes = db.prepare(`INSERT OR IGNORE INTO sites (id, account_id, domain, kind, document_root, php_version, status)
              VALUES (?, ?, ?, ?, ?, ?, ?)`).run(s.id, acc.id, s.domain, s.kind, s.root, s.php, s.status);
            if (siteRes.changes > 0) sitesAdded += 1;
          }
        }
        const demoMembers = [
          { id: "demo-user-ops", email: "ops-demo@orbicore.example", role: "operator" },
          { id: "demo-user-viewer", email: "auditor-demo@orbicore.example", role: "viewer" },
        ];
        for (const dm of demoMembers) {
          const salt = randomBytes(16).toString("hex");
          const hash = passwordHash(randomBytes(24).toString("base64url"), salt);
          const mRes = db.prepare(`INSERT OR IGNORE INTO users (id, organization_id, email, password_salt, password_hash, role, disabled, mfa_enabled, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`).run(dm.id, actor.organizationId, dm.email, salt, hash, dm.role, now);
          if (mRes.changes > 0) teamAdded += 1;
        }
        appendAuditEvent(db, {
          organizationId: actor.organizationId,
          actor: actor.id,
          action: "system.demo_seed",
          targetId: actor.organizationId,
          outcome: "completed",
          createdAt: now,
          details: { accountsAdded, sitesAdded, teamAdded, source: "mock_fixture", live: false },
        });
      });
      return json(response, 200, { seeded: true, accountsAdded, sitesAdded, teamAdded, source: "mock_fixture", liveConnections: 0 });
    }
    return json(response, 404, { error: "not_found" });
  });

  let timer;
  if (startWorker) {
    timer = setInterval(() => {
      void processNextJob().catch((error) => {
        // Stop the already-running local timer on a late CI fixture hold,
        // rather than generating repeated unhandled Promise rejections.
        // Static redacted diagnostics only; no job IDs or credentials.
        if (timer) clearInterval(timer);
        timer = undefined;
        console.error(error?.message === CI_SOURCE_RECOVERY_HOLD_ERROR
          ? "orbicore_ci_source_hold_worker_stopped_manual_review_required"
          : "orbicore_mock_worker_stopped_unexpectedly");
      });
    }, 250);
    timer.unref();
  }

  return {
    server,
    db,
    notificationAdapter,
    processNextJob,
    getOverview,
    close() {
      if (timer) clearInterval(timer);
      if (server.listening) server.close();
      db.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.ORBICORE_API_PORT ?? process.env.PORT ?? 41751);
  const host = configuredApiHost();
  const app = createApp();
  app.server.listen(port, host, () => {
    console.log(`ORBICORE server listening at http://${host}:${port} (synthetic data; no live connections)`);
  });
  const stop = () => { app.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
