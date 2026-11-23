
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
