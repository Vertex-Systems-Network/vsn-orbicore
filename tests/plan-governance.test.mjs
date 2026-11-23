import test from "node:test";
import assert from "node:assert/strict";
import { BEGIN, END, upsertTaskLedger, renderTaskLedger, extractLinkedTaskIds } from "../scripts/pr-task-table.mjs";
import { inspectPlan } from "../scripts/audit-plan.mjs";

const mkTask = (id, status = "testing") => ({
  id, title: "Safe | Label", priority: "P1", status,
  verification_level: status === "verified" ? "unit" : "browser_tested",
  last_updated: "2026-11-23", dependencies: [], blockers: [],
  blocker_type: null, evidence_paths: ["docs/NEXT_ACTION.md"],
  verified_at: status === "verified" ? "2026-11-23" : null,
  completed_at: status === "verified" ? "2026-11-23" : null,
});
test("PR table contains all canonical rows, escapes titles and marks related IDs", () => {
  const ledger = renderTaskLedger({
    prNumber: 51, title: "ORB-020 plan", body: "Fix ORB-009", source: "PR head backlog",
    headSha: "deadbeef", tasks: [mkTask("ORB-020"), mkTask("ORB-009")],
    baseTasks: [mkTask("ORB-009")],
  });
  assert.match(ledger, /\| ORB-020 \| Safe \\\| Label \| P1 \| testing/);
  assert.match(ledger, /New · related/);
  assert.match(ledger, /ORB-009/);
  assert.match(ledger, /total 2/);
});
test("PR task sync is idempotent and preserves human body", () => {
  const table = renderTaskLedger({
    prNumber: 2, title: "ORB-009", body: "User summary",
    source: "PR head backlog", headSha: "abc", tasks: [mkTask("ORB-009")],
  });
  const first = upsertTaskLedger("User summary", table);
  const second = upsertTaskLedger(first, table);
  assert.equal(first, second);
  assert.equal(first.split(BEGIN).length, 2);
  assert.equal(first.split(END).length, 2);
  assert.ok(first.startsWith("User summary\n\n"));
});
test("PR author edits are retained outside generated task table", () => {
  const first = upsertTaskLedger("Original", "Old");
  const result = upsertTaskLedger(first.replace("Original", "New description"), "Latest");
  assert.match(result, /^New description/);
  assert.doesNotMatch(result, /Old/);
  assert.match(result, /Latest/);
});
test("Broken table delimiters fail closed", () => {
  assert.throws(() => upsertTaskLedger("work " + BEGIN, "x"), /markers/);
  assert.throws(() => upsertTaskLedger(END + BEGIN, "x"), /reversed/);
});
test("Unknown linked task and duplicate task IDs fail closed", () => {
  assert.throws(() => renderTaskLedger({
    prNumber: 1, title: "ORB-999", tasks: [mkTask("ORB-009")], source: "main",
  }), /absent/);
  assert.throws(() => renderTaskLedger({
    prNumber: 1, title: "fix", tasks: [mkTask("ORB-009"), mkTask("ORB-009")], source: "main",
  }), /duplicate/);
});
test("Task IDs deduplicated from human PR text", () => {
  assert.deepEqual(extractLinkedTaskIds("ORB-009 ORB-020 ORB-009"), ["ORB-009", "ORB-020"]);
});
const epics = [{ id: "E", task_ids: ["ORB-009", "ORB-020"] }];
const human = "| ID | Task | Priority | Status | Evidence | Next exit |\n" +
  "|---|---|---|---|---|---|\n" +
  "| ORB-009 | a | P1 | testing | browser_tested | pending |\n" +
  "| ORB-020 | b | P1 | verified | unit | okay |";
test("Plan audit accepts evidence-backed task statuses", () => {
  assert.deepEqual(inspectPlan({
    tasks: [mkTask("ORB-009"), mkTask("ORB-020", "verified")],
    summary: human, epics,
  }), []);
});
test("Plan audit rejects false verification and markdown status drift", () => {
  const x = mkTask("ORB-009"); x.verified_at = "2026-11-23";
  const errors = inspectPlan({
    tasks: [x, mkTask("ORB-020", "verified")],
    summary: human.replace("| testing |", "| verified |"), epics,
  });
  assert.ok(errors.some(s => s.includes("verified_at")));
  assert.ok(errors.some(s => s.includes("differs")));
});
test("Plan audit catches cycles, unmapped tasks, missing blocker types", () => {
  const x = mkTask("ORB-009"); x.dependencies = ["ORB-020"]; x.status = "blocked";
  const y = mkTask("ORB-020", "verified"); y.dependencies = ["ORB-009"];
  const errors = inspectPlan({
    tasks: [x, y], summary: human, epics: [{ id: "E", task_ids: ["ORB-009"] }],
  });
  assert.ok(errors.some(s => s.includes("cyclic")));
  assert.ok(errors.some(s => s.includes("requires blocker_type")));
  assert.ok(errors.some(s => s.includes("missing epic")));
});
