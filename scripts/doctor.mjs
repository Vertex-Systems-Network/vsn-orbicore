import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";

const port = Number(process.env.ORBICORE_API_PORT ?? 41751);
const probe = createServer();
const portAvailable = await new Promise((resolve) => {
  probe.once("error", () => resolve(false));
  probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
});
let sqlite = false;
try { const db = new DatabaseSync(":memory:"); db.exec("select 1"); db.close(); sqlite = true; } catch {}
const report = {
  node: process.version,
  supportedNode: Number(process.versions.node.split(".")[0]) >= 24,
  sqliteApi: sqlite,
  sqliteStability: "Node's built-in SQLite API is experimental in the selected Node 24 runtime.",
  apiPort: port,
  apiPortAvailable: portAvailable,
  postgres: "not detected by this preflight",
  redis: "not detected by this preflight",
  liveProviderConnections: 0,
};
console.log(JSON.stringify(report, null, 2));
if (!report.supportedNode || !report.sqliteApi || !report.apiPortAvailable) process.exitCode = 1;
