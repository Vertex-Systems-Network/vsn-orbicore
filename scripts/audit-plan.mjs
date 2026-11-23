import { existsSync, readFileSync } from "node:fs";

const statuses = new Set(["proposed", "researched", "ready", "in_progress",
  "implemented_unverified", "testing", "verified", "blocked", "deferred", "reopened"]);
const levels = new Set(["none", "static", "unit", "mock_tested",
  "browser_tested", "integration_tested", "live_verified", "docs_reviewed"]);
const blockerTypes = new Set(["external", "technical", "environment"]);
const validDate = value => typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}(?:T.+)?$/.test(value) && !Number.isNaN(Date.parse(value));

export function inspectPlan({ tasks, summary, epics }) {
  const errors = [];
  if (!Array.isArray(tasks) || !tasks.length) return ["Missing canonical backlog"];
  const byId = new Map();
  for (const task of tasks) {
    if (!/^ORB-\d{3}$/.test(task.id)) errors.push("Invalid task ID " + task.id);
    if (byId.has(task.id)) errors.push("Duplicate task ID " + task.id);
    byId.set(task.id, task);
    if (!statuses.has(task.status)) errors.push(task.id + ": unknown status " + task.status);
    if (!levels.has(task.verification_level)) errors.push(task.id + ": unknown verification " + task.verification_level);
    if (!["P0", "P1", "P2"].includes(task.priority)) errors.push(task.id + ": invalid priority");
    if (!validDate(task.last_updated)) errors.push(task.id + ": invalid last_updated");
    if (!Array.isArray(task.dependencies) || !Array.isArray(task.evidence_paths) ||
        !Array.isArray(task.blockers)) errors.push(task.id + ": malformed tracking arrays");
    if (task.status === "verified" && (!validDate(task.completed_at) ||
        !validDate(task.verified_at) || !task.evidence_paths?.length)) {
      errors.push(task.id + ": verified without dated completion/verification and evidence");
    }
    if (task.status !== "verified" && task.verified_at != null) {
      errors.push(task.id + ": verified_at set while lifecycle is " + task.status);
    }
    if (task.status === "blocked" &&
        (!blockerTypes.has(task.blocker_type) || !task.blockers?.length)) {
      errors.push(task.id + ": blocked task requires blocker_type and a precise blocker");
    }
    if (task.blocker_type != null && !blockerTypes.has(task.blocker_type)) {
      errors.push(task.id + ": invalid blocker_type");
    }
  }
  const visited = new Set(), active = new Set();
  const walk = id => {
    if (active.has(id)) { errors.push(id + ": cyclic dependency"); return; }
    if (visited.has(id)) return;
    visited.add(id);
    active.add(id);
    for (const child of byId.get(id)?.dependencies ?? []) {
      if (!byId.has(child)) errors.push(id + ": missing dependency " + child);
      else walk(child);
    }
    active.delete(id);
  };
  for (const id of byId.keys()) walk(id);
  const mapped = new Map();
  for (const epic of epics ?? []) {
    for (const id of epic.task_ids ?? []) {
      if (!byId.has(id)) errors.push("Epic " + epic.id + ": unknown task " + id);
      if (mapped.has(id)) errors.push("Task " + id + ": duplicate epic mapping");
      mapped.set(id, epic.id);
    }
  }
  for (const id of byId.keys()) if (!mapped.has(id)) errors.push(id + ": missing epic mapping");

  const rows = [...String(summary).matchAll(/^\|\s*(ORB-\d{3})\s*\|(.+)$/gm)];
  const found = new Set();
  for (const match of rows) {
    const cells = match[0].split("|").slice(1, -1).map(s => s.trim());
    const id = cells[0], task = byId.get(id);
    if (found.has(id)) errors.push(id + ": duplicate human backlog row");
    found.add(id);
    if (!task) { errors.push(id + ": unknown human backlog task"); continue; }
    if (cells[2] !== task.priority || cells[3] !== task.status ||
        cells[4] !== task.verification_level) {
      errors.push(id + ": docs/BACKLOG.md differs from canonical priority/status/verification");
    }
  }
  for (const id of byId.keys()) if (!found.has(id)) errors.push(id + ": missing human backlog row");
  return errors;
}

if (process.argv[1]?.endsWith("/scripts/audit-plan.mjs")) {
  const backlog = JSON.parse(readFileSync("backlog/tasks.json", "utf8"));
  const delivery = JSON.parse(readFileSync("knowledge-bank/backlog/delivery.json", "utf8"));
  const summary = readFileSync("docs/BACKLOG.md", "utf8");
  const errors = inspectPlan({ tasks: backlog.tasks, summary, epics: delivery.epics });
  for (const task of backlog.tasks) {
    for (const path of task.evidence_paths ?? []) {
      if (!existsSync(path)) errors.push(task.id + ": missing evidence path " + path);
    }
  }
  if (errors.length) {
    for (const error of errors) console.error("ERROR " + error);
    process.exitCode = 1;
  } else {
    const counts = Object.fromEntries([...statuses].map(status =>
      [status, backlog.tasks.filter(t => t.status === status).length]));
    console.log("Plan alignment OK:", JSON.stringify({ tasks: backlog.tasks.length, counts }));
  }
}
