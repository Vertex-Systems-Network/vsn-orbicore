// Trusted-base GitHub Action only. NEVER checkout or execute PR head code.
// Read the PR head's backlog JSON as untrusted data and update PR body only.
import { readFileSync } from "node:fs";
import { renderTaskLedger, upsertTaskLedger, mergeTaskSnapshots } from "./pr-task-table.mjs";

const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const eventName = process.env.GITHUB_EVENT_NAME;
const eventPath = process.env.GITHUB_EVENT_PATH;
if (!token || !repository || !eventName || !eventPath ||
  !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error("GitHub event/repository/token unavailable; cannot sync PR ledger");
}
const event = JSON.parse(readFileSync(eventPath, "utf8"));
async function api(path, init = {}) {
  const response = await fetch("https://api.github.com" + path, {
    ...init,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": "Bearer " + token,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
  });
  const payload = await response.text();
  if (!response.ok) throw new Error("GitHub API " + response.status + " at " + path +
    " (" + payload.slice(0, 180) + ")");
  return JSON.parse(payload);
}
function safeRepo(repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid head repository identity");
  return repo;
}
async function loadTasks(repo, ref) {
  const file = await api("/repos/" + safeRepo(repo) +
    "/contents/backlog/tasks.json?ref=" + encodeURIComponent(ref));
  if (file.encoding !== "base64" || !file.content || file.size > 1_000_000) {
    throw new Error("Backlog is not a bounded base64 JSON source");
  }
  const decoded = Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8");
  const taskSet = JSON.parse(decoded);
  if (!Array.isArray(taskSet.tasks) || taskSet.tasks.length === 0 ||
      taskSet.tasks.length > 300) throw new Error("Task snapshot missing or too large");
  return taskSet.tasks;
}
async function openPullNumbers() {
  const numbers = [];
  for (let page = 1; page <= 10; page++) {
    const result = await api("/repos/" + repository +
      "/pulls?state=open&per_page=100&page=" + page);
    numbers.push(...result.map(p => p.number));
    if (result.length < 100) return numbers;
  }
  throw new Error("PR listing exceeds safe 1000-pull limit");
}

const numbers = eventName === "pull_request_target" ?
  [event.pull_request?.number].filter(Number.isInteger) :
  await openPullNumbers();
const baseline = await loadTasks(repository, event.repository?.default_branch || "main");
for (const number of numbers) {
  const pull = await api("/repos/" + repository + "/pulls/" + number);
  if (pull.state !== "open" || pull.base.repo.full_name !== repository) continue;
  let effective = baseline;
  let source = "main baseline";
  if (pull.head.repo?.full_name && pull.head.sha) {
    // Compare actual immutable SHAs, not branch labels, so newer main edits
    // appear in all open PRs without resetting PR-specific task changes.
    const comparison = await api("/repos/" + repository + "/compare/" +
      encodeURIComponent(pull.base.sha) + "..." +
      encodeURIComponent(pull.head.sha));
    const mergeBase = comparison.merge_base_commit?.sha;
    if (!/^[a-f0-9]{40}$/.test(mergeBase ?? "")) {
      throw new Error("Missing merge-base SHA for PR #" + number);
    }
    const ancestor = await loadTasks(repository, mergeBase);
    const headTasks = await loadTasks(pull.head.repo.full_name, pull.head.sha);
    effective = mergeTaskSnapshots(baseline, ancestor, headTasks);
    source = "latest main + PR-specific task changes";
  }
  const table = renderTaskLedger({
    prNumber: number, title: pull.title, body: pull.body,
    headSha: pull.head.sha, source, tasks: effective, baseTasks: baseline,
  });
  const next = upsertTaskLedger(pull.body, table);
  if (next !== (pull.body ?? "")) {
    await api("/repos/" + repository + "/pulls/" + number, {
      method: "PATCH", body: JSON.stringify({ body: next }),
    });
    console.log("Updated PR #" + number + " from " + source +
      " (" + effective.length + " tasks)");
  } else {
    console.log("PR #" + number + " task table already current");
  }
}
console.log("PR task table audit:", JSON.stringify({ eventName, prCount: numbers.length }));
