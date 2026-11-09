import { createServer } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const defaultFixturePath = resolve(here, "fixtures/cpanel-uapi-inventory.json");

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
      label TEXT NOT NULL,
      provider TEXT NOT NULL,
      host TEXT NOT NULL,
      username TEXT NOT NULL,
      health TEXT NOT NULL CHECK (health IN ('healthy', 'attention', 'offline')),
      used_bytes INTEGER NOT NULL CHECK (used_bytes >= 0),
      quota_bytes INTEGER NOT NULL CHECK (quota_bytes >= 0),
      last_synced_at TEXT,
      source TEXT NOT NULL CHECK (source IN ('mock_fixture', 'provider'))
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
      account_id TEXT NOT NULL REFERENCES accounts(id),
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      result_json TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS jobs_state_created ON jobs(status, created_at);
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      created_at TEXT NOT NULL,
      details_json TEXT NOT NULL
    );
  `);

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

export function createApp({ dbPath = resolve(here, "../../.data/orbicore.sqlite"), fixturePath = defaultFixturePath, startWorker = true } = {}) {
  const fixture = readFixture(fixturePath);
  const db = createDatabase(dbPath, fixture);
  const accountQuery = db.prepare(`SELECT a.*, COUNT(s.id) AS site_count FROM accounts a
    LEFT JOIN sites s ON s.account_id = a.id GROUP BY a.id ORDER BY a.label`);
  const jobQuery = db.prepare(`SELECT j.*, a.label AS account_label FROM jobs j
    JOIN accounts a ON a.id = j.account_id ORDER BY j.created_at DESC LIMIT 20`);

  function getOverview() {
    const accounts = accountQuery.all().map(accountFromRow);
    const jobs = jobQuery.all().map(jobFromRow);
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
    const candidate = db.prepare("SELECT id, account_id FROM jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1").get();
    if (!candidate) return null;
    const startedAt = new Date().toISOString();
    const claimed = db.prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'").run(startedAt, candidate.id);
    if (claimed.changes !== 1) return null;
    try {
      const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(candidate.account_id);
      if (!account) throw new Error("The hosting account no longer exists.");
      const fixtureAccount = fixture.accounts.find((entry) => entry.id === account.id);
      if (!fixtureAccount) throw new Error("The mock adapter has no fixture for this account.");
      const now = new Date().toISOString();
      const result = { source: "mock_fixture", live: false, accountId: account.id, sites: fixtureAccount.sites.length, fetchedAt: now };
      db.prepare("UPDATE accounts SET last_synced_at = ?, source = 'mock_fixture' WHERE id = ?").run(now, account.id);
      db.prepare("UPDATE jobs SET status = 'completed', completed_at = ?, result_json = ?, error = NULL WHERE id = ?")
        .run(now, JSON.stringify(result), candidate.id);
      db.prepare(`INSERT INTO audit_events (id, actor, action, target_id, outcome, created_at, details_json)
        VALUES (?, 'demo-user', 'inventory.refresh', ?, 'completed', ?, ?)`)
        .run(randomUUID(), account.id, now, JSON.stringify({ source: "mock_fixture", live: false, jobId: candidate.id }));
      return { id: candidate.id, status: "completed", result };
    } catch (error) {
      const now = new Date().toISOString();
      const safeError = error instanceof Error ? error.message.slice(0, 240) : "Refresh failed.";
      db.prepare("UPDATE jobs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?").run(now, safeError, candidate.id);
      return { id: candidate.id, status: "failed", error: safeError };
    }
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/api/health") {
      return json(response, 200, { status: "ok", database: "sqlite_local", source: "mock_fixture", liveConnections: 0 });
    }
    if (request.method === "GET" && url.pathname === "/api/overview") return json(response, 200, getOverview());
    if (request.method === "GET" && url.pathname === "/api/accounts") return json(response, 200, { accounts: accountQuery.all().map(accountFromRow) });
    const sitesMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/sites$/);
    if (request.method === "GET" && sitesMatch) {
      const accountId = decodeURIComponent(sitesMatch[1]);
      if (!db.prepare("SELECT id FROM accounts WHERE id = ?").get(accountId)) return json(response, 404, { error: "account_not_found" });
      const sites = db.prepare("SELECT id, account_id AS accountId, domain, kind, document_root AS documentRoot, php_version AS phpVersion, status FROM sites WHERE account_id = ? ORDER BY domain").all(accountId);
      return json(response, 200, { sites, source: "mock_fixture", live: false });
    }
    if (request.method === "GET" && url.pathname === "/api/jobs") return json(response, 200, { jobs: jobQuery.all().map(jobFromRow) });
    if (request.method === "POST" && url.pathname === "/api/jobs/refresh") {
      try {
        const body = await readJson(request);
        if (typeof body.accountId !== "string" || body.accountId.length > 100) return json(response, 400, { error: "invalid_account_id" });
        const account = db.prepare("SELECT id FROM accounts WHERE id = ?").get(body.accountId);
        if (!account) return json(response, 404, { error: "account_not_found" });
        const idempotencyKey = request.headers["idempotency-key"]?.toString().slice(0, 120) ?? null;
        const existing = idempotencyKey ? db.prepare("SELECT id FROM jobs WHERE idempotency_key = ?").get(idempotencyKey) : null;
        if (existing) return json(response, 200, { jobId: existing.id, status: "existing", source: "mock_fixture" });
        const id = randomUUID();
        db.prepare("INSERT INTO jobs (id, type, account_id, status, idempotency_key, created_at) VALUES (?, 'inventory_refresh', ?, 'queued', ?, ?)")
          .run(id, account.id, idempotencyKey, new Date().toISOString());
        db.prepare(`INSERT INTO audit_events (id, actor, action, target_id, outcome, created_at, details_json)
          VALUES (?, 'demo-user', 'inventory.refresh', ?, 'queued', ?, ?)`)
          .run(randomUUID(), account.id, new Date().toISOString(), JSON.stringify({ source: "mock_fixture", live: false, jobId: id }));
        return json(response, 202, { jobId: id, status: "queued", source: "mock_fixture", live: false });
      } catch (error) {
        return json(response, error.status ?? 500, { error: error.status ? "invalid_request" : "internal_error", message: error.message });
      }
    }
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (request.method === "GET" && jobMatch) {
      const row = db.prepare("SELECT j.*, a.label AS account_label FROM jobs j JOIN accounts a ON a.id = j.account_id WHERE j.id = ?").get(decodeURIComponent(jobMatch[1]));
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
