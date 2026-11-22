import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = process.cwd();
const apiPort = Number(process.env.ORBICORE_SMOKE_API_PORT ?? 41751);
const webPort = Number(process.env.ORBICORE_SMOKE_WEB_PORT ?? 41750);
const apiBase = `http://127.0.0.1:${apiPort}`;
const webBase = `http://127.0.0.1:${webPort}`;
const workDir = await mkdtemp(join(tmpdir(), "orbicore-smoke-"));
const env = { ...process.env, ORBICORE_API_PORT: String(apiPort), ORBICORE_WEB_PORT: String(webPort), ORBICORE_DB_PATH: join(workDir, "orbicore.sqlite"), ORBICORE_COOKIE_SECURE: "0" };
const children = [];

function start(script, args) {
  const child = spawn(process.execPath, [script, ...args], { cwd: root, env, stdio: "inherit" });
  children.push(child);
  return child;
}

async function waitForServices() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (children.some((child) => child.exitCode !== null)) throw new Error("A local service exited during startup.");
    try {
      const [health, page] = await Promise.all([fetch(`${webBase}/api/health`), fetch(webBase)]);
      if (health.ok && page.ok) return;
    } catch { /* wait for both local services */ }
    await delay(250);
  }
  throw new Error(`Local API and web app did not become ready on ports ${apiPort}/${webPort}.`);
}

try {
  start("apps/api/server.mjs", []);
  start("node_modules/vite/bin/vite.js", ["--config", "apps/web/vite.config.ts", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"]);
  await waitForServices();

  const health = await fetch(`${webBase}/api/health`).then((response) => response.json());
  if (health.status !== "ok" || health.liveConnections !== 0) throw new Error("Unexpected health response.");
  const html = await fetch(webBase).then((response) => response.text());
  if (!html.includes('id="root"')) throw new Error("Web app entry point is missing.");

  const token = (await readFile(join(workDir, "first-admin.token"), "utf8")).trim();
  const bootstrap = await fetch(`${webBase}/api/auth/bootstrap`, {
    method: "POST", headers: { "content-type": "application/json", origin: webBase },
    body: JSON.stringify({ token, email: "smoke@example.test", password: "local-smoke-passphrase-2026" }),
  });
  if (bootstrap.status !== 201) throw new Error(`Owner bootstrap returned HTTP ${bootstrap.status}.`);
  const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Bootstrap did not issue a session cookie.");

  const anonymous = await fetch(`${webBase}/api/overview`);
  if (anonymous.status !== 401) throw new Error("Unauthenticated overview access was not denied.");
  const overview = await fetch(`${webBase}/api/overview`, { headers: { cookie } }).then((response) => response.json());
  if (overview.counts.accounts !== 3 || overview.counts.sites !== 7) throw new Error("Synthetic overview totals did not match the fixture.");

  const queuedResponse = await fetch(`${webBase}/api/jobs/refresh`, {
    method: "POST", headers: { "content-type": "application/json", origin: webBase, cookie, "idempotency-key": "local-smoke-refresh" },
    body: JSON.stringify({ accountId: "acct-northstar" }),
  });
  if (queuedResponse.status !== 202) throw new Error(`Refresh enqueue returned HTTP ${queuedResponse.status}.`);
  const queued = await queuedResponse.json();
  let job;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    job = await fetch(`${webBase}/api/jobs/${queued.jobId}`, { headers: { cookie } }).then((response) => response.json());
    if (job.job?.status === "completed" || job.job?.status === "failed") break;
    await delay(100);
  }
  if (job.job?.status !== "completed" || job.job.result?.live !== false) throw new Error("Fixture refresh job did not complete as a non-live operation.");
  console.log(JSON.stringify({ health: health.status, appHtmlServed: true, bootstrap: "passed", anonymousDenied: true, accounts: overview.counts.accounts, sites: overview.counts.sites, refreshJob: job.job.status, source: job.job.result.source }));
} finally {
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.all(children.map((child) => child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => child.once("exit", resolve))));
  await rm(workDir, { recursive: true, force: true });
}
