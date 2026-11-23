# ORB-010/006 — IPv4-mapped IPv6 canonicalization at endpoint validation boundary

**Date:** 2026-11-23 UTC. **State:** Functional PR SHA `d300eed4ac01a9506d74ed8d9bac5a027849ae0a` passed GitHub-hosted standard and browser checks. Documentation-head CI/merge pending. No real provider requests in this change.

## Finding

`isBlockedIPv6` previously applied its IPv4 deny list only when the suffix of `::ffff:` was an IPv4 **dotted quad**. Valid equivalent IPv6 forms such as `::ffff:7f00:1` (127.0.0.1), `::ffff:a9fe:a9fe` (169.254.169.254), and `0:0:0:0:0:ffff:a00:1` (10.0.0.1) could fail to match the blocked IPv4 ranges and pass the literal endpoint guard.

## Changes

- Canonicalize valid IPv6 via WHATWG URL parsing. `isBlockedNetworkAddress` already calls `isIP` before entering this helper. Fail closed if URL canonicalization fails.
- Decode mapped IPv6's final two 16-bit hex groups into four IPv4 octets and apply existing `isBlockedIPv4` deny ranges, preserving already blocked loopback, link-local, ULA behavior.
- Add two Node tests covering expanded and hex private/mapped addresses, direct `validateExternalEndpoint` rejection, and representative public IPv6/mapped IPv4 address handling. No DNS/network I/O or provider credentials.

## Observed hosted GitHub verification

- [Branch CI #45182998550](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45182998550) and [PR CI #45183052897](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45183052897) both **passed** at `d300eed4`: **168/168 Node tests**, zero failures; plan/lint, security, npm audit, official local CycloneDX schemas/SBOM, build, smoke and doctor passed.
- [Chromium/WebAuthn/a11y #45183052673](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45183052673) and [trusted PR ledger #45183052794](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45183052794) both passed. PostgreSQL16/Redis7 service workflow was **not triggered** by this literal security file/test/docs diff under its scoped paths; no service result is claimed for this PR.

- **Remaining:** final documentation-head GitHub CI, PR merge and postmerge main CI evidence. 

## Explicit limits

A resolved hostname may still undergo DNS rebinding between validation and connection. This fix is only a parsed *literal* address normalization hardening, not DNS answer pinning, egress firewalls, IPv6 transition/translation-route analysis, redirect policy, live cPanel authorization or a claim that a generic public IPv6 endpoint is reachable. ORB-010 remains `in_progress/unit` with broader high-risk security checks pending, ORB-006 remains `blocked/none` for an authorized sandbox, ORB-015 stays `verified/unit` for its existing bounded CI deliverable.
