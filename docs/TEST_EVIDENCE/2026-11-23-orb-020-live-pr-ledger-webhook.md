# ORB-020 live PR ledger webhook verification

**Status: pending real workflow observation.** This file is a non-secret checkpoint for a GitHub-only, open pull request lifecycle test. Verify that a new PR without task markers gains the canonical task ledger through a trusted default-branch workflow, then confirm commit synchronize and manual PR body edit preserve human text. Do not mark verified before GitHub logs and PR body are checked.

## Actual new-PR event

The trusted-base GitHub Actions [run #45137402693](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45137402693) completed **success** after PR #52 was opened **without** task-table markers. GitHub PR API inspection confirmed the bot inserted 20 canonical task rows, retained human-authored description content and displayed ORB-020 as `testing/unit`, not automatically verified. The runner logged `Updated PR #52 from PR head backlog (20 tasks)`.

## Synchronize/edited events

This commit is the explicit synchronize event fixture. Exact subsequent run and body-head checks will be recorded after GitHub confirms them; no preemptive assertion.
