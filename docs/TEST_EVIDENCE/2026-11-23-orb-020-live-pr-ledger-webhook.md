# ORB-020 live PR ledger webhook verification

**Status: bounded governance acceptance verified by real GitHub Actions events on 2026-11-23.** This file documents an observed GitHub-only PR lifecycle and independent main-push fanout test; it does not certify deployed authentication, provider access, branch protection, or production release gates.

## Actual new-PR event

The trusted-base GitHub Actions [run #45137402693](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45137402693) completed **success** after PR #52 was opened **without** task-table markers. GitHub PR API inspection confirmed the bot inserted 20 canonical task rows, retained human-authored description content and displayed ORB-020 as `testing/unit`, not automatically verified. The runner logged `Updated PR #52 from PR head backlog (20 tasks)`.

## Synchronize/edited events

The synchronize and edited event results below were subsequently observed and linked to real successful GitHub Actions runs.

## Verified real GitHub webhook events

- **Opened:** [#45137402693](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45137402693) completed success. PR #52 opened without delimiters; automation inserted all **20** canonical task rows, preserved human text, and did not auto-promote ORB-020.
- **Synchronized head:** [#45137555114](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45137555114) completed success after branch commit `c3e88697f665f064145151b8ed2bbae82861acda`. PR #52 generated table snapshot SHA advanced from `0584397f6e73` to `c3e88697f665` and maintained 20 rows.
- **Edited description:** [#45137811536](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45137811536) completed success. A human-added text line outside marked block survived and all 20 task rows persisted.
- **Separate concurrent open PR:** [PR #53](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/53) opened with no task block. [#45137517906](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45137517906) added its own 20-row table successfully; retained as live main-push fanout witness.
- **Stale-head correction:** Existing script used the *whole PR head* backlog and would display stale statuses after main updated, misleading reviewers. PR #52 adds a **merge-base-aware task overlay** (`mergeTaskSnapshots`): take latest main as the baseline; overlay only PR-specific changed task fields since the true ancestor; conflicting concurrent edits on the same field fail closed. Five new Node regressions cover stale open PR, divergent fields, new tasks, conflicting lifecycle and deletions. [Branch CI #45138137701](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45138137701) passed with these regressions. Independent live main-push fanout was subsequently observed after PR #52 merged, as recorded below.

**Historical checkpoint:** Before PR #52 merged, ORB-020 correctly remained `testing/integration_tested`; the independent fanout result below supports its later bounded `verified/integration_tested` closeout. This chronological record is not the current task state.

## Final independent live main-push fanout proof

- [PR #52](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/52) **merged** into `main` at `f2c0787e623b16b64246c4e6f4ede8edb1563b0b` after its [PR head CI #45138449537](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45138449537), branch CI #45138441617 and trusted PR-ledger #45138446564 all passed.
- Its merged canonical task now sets ORB-020 to `testing/integration_tested`. [Main CI #45138595854](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45138595854) completed **success**.
- [Main-push trusted PR fanout #45138595661](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45138595661) **completed success**. The runner log at 2026-11-23 08:26:23 UTC explicitly reports: `Updated PR #53 from latest main + PR-specific task changes (20 tasks)`, event `push`, open-PR count 1.
- The separate open [PR #53](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/53) **did not change its head SHA `4554d867e9c1048e92787aa61d7bd7cf4f1feff2`** during this operation. The bot updated exactly ORB-020's verification display from **`unit`** (its old branch) to **`integration_tested`** (new main), preserving a 20-row table and the related marker. This is independent evidence that an old open PR cannot mask main task verification statuses.
- These real GitHub events, plus the negative tests for conflicting concurrent main/PR task updates and CI plan lint, satisfy ORB-020's **bounded governance acceptance**. Mark ORB-020 `verified/integration_tested` as of this observed webhook, **not** `live_verified` and NOT as product/provider release approval. GitHub branch-protection settings remain hidden to the integration (HTTP 403); cPanel, SMTP, off-host key/witness/backup and production PostgreSQL HTTP identity are outside ORB-020 and still blocked/in-progress.
