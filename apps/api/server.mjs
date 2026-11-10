import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID, randomBytes, createHash, scryptSync, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { decryptMfaSecret, encodeBase32, encryptMfaSecret, mfaEncryptionKey, newRecoveryCodes, recoveryCodeHash, verifyTotp } from "./mfa.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const defaultFixturePath = resolve(here, "fixtures/cpanel-uapi-inventory.json");
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

function setSessionCookie(response, token, secure) {
  const flags = `Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? "; Secure" : ""}`;
  response.setHeader("set-cookie", token ? `orbicore_session=${token}; ${flags}` : `orbicore_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`);
}

function allowSameOrigin(request, response) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    if (new URL(origin).host === (request.headers["x-forwarded-host"] ?? request.headers.host)) return true;
  } catch { /* rejected below */ }
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
  let raw = "";
  for await (const chunk of request) {
    raw += chunk.toString("utf8");
    if (raw.length > limit) throw Object.assign(new Error("Request body is too large."), { status: 413 });
  }
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 }); }
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
      details_json TEXT NOT NULL
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
      created_at TEXT NOT NULL
    );
  `);

  const accountColumns = new Set(db.prepare("PRAGMA table_info(accounts)").all().map((column) => column.name));
  if (!accountColumns.has("organization_id")) db.exec("ALTER TABLE accounts ADD COLUMN organization_id TEXT NOT NULL DEFAULT 'org-demo'");
  const jobColumns = new Set(db.prepare("PRAGMA table_info(jobs)").all().map((column) => column.name));
  if (!jobColumns.has("organization_id")) db.exec("ALTER TABLE jobs ADD COLUMN organization_id TEXT NOT NULL DEFAULT 'org-demo'");
  if (!jobColumns.has("requested_by")) db.exec("ALTER TABLE jobs ADD COLUMN requested_by TEXT");
  const auditColumns = new Set(db.prepare("PRAGMA table_info(audit_events)").all().map((column) => column.name));
  if (!auditColumns.has("organization_id")) db.exec("ALTER TABLE audit_events ADD COLUMN organization_id TEXT NOT NULL DEFAULT 'org-demo'");
  const userColumns = new Set(db.prepare("PRAGMA table_info(users)").all().map((column) => column.name));
  if (!userColumns.has("mfa_enabled")) db.exec("ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0 CHECK (mfa_enabled IN (0, 1))");
  const sessionColumns = new Set(db.prepare("PRAGMA table_info(sessions)").all().map((column) => column.name));
  if (!sessionColumns.has("mfa_verified")) db.exec("ALTER TABLE sessions ADD COLUMN mfa_verified INTEGER NOT NULL DEFAULT 0 CHECK (mfa_verified IN (0, 1))");

  const now = new Date().toISOString();
  db.prepare("INSERT OR IGNORE INTO organizations (id, name, created_at) VALUES ('org-demo', 'Pella Global', ?)").run(now);

  const accountCount = db.prepare("SELECT COUNT(*) AS count FROM accounts").get().count;
  if (accountCount === 0) {
    const insertAccount = db.prepare(`INSERT INTO accounts
      (id, label, provider, host, username, health, used_bytes, quota_bytes, last_synced_at, source)
      VALUES (?, ?, 'cPanel', ?, ?, ?, ?, ?, ?, 'mock_fixture')`);
    const insertSite = db.prepare(`INSERT INTO sites
      (id, account_id, domain, kind, document_root, php_version, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const account of fixture.accounts) {
        insertAccount.run(account.id, account.label, account.host, account.username, account.health, account.usedBytes, account.quotaBytes, fixture.metadata.fetchedAt);
        for (const site of account.sites) {
          insertSite.run(site.id, account.id, site.domain, site.kind, site.documentRoot, site.phpVersion, site.status);
        }
      }
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

