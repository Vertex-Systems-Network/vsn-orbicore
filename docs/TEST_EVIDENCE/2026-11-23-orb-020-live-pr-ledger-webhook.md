# ORB-020 live PR ledger webhook verification

**Status: pending real workflow observation.** This file is a non-secret checkpoint for a GitHub-only, open pull request lifecycle test. Verify that a new PR without task markers gains the canonical task ledger through a trusted default-branch workflow, then confirm commit synchronize and manual PR body edit preserve human text. Do not mark verified before GitHub logs and PR body are checked.

## Actual new-PR event

The trusted-base GitHub Actions [run #45137402693](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45137402693) completed **success** after PR #52 was opened **without** task-table markers. GitHub PR API inspection confirmed the bot inserted 20 canonical task rows, retained human-authored description content and displayed ORB-020 as `testing/unit`, not automatically verified. The runner logged `Updated PR #52 from PR head backlog (20 tasks)`.

## Synchronize/edited events

This commit is the explicit synchronize event fixture. Exact subsequent run and body-head checks will be recorded after GitHub confirms them; no preemptive assertion.

## Verified real GitHub webhook events

- **Opened:** [#45137402693](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45137402693) completed success. PR #52 opened without delimiters; automation inserted all **20** canonical task rows, preserved human text, and did not auto-promote ORB-020.
- **Synchronized head:** [#45137555114](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45137555114) completed success after branch commit `c3e88697f665f064145151b8ed2bbae82861acda`. PR #52 generated table snapshot SHA advanced from `0584397f6e73` to `c3e88697f665` and maintained 20 rows.
- **Edited description:** [#45137811536](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45137811536) completed success. A human-added text line outside marked block survived and all 20 task rows persisted.
- **Separate concurrent open PR:** [PR #53](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/53) opened with no task block. [#45137517906](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45137517906) added its own 20-row table successfully; retained as live main-push fanout witness.
- **Stale-head correction:** Existing script used the *whole PR head* backlog and would display stale statuses after main updated, misleading reviewers. PR #52 adds a **merge-base-aware task overlay** (`mergeTaskSnapshots`): take latest main as the baseline; overlay only PR-specific changed task fields since the true ancestor; conflicting concurrent edits on the same field fail closed. Five new Node regressions cover stale open PR, divergent fields, new tasks, conflicting lifecycle and deletions. [Branch CI #45138137701](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45138137701) passed with these regressions. Independent live push/main fanout remains untested **until this PR is merged**.

**Current ORB-020 lifecycle is intentionally `testing` at `integration_tested`:** live PR open/edit/synchronize is measured; main push fanout from a stale PR branch and postmerge trusted-base script still require independent confirmation. Never mark `verified` prematurely.

## Final independent live main-push fanout proof

- [PR #52](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/52) **merged** into `main` at `f2c0787e623b16b64246c4e6f4ede8edb1563b0b` after its [PR head CI #45138449537](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45138449537), branch CI #45138441617 and trusted PR-ledger #45138446564 all passed.
- Its merged canonical task now sets ORB-020 to `testing/integration_tested`. [Main CI #45138595854](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45138595854) completed **success**.
- [Main-push trusted PR fanout #45138595661](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45138595661) **completed success**. The runner log at 2026-11-23 08:26:23 UTC explicitly reports: `Updated PR #53 from latest main + PR-specific task changes (20 tasks)`, event `push`, open-PR count 1.
- The separate open [PR #53](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/53) **did not change its head SHA `4554d867e9c1048e92787aa61d7bd7cf4f1feff2`** during this operation. The bot updated exactly ORB-020's verification display from **`unit`** (its old branch) to **`integration_tested`** (new main), preserving a 20-row table and the related marker. This is independent evidence that an old open PR cannot mask main task verification statuses.
- These real GitHub events, plus the negative tests for conflicting concurrent main/PR task updates and CI plan lint, satisfy ORB-020's **bounded governance acceptance**. Mark ORB-020 `verified/integration_tested` as of this observed webhook, **not** `live_verified` and NOT as product/provider release approval. GitHub branch-protection settings remain hidden to the integration (HTTP 403); cPanel, SMTP, off-host key/witness/backup and production PostgreSQL HTTP identity are outside ORB-020 and still blocked/in-progress.
