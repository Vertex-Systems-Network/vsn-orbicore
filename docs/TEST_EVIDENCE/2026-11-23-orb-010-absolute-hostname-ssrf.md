# ORB-010/006 — FQDN trailing-dot local hostname SSRF aliases

**Date:** 2026-11-23 UTC. **State:** Functional PR SHA `bbfe770ca9043821d145a394f5fa5b33bbd227e0` passed hosted GitHub CI. Documentation-head verification and merge pending.

## Finding

The literal hostname restriction in `isBlockedNetworkAddress` denied `localhost`, `*.localhost`, `*.local` and `*.internal` but compared raw suffixes without normalizing absolute DNS root dots. Therefore URLs such as `https://localhost.:2083/` or `https://metadata.google.internal.:2083/` could pass the hostname-only filter despite representing the same local/reserved names. The direct helper could also miss `127.0.0.1.` and IPv4 link-local literals ending with a dot, while WHATWG URL canonicalization sometimes handled them separately.

## Change and tests

- Normalize IDNA-recognized Unicode dot separators, then remove terminal DNS root-dot(s) before applying the existing hostname and IP deny rules.
- Include the conventional `*.localdomain` local alias family as non-public, so `localhost.localdomain.` is refused.
- Two focused Node tests assert direct-helper and `validateExternalEndpoint` denials for 10 blocked local hostname/address spellings and preserve valid ordinary public/FQDN IPv6 handling. No network calls, reverse DNS or real UAPI access.

## Observed GitHub evidence and pending verification

- [Branch CI #45184186363](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45184186363) and [PR CI #45184250737](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45184250737) **passed** on functional SHA `bbfe770c`: **170/170 Node tests**, zero failed; plan/lint, security scan, npm audit, pinned local official CycloneDX schema/SBOM, build/smoke/doctor passed.
- [Chromium/WebAuthn/a11y #45184250970](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45184250970) and [trusted task ledger #45184250759](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45184250759) **passed** on same PR head. PG16/Redis7 workflow did **not** trigger for this scoped diff, and must not be credited as tested on this PR.
- **Remaining:** final docs-head PR checks, squash merge and post-merge main CI. No live provider/network operations were performed.

## Boundaries

This is a literal/hostname syntax guard, **not** DNS answer resolution, route-aware SSRF prevention, DNS rebinding protection, peer IP pinning, proxy tunnel prevention, outbound network isolation, redirect or live provider authorization. ORB-010 remains `in_progress/unit` and ORB-006 remains `blocked/none`. No production access, credentials or hosting actions are authorized.
