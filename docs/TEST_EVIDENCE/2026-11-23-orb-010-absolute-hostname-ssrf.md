# ORB-010/006 — FQDN trailing-dot local hostname SSRF aliases

**Date:** 2026-11-23 UTC. **State:** Feature-branch implementation; GitHub Actions results pending.

## Finding

The literal hostname restriction in `isBlockedNetworkAddress` denied `localhost`, `*.localhost`, `*.local` and `*.internal` but compared raw suffixes without normalizing absolute DNS root dots. Therefore URLs such as `https://localhost.:2083/` or `https://metadata.google.internal.:2083/` could pass the hostname-only filter despite representing the same local/reserved names. The direct helper could also miss `127.0.0.1.` and IPv4 link-local literals ending with a dot, while WHATWG URL canonicalization sometimes handled them separately.

## Change and tests

- Normalize IDNA-recognized Unicode dot separators, then remove terminal DNS root-dot(s) before applying the existing hostname and IP deny rules.
- Include the conventional `*.localdomain` local alias family as non-public, so `localhost.localdomain.` is refused.
- Two focused Node tests assert direct-helper and `validateExternalEndpoint` denials for 10 blocked local hostname/address spellings and preserve valid ordinary public/FQDN IPv6 handling. No network calls, reverse DNS or real UAPI access.

## Required GitHub evidence

Standard branch and PR-head Node suite, lint/plan, security gate, offline CycloneDX schema + SBOM, npm audit, build/smoke/doctor. Chromium/WebAuthn and trusted PR ledger triggered by path. PostgreSQL16/Redis7 workflow is path-scoped and may not trigger for this code path; do not misstate it as executed. Record the functional tested SHA and all actual run URLs. Perform final docs-head verification and post-merge `main` CI before signoff.

## Boundaries

This is a literal/hostname syntax guard, **not** DNS answer resolution, route-aware SSRF prevention, DNS rebinding protection, peer IP pinning, proxy tunnel prevention, outbound network isolation, redirect or live provider authorization. ORB-010 remains `in_progress/unit` and ORB-006 remains `blocked/none`. No production access, credentials or hosting actions are authorized.
