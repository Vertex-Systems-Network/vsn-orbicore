# ORB-010 — Tracked-source secret scanning and SPDX AND/OR policy

**Date:** 2026-11-23  
**PR:** [#43](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/43)  
**Functional tested SHA:** `8bf76afb0ff26e7d953a7b1492cef506e2aa7358`

## Measured GitHub Actions results

- [PR CI #45084282639](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45084282639) and [branch CI #45084279286](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45084279286) both **success** at the same functional SHA. Runner: GitHub-hosted Ubuntu, Node 24.
- `npm test`: **112 passed / 0 failed**, including 3 new ORB-010 adversarial test cases. Original secret scanner passed its own test at the previous CI head but did not contain these negative fixtures.
- `npm run security:check`: **241 recognized, Git-tracked source/text files inspected**, `scanScope:git-tracked-recognized-text-files`, **0 pattern findings**, **0 disallowed lockfile license declarations**, the existing reviewed `caniuse-lite@1.0.30001823 / CC-BY-4.0` exception unchanged. Lockfile metadata reported **189 components**.
- All remaining CI gates were successful: `npm ci`, lint/typecheck, official upstream CycloneDX 1.5 schema validation, `npm audit --audit-level=high` reporting **0 vulnerabilities at that time**, build, smoke and doctor.
- A preceding intermediate commit `dc356de4` failed a new negative test because the npm auth-token fixture was prefixed with `NPM_CONFIG=` rather than using actual npmrc token syntax. The test fixture was corrected in `8bf76afb0ff26e7d953a7b1492cef506e2aa7358`, and both fresh CI runs passed. This was an intermediate test failure, not an accepted final result.

## Scope and threat controls

1. The source gate uses `git ls-files -z --cached` in GitHub CI so root configs, docs, workflow YAML, shell/Python and `.env` variants are inspected, not only `apps/scripts/tests/db`. For standalone temporary test fixture roots it performs recursive, symlink-safe enumeration.
2. High-confidence patterns cover private key PEM markers, AWS access-key IDs (AKIA/ASIA), classic/fine-grained GitHub tokens, GitLab tokens, Stripe live secrets, npmrc auth tokens and cPanel token Authorization headers. Findings contain **relative filename and rule only**, never matched secret text.
3. Generated assets/runtime files and untracked data are explicitly outside the Git source claim. Tracked symlinks are not dereferenced. Recognized tracked text files above 2 MiB fail closed instead of silently skipping.
4. SPDX approval evaluates `AND` as all required licenses and `OR` as any complete acceptable branch, with conventional parentheses. Unsupported and malformed expressions fail closed; exact reviewed data-license exceptions are still pinned by package and lockfile version.
5. Fixture tests exercise previously omitted docs, root dotenv and workflow sources, secret-value-free findings, allowed and forbidden AND/OR nesting, non-scanned generated files, external symlinks and oversized-file rejection.

## Explicit limitations

- These **bounded fingerprints do not constitute full secrets discovery**: history, deleted commits, binary assets, entropy-based unknown tokens, manually configured external secrets and remote hosts are out of scope. A zero-match run does not prove that the repo or deployed service contains no secrets.
- Git-tracked file enumeration and the set of file types are finite; unrecognized extensions and untracked runtime files are not assessed. The 2 MiB bound intentionally stops the gate if a recognized tracked text file exceeds the limit.
- The lightweight SPDX parser is conservative and is **not a legal determination** about distribution obligations, alternative license interpretations, licenses absent from lock metadata or transitive bundle/runtime inventories. No independent release license clearance is claimed.
- The project continues to require production security review, immutable offsite backup/KMS, approved provider access, complete deployed-system SBOM, CI dependency custody and production PostgreSQL tenant/identity cutover. ORB-010 remains `in_progress/unit`.
- Final documentation-head and postmerge `main` CI must be inspected separately.
