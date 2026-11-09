import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID, randomBytes, createHash, scryptSync, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

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
      created_at TEXT NOT NULL,
      UNIQUE (organization_id, email)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user_expiry ON sessions(user_id, expires_at);
    CREATE TABLE IF NOT EXISTS bootstrap_tokens (
      token_hash TEXT PRIMARY KEY,
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

export function createApp({ dbPath = process.env.ORBICORE_DB_PATH ?? resolve(here, "../../.data/orbicore.sqlite"), fixturePath = defaultFixturePath, startWorker = true, bootstrapToken: suppliedBootstrapToken } = {}) {
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

  function actorFor(request) {
    const token = cookieValue(request.headers.cookie, "orbicore_session");
    if (!token) return null;
    const row = db.prepare(`SELECT u.id, u.email, u.role, u.organization_id AS organizationId
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0`).get(sha256(token), new Date().toISOString());
    return row ?? null;
  }

  function issueSession(user, response) {
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const expires = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(sha256(token), user.id, expires, now.toISOString());
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
        const userRow = db.prepare("SELECT id, organization_id, email, password_salt, password_hash, role FROM users WHERE email = ? AND disabled = 0").get(email);
        const candidate = passwordHash(password, userRow?.password_salt ?? "orbicore-no-user-salt");
        if (!userRow || !safeEqual(candidate, userRow.password_hash)) {
          registerAuthFailure(request);
          return json(response, 401, { error: "invalid_credentials" });
        }
        const user = { id: userRow.id, email: userRow.email, role: userRow.role, organizationId: userRow.organization_id };
        authFailures.delete(request.socket.remoteAddress ?? "unknown");
        issueSession(user, response);
        return json(response, 200, { user });
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