export function createApp({ dbPath = process.env.ORBICORE_DB_PATH ?? resolve(here, "../../.data/orbicore.sqlite"), fixturePath = defaultFixturePath, startWorker = true, bootstrapToken: suppliedBootstrapToken, mfaKey: suppliedMfaKey, mfaClock = () => Date.now(), webauthnRPID = process.env.ORBICORE_WEBAUTHN_RP_ID ?? "localhost", webauthnOrigin = process.env.ORBICORE_WEBAUTHN_ORIGIN ?? "http://localhost" } = {}) {
  const fixture = readFixture(fixturePath);
  const db = createDatabase(dbPath, fixture);
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
  const mfaKey = mfaEncryptionKey(suppliedMfaKey);

  function actorFor(request) {
    const token = cookieValue(request.headers.cookie, "orbicore_session");
    if (!token) return null;
    const row = db.prepare(`SELECT u.id, u.email, u.role, u.organization_id AS organizationId, u.mfa_enabled AS mfaEnabled
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0 AND (u.mfa_enabled = 0 OR s.mfa_verified = 1)`).get(sha256(token), new Date().toISOString());
    return row ?? null;
  }

  function issueSession(user, response, mfaVerified = false) {
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const expires = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, mfa_verified, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(sha256(token), user.id, expires, mfaVerified ? 1 : 0, now.toISOString());
    setSessionCookie(response, token, secureCookie);
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
    const candidate = db.prepare("SELECT id, account_id, organization_id, requested_by FROM jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1").get();
    if (!candidate) return null;
    const startedAt = new Date().toISOString();
    const claimed = db.prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'").run(startedAt, candidate.id);
    if (claimed.changes !== 1) return null;
    try {
      const actor = db.prepare("SELECT id, organization_id, role, disabled FROM users WHERE id = ?").get(candidate.requested_by);
      if (!actor || actor.disabled || actor.organization_id !== candidate.organization_id || !["owner", "admin", "operator"].includes(actor.role)) {
        throw new Error("The requesting actor no longer has permission to refresh inventory.");
      }
      const account = db.prepare("SELECT * FROM accounts WHERE id = ? AND organization_id = ?").get(candidate.account_id, candidate.organization_id);
      if (!account) throw new Error("The hosting account no longer exists.");
      const fixtureAccount = fixture.accounts.find((entry) => entry.id === account.id);
      if (!fixtureAccount) throw new Error("The mock adapter has no fixture for this account.");
      const now = new Date().toISOString();
      const result = { source: "mock_fixture", live: false, accountId: account.id, sites: fixtureAccount.sites.length, fetchedAt: now };
      transaction(() => {
        db.prepare("UPDATE accounts SET last_synced_at = ?, source = 'mock_fixture' WHERE id = ? AND organization_id = ?").run(now, account.id, candidate.organization_id);
        db.prepare("UPDATE jobs SET status = 'completed', completed_at = ?, result_json = ?, error = NULL WHERE id = ?")
          .run(now, JSON.stringify(result), candidate.id);
        db.prepare(`INSERT INTO audit_events (id, organization_id, actor, action, target_id, outcome, created_at, details_json)
          VALUES (?, ?, ?, 'inventory.refresh', ?, 'completed', ?, ?)`)
          .run(randomUUID(), candidate.organization_id, actor.id, account.id, now, JSON.stringify({ source: "mock_fixture", live: false, jobId: candidate.id }));
      });
      return { id: candidate.id, status: "completed", result };
    } catch (error) {
      const now = new Date().toISOString();
      const safeError = error instanceof Error ? error.message.slice(0, 240) : "Refresh failed.";
      transaction(() => {
        db.prepare("UPDATE jobs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?").run(now, safeError, candidate.id);
        db.prepare(`INSERT INTO audit_events (id, organization_id, actor, action, target_id, outcome, created_at, details_json)
          VALUES (?, ?, ?, 'inventory.refresh', ?, 'failed', ?, ?)`)
          .run(randomUUID(), candidate.organization_id, candidate.requested_by ?? "system", candidate.account_id, now, JSON.stringify({ jobId: candidate.id, reason: safeError }));
      });
      return { id: candidate.id, status: "failed", error: safeError };
    }
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
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
          db.prepare("INSERT INTO audit_events (id, organization_id, actor, action, target_id, outcome, created_at, details_json) VALUES (?, ?, ?, 'auth.bootstrap', ?, 'completed', ?, '{}')")
            .run(randomUUID(), user.organizationId, user.id, user.id, now);
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
        if (bootstrapTokenPath && existsSync(bootstrapTokenPath)) unlinkSync(bootstrapTokenPath);
        issueSession(user, response);
        authFailures.delete(request.socket.remoteAddress ?? "unknown");
        return json(response, 201, { user });
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
        db.prepare("INSERT INTO audit_events (id, organization_id, actor, action, target_id, outcome, created_at, details_json) VALUES (?, ?, ?, 'auth.passkey.enroll', ?, 'completed', ?, ?)")
          .run(randomUUID(), actor.organizationId, actor.id, credential.id, createdAt, JSON.stringify({ deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp }));
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
        issueSession(user, response, true);
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
        .run(actor.id, encryptMfaSecret(secret, mfaKey), expires);
      const label = encodeURIComponent(`VSN ORBICORE:${actor.email}`);
      const uri = `otpauth://totp/${label}?secret=${secret}&issuer=VSN%20ORBICORE&algorithm=SHA1&digits=6&period=30`;
      return json(response, 201, { secret, otpauthUri: uri, expiresAt: expires, assurance: "totp_fallback_not_phishing_resistant" });
    }
    if (request.method === "POST" && url.pathname === "/api/auth/mfa/confirm") {
      if (!allowSameOrigin(request, response)) return;
      const actor = actorFor(request);
      if (!actor) return json(response, 401, { error: "authentication_required" });
      if (!["owner", "admin"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      if (!mfaKey) return json(response, 503, { error: "mfa_key_unavailable" });
      try {
        const body = await readJson(request);
        const pending = db.prepare("SELECT encrypted_secret, pending_expires_at FROM authenticators WHERE user_id = ? AND enabled = 0").get(actor.id);
        if (!pending || !pending.pending_expires_at || pending.pending_expires_at <= new Date().toISOString()) return json(response, 410, { error: "mfa_enrollment_expired" });
        const secret = decryptMfaSecret(pending.encrypted_secret, mfaKey);
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
          db.prepare(`INSERT INTO audit_events (id, organization_id, actor, action, target_id, outcome, created_at, details_json)
            VALUES (?, ?, ?, 'auth.mfa.enroll', ?, 'completed', ?, ?)`)
            .run(randomUUID(), actor.organizationId, actor.id, actor.id, now, JSON.stringify({ method: "totp_fallback", recoveryCodesIssued: codes.length }));
        });
        issueSession(actor, response, true);
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
        if (!challenge || !challenge.mfa_enabled || !mfaKey) {
          registerAuthFailure(request);
          return json(response, 401, { error: "invalid_mfa_challenge" });
        }
        const authenticator = db.prepare("SELECT encrypted_secret, last_totp_step FROM authenticators WHERE user_id = ? AND enabled = 1").get(challenge.user_id);
        if (!authenticator) return json(response, 401, { error: "invalid_mfa_challenge" });
        let recovery = false;
        let acceptedStep = null;
        const normalized = body.code.replaceAll("-", "").toUpperCase();
        if (/^[A-Z0-9_-]{20,32}$/.test(normalized)) {
          const codeRow = db.prepare("SELECT code_hash FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL")
            .get(challenge.user_id, recoveryCodeHash(normalized));
          if (codeRow) recovery = true;
        } else if (mfaKey) {
          acceptedStep = verifyTotp(decryptMfaSecret(authenticator.encrypted_secret, mfaKey), body.code, mfaClock(), authenticator.last_totp_step);
        }
        if (!recovery && acceptedStep === null) {
          registerAuthFailure(request);
          return json(response, 401, { error: "invalid_mfa_code" });
        }
        const now = new Date().toISOString();
        transaction(() => {
          db.prepare("DELETE FROM login_challenges WHERE token_hash = ?").run(challengeHash);
          if (recovery) {
            db.prepare("UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL").run(now, challenge.user_id, recoveryCodeHash(normalized));
            db.prepare("DELETE FROM sessions WHERE user_id = ?").run(challenge.user_id);
            db.prepare(`INSERT INTO notification_outbox (id, user_id, event, recipient, status, created_at)
              VALUES (?, ?, 'auth.mfa_recovery_code_used', ?, 'blocked_unverified_contact', ?)`)
              .run(randomUUID(), challenge.user_id, challenge.email, now);
            db.prepare(`INSERT INTO audit_events (id, organization_id, actor, action, target_id, outcome, created_at, details_json)
              VALUES (?, ?, ?, 'auth.mfa_recovery_code_used', ?, 'completed', ?, '{"sessionsRevoked":true,"notification":"queued_contact_unverified"}')`)
              .run(randomUUID(), challenge.organization_id, challenge.user_id, challenge.user_id, now);
          } else {
            db.prepare("UPDATE authenticators SET last_totp_step = ? WHERE user_id = ? AND last_totp_step < ?").run(acceptedStep, challenge.user_id, acceptedStep);
          }
        });
        const user = { id: challenge.user_id, email: challenge.email, role: challenge.role, organizationId: challenge.organization_id, mfaEnabled: true };
        issueSession(user, response, true);
        authFailures.delete(request.socket.remoteAddress ?? "unknown");
        return json(response, 200, { user, recoveryCodeUsed: recovery, notification: recovery ? "queued_contact_unverified" : undefined });
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
      if (!mfaKey || !actor.mfaEnabled) return json(response, 409, { error: "mfa_not_enabled_or_key_unavailable" });
      try {
        const body = await readJson(request);
        const userRow = db.prepare("SELECT password_salt, password_hash FROM users WHERE id = ? AND disabled = 0").get(actor.id);
        const candidate = typeof body.password === "string" && body.password.length <= 256 ? passwordHash(body.password, userRow?.password_salt ?? "orbicore-no-user-salt") : "";
        const authenticator = db.prepare("SELECT encrypted_secret, last_totp_step FROM authenticators WHERE user_id = ? AND enabled = 1").get(actor.id);
        const acceptedStep = authenticator && typeof body.code === "string"
          ? verifyTotp(decryptMfaSecret(authenticator.encrypted_secret, mfaKey), body.code, mfaClock(), authenticator.last_totp_step)
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
          db.prepare(`INSERT INTO audit_events (id, organization_id, actor, action, target_id, outcome, created_at, details_json)
            VALUES (?, ?, ?, 'auth.mfa.disable', ?, 'completed', ?, '{"sessionsRevoked":true,"reauthenticated":true}')`)
            .run(randomUUID(), actor.organizationId, actor.id, actor.id, now);
        });
        setSessionCookie(response, null, secureCookie);
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
          if (!mfaKey) return json(response, 503, { error: "mfa_key_unavailable" });
          const challenge = randomBytes(32).toString("base64url");
          const now = new Date();
          const expires = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
          db.prepare("DELETE FROM login_challenges WHERE user_id = ? OR expires_at <= ?").run(user.id, now.toISOString());
          db.prepare("INSERT INTO login_challenges (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
            .run(sha256(challenge), user.id, expires, now.toISOString());
          return json(response, 202, { mfaRequired: true, challenge, expiresAt: expires });
        }
        issueSession(user, response);
        return json(response, 200, { user, mfaEnabled: false });
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "internal_error" });
      }
    }
    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      if (!allowSameOrigin(request, response)) return;
      const token = cookieValue(request.headers.cookie, "orbicore_session");
      if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
      setSessionCookie(response, null, secureCookie);
      return json(response, 200, { loggedOut: true });
    }
    if (request.method === "GET" && url.pathname === "/api/auth/me") {
      const actor = actorFor(request);
      return actor ? json(response, 200, { user: actor }) : json(response, 401, { error: "authentication_required" });
    }
    const actor = actorFor(request);
    if (!actor) return json(response, 401, { error: "authentication_required" });
    if (request.method === "GET" && url.pathname === "/api/overview") return json(response, 200, getOverview(actor.organizationId));
    if (request.method === "GET" && url.pathname === "/api/accounts") return json(response, 200, { accounts: accountQuery.all(actor.organizationId).map(accountFromRow) });
    if (request.method === "GET" && url.pathname === "/api/audit") {
      if (!["owner", "admin"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
      const limit = Number.isInteger(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 50;
      const rows = db.prepare(`SELECT id, actor, action, target_id AS targetId, outcome, created_at AS createdAt, details_json
        FROM audit_events WHERE organization_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`).all(actor.organizationId, limit);
      return json(response, 200, { events: rows.map((row) => ({ ...row, details: JSON.parse(row.details_json), details_json: undefined })) });
    }
    const sitesMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/sites$/);
    if (request.method === "GET" && sitesMatch) {
      const accountId = decodeURIComponent(sitesMatch[1]);
      if (!db.prepare("SELECT id FROM accounts WHERE id = ? AND organization_id = ?").get(accountId, actor.organizationId)) return json(response, 404, { error: "account_not_found" });
      const sites = db.prepare("SELECT s.id, s.account_id AS accountId, s.domain, s.kind, s.document_root AS documentRoot, s.php_version AS phpVersion, s.status FROM sites s JOIN accounts a ON a.id = s.account_id WHERE s.account_id = ? AND a.organization_id = ? ORDER BY s.domain").all(accountId, actor.organizationId);
      return json(response, 200, { sites, source: "mock_fixture", live: false });
    }
    if (request.method === "GET" && url.pathname === "/api/jobs") return json(response, 200, { jobs: jobQuery.all(actor.organizationId).map(jobFromRow) });
    if (request.method === "POST" && url.pathname === "/api/jobs/refresh") {
      if (!allowSameOrigin(request, response)) return;
      if (!["owner", "admin", "operator"].includes(actor.role)) return json(response, 403, { error: "permission_denied" });
      try {
        const body = await readJson(request);
        if (typeof body.accountId !== "string" || body.accountId.length > 100) return json(response, 400, { error: "invalid_account_id" });
        const account = db.prepare("SELECT id FROM accounts WHERE id = ? AND organization_id = ?").get(body.accountId, actor.organizationId);
        if (!account) return json(response, 404, { error: "account_not_found" });
        const suppliedKey = request.headers["idempotency-key"]?.toString().slice(0, 120) ?? null;
        const idempotencyKey = suppliedKey ? `${actor.organizationId}:${suppliedKey}` : null;
        const existing = idempotencyKey ? db.prepare("SELECT id FROM jobs WHERE organization_id = ? AND idempotency_key = ?").get(actor.organizationId, idempotencyKey) : null;
        if (existing) return json(response, 200, { jobId: existing.id, status: "existing", source: "mock_fixture" });
        const id = randomUUID();
        const now = new Date().toISOString();
        transaction(() => {
          db.prepare("INSERT INTO jobs (id, type, organization_id, account_id, requested_by, status, idempotency_key, created_at) VALUES (?, 'inventory_refresh', ?, ?, ?, 'queued', ?, ?)")
            .run(id, actor.organizationId, account.id, actor.id, idempotencyKey, now);
          db.prepare(`INSERT INTO audit_events (id, organization_id, actor, action, target_id, outcome, created_at, details_json)
            VALUES (?, ?, ?, 'inventory.refresh', ?, 'queued', ?, ?)`)
            .run(randomUUID(), actor.organizationId, actor.id, account.id, now, JSON.stringify({ source: "mock_fixture", live: false, jobId: id }));
        });
        return json(response, 202, { jobId: id, status: "queued", source: "mock_fixture", live: false });
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "internal_error", message: error.message });
      }
    }
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (request.method === "GET" && jobMatch) {
      const row = db.prepare("SELECT j.*, a.label AS account_label FROM jobs j JOIN accounts a ON a.id = j.account_id WHERE j.id = ? AND j.organization_id = ?").get(decodeURIComponent(jobMatch[1]), actor.organizationId);
      return row ? json(response, 200, { job: jobFromRow(row) }) : json(response, 404, { error: "job_not_found" });
    }
    return json(response, 404, { error: "not_found" });
  });

  let timer;
  if (startWorker) {
    timer = setInterval(() => { void processNextJob(); }, 250);
    timer.unref();
  }

  return {
    server,
    db,
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
  const port = Number(process.env.ORBICORE_API_PORT ?? 41751);
  const app = createApp();
  app.server.listen(port, "127.0.0.1", () => {
    console.log(`ORBICORE local API listening at http://127.0.0.1:${port} (synthetic data; no live connections)`);
  });
  const stop = () => { app.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
