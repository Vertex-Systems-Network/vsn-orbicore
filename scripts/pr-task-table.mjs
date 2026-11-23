
export const BEGIN = "<!-- ORBICORE_TASK_TABLE_BEGIN -->";
export const END = "<!-- ORBICORE_TASK_TABLE_END -->";

function escaped(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function removeLedger(body) {
  const source = String(body ?? "");
  const starts = source.split(BEGIN).length - 1;
  const ends = source.split(END).length - 1;
  if (starts !== ends || starts > 1) {
    throw new Error("PR task ledger markers are missing or duplicated; refuse destructive rewrite");
  }
  if (starts === 0) return source;
  if (source.indexOf(BEGIN) > source.indexOf(END)) {
    throw new Error("PR task ledger markers reversed");
  }
  return source.slice(0, source.indexOf(BEGIN)) +
    source.slice(source.indexOf(END) + END.length);
}

export function upsertTaskLedger(body, table) {
  const without = removeLedger(body).trimEnd();
  return without + (without ? "\n\n" : "") + BEGIN + "\n" + table.trim() + "\n" + END + "\n";
}

export function extractLinkedTaskIds(source) {
  return [...new Set((String(source ?? "").match(/\bORB-\d{3}\b/g) || []))].sort();
}


// A stale, still-open PR must never erase newer main task statuses. Resolve the
// PR's explicit JSON changes against its Git merge base, then apply only those
// changes over the most recent canonical main. Concurrent edits to the same
// field fail closed instead of inventing a status or hiding a verification.
export function mergeTaskSnapshots(mainTasks, ancestorTasks, headTasks) {
  const indexed = (tasks, label) => {
    if (!Array.isArray(tasks)) throw new Error(label + ": task list missing");
    const map = new Map();
    for (const task of tasks) {
      if (!task || !/^ORB-\d{3}$/.test(task.id) || map.has(task.id)) {
        throw new Error(label + ": invalid or duplicate task ID");
      }
      map.set(task.id, task);
    }
    return map;
  };
  const main = indexed(mainTasks, "main");
  const ancestor = indexed(ancestorTasks, "merge-base");
  const head = indexed(headTasks, "PR head");
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const result = new Map(main);
  for (const [id, old] of ancestor) {
    if (!head.has(id)) throw new Error(id + ": PR removed a canonical task");
    if (!main.has(id)) throw new Error(id + ": current main removed an ancestor task");
  }
  for (const [id, task] of head) {
    const before = ancestor.get(id);
    const current = result.get(id);
    if (!before) {
      if (current && !equal(current, task)) {
        throw new Error(id + ": conflicting newly added task in main and PR");
      }
      result.set(id, task);
      continue;
    }
    const fields = new Set([...Object.keys(before), ...Object.keys(task)]);
    const merged = { ...current };
    for (const key of fields) {
      if (equal(before[key], task[key])) continue;
      if (key === "id") throw new Error("PR may not rewrite task ID");
      if (!equal(before[key], current[key]) && !equal(task[key], current[key])) {
        throw new Error(id + ": conflicting concurrent update to " + key);
      }
      if (key in task) merged[key] = task[key];
      else delete merged[key];
    }
    result.set(id, merged);
  }
  if (result.size > 300 || result.size === 0) {
    throw new Error("Merged task list missing or exceeds safe limit");
  }
  return [...result.values()];
}

export function renderTaskLedger({ prNumber, title, body, headSha, source, tasks, baseTasks = [] }) {
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("Empty PR task ledger: fail closed");
  const ids = new Set();
  const baseline = new Map(baseTasks.map(t => [t.id, t]));
  const linked = extractLinkedTaskIds(title + " " + removeLedger(body));
  const counts = { verified: 0, testing: 0, in_progress: 0, blocked: 0, other: 0 };
  const rows = [...tasks].sort((a, b) => a.id.localeCompare(b.id)).map(task => {
    if (!/^ORB-\d{3}$/.test(task.id) || ids.has(task.id)) {
      throw new Error("Invalid or duplicate task ID in PR ledger");
    }
    ids.add(task.id);
    if (task.status in counts) counts[task.status] += 1;
    else counts.other += 1;
    const old = baseline.get(task.id);
    const change = old === undefined ? "New" :
      ["status", "verification_level", "last_updated", "commit_hash"].some(
        key => JSON.stringify(old[key]) !== JSON.stringify(task[key])) ||
      JSON.stringify(old.evidence_paths ?? []) !== JSON.stringify(task.evidence_paths ?? [])
      ? "Updated" : "—";
    const related = linked.includes(task.id) ? " · related" : "";
    const block = task.status === "blocked"
      ? "BLOCKED: " + (task.blocker_type ?? "unknown")
      : (task.blockers?.length ? "Open gates: " + task.blockers.length : "—");
    return "| " + [task.id, task.title, task.priority, task.status,
      task.verification_level, change + related, block].map(escaped).join(" | ") + " |";
  });
  for (const id of linked) {
    if (!ids.has(id)) throw new Error("PR references task " + id + " absent from backlog");
  }
  const statuses = Object.entries(counts).map(([key, n]) => key + " " + n).join(" · ");
  return [
    "## Current project task table (auto-synced)",
    "PR #" + Number(prNumber) + " · source: **" + escaped(source) + "** · task snapshot at " + escaped(headSha).slice(0, 12) + ".",
    "Canonical source: backlog/tasks.json. Status is lifecycle, not release approval; verification level is independent. Automation never promotes a task to verified.",
    "Related task IDs: " + (linked.length ? linked.join(", ") : "none specified (review needed)"),
    "**Counts:** " + statuses + " · total " + tasks.length,
    "",
    "| Task | Scope | Priority | Status | Verification | PR delta | Blocker / gates |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "**Update contract:** Each PR push/edit/reopen and each main backlog update refreshes this table. Task status/evidence changes must be committed to backlog/tasks.json on the PR branch, accompanied by evidence and synchronized docs/BACKLOG.md. Unresolved external access is never auto-cleared.",
  ].join("\n");
}
