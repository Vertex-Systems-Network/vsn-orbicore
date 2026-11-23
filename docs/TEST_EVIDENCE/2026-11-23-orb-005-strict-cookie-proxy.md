# ORB-005 — Strict session cookies for loopback HTTPS proxy requests

**Date:** 2026-11-23 UTC. **State:** Functional PR SHA `9feff47644a14a52f1a60d209dc15adac6fc335e` passed hosted GitHub Actions checks. Final docs-head CI/merge pending.

## Finding

The local SQLite API's session-cookie setter treated a **loopback-forwarded HTTPS transport signal** as if it were an operator-approved *cross-site* session deployment. It set `SameSite=None; Secure` on bootstrap/login/logout under forwarded HTTPS. HTTPS transport **does not imply cross-site authorization**. With no deployed cross-origin frontend documented or approved, the same-origin web/API application should keep `SameSite=Strict` consistently.

## Changes

- Set `SameSite=Strict` for both session issuance and expiration, including HTTPS reverse-proxy style requests; remove implicit `SameSite=None` selection.
- Preserve `Secure` whenever already explicitly configured, the previously trusted loopback `X-Forwarded-Proto: https` is present, or the actual TLS socket is encrypted. HTTP local fixture remains non-Secure.
- Add two real localhost HTTP test cases: proxied-HTTPS metadata must issue+expire `HttpOnly; SameSite=Strict; Secure`, and direct HTTP uses `HttpOnly; SameSite=Strict` without false Secure signaling.

## Verified GitHub Actions results

- [Branch CI #45181590407](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45181590407) and [PR CI #45181646049](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45181646049) both succeeded at `9feff476`: **166/166 Node tests**, zero failures including both cookie regressions; plan/lint, security, npm audit, official offline CycloneDX JSON Schema/SBOM, build, smoke and doctor passed.
- [Hosted PostgreSQL16/Redis7 #45181645840](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45181645840) **28/28 jobs passed**; [Chromium/WebAuthn/a11y #45181645934](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45181645934) passed; [trusted PR task ledger #45181645785](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45181645785) passed.
- **Remaining:** documentation-head PR CI/merge and post-merge `main` CI verification. Actual test environment is GitHub-hosted loopback synthetic, not external TLS/proxy.

## Limits

The test simulates an already allowlisted loopback proxy; it does **not** validate a real TLS reverse proxy, encrypted public transport, domain or cookie prefix policies, host trust, production CSRF token design, distributed session store, PostgreSQL authentication migration or live provider authorization. A future cross-site deployment must separately document origin/cookie/CSRF policy and require operator approval before `SameSite=None` could be justified. ORB-005 remains `in_progress/integration_tested`.
