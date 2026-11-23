# ORB-005 — Strict session cookies for loopback HTTPS proxy requests

**Date:** 2026-11-23 UTC. **State:** Feature-branch implementation, hosted GitHub Actions verification pending.

## Finding

The local SQLite API's session-cookie setter treated a **loopback-forwarded HTTPS transport signal** as if it were an operator-approved *cross-site* session deployment. It set `SameSite=None; Secure` on bootstrap/login/logout under forwarded HTTPS. HTTPS transport **does not imply cross-site authorization**. With no deployed cross-origin frontend documented or approved, the same-origin web/API application should keep `SameSite=Strict` consistently.

## Changes

- Set `SameSite=Strict` for both session issuance and expiration, including HTTPS reverse-proxy style requests; remove implicit `SameSite=None` selection.
- Preserve `Secure` whenever already explicitly configured, the previously trusted loopback `X-Forwarded-Proto: https` is present, or the actual TLS socket is encrypted. HTTP local fixture remains non-Secure.
- Add two real localhost HTTP test cases: proxied-HTTPS metadata must issue+expire `HttpOnly; SameSite=Strict; Secure`, and direct HTTP uses `HttpOnly; SameSite=Strict` without false Secure signaling.

## Verification required

- GitHub standard CI: Node tests, plan, lint, security, npm audit, official offline CycloneDX JSON Schema/SBOM, build, smoke and doctor.
- Real hosted PostgreSQL16/Redis7 synthetic services and Chromium/WebAuthn/a11y regression workflow, trusted-base task ledger.
- Final tested SHA, complete CI URLs/status and post-merge `main` CI.

## Limits

The test simulates an already allowlisted loopback proxy; it does **not** validate a real TLS reverse proxy, encrypted public transport, domain or cookie prefix policies, host trust, production CSRF token design, distributed session store, PostgreSQL authentication migration or live provider authorization. A future cross-site deployment must separately document origin/cookie/CSRF policy and require operator approval before `SameSite=None` could be justified. ORB-005 remains `in_progress/integration_tested`.
