# ORB-005 / ORB-017 — local bind defaults and trusted proxy boundary

**Status:** Code committed to feature branch for GitHub-hosted review; test results and PR head SHA still pending.

## Finding and bounded fix

Prior direct API startup bound to `0.0.0.0` despite README claims of loopback-only local operation. Vite dev config also bound `0.0.0.0` and disabled host checking with `allowedHosts: true`. The API accepted `X-Forwarded-Host` as origin authority and `X-Forwarded-Proto` as a cookie SameSite/Secure signal regardless of the transport peer, allowing untrusted remote clients to spoof proxy metadata if the API were externally exposed. This is not a production deployment authentication remedy.

Changes:
- Default API and Vite bind hosts `127.0.0.1` (ports 41751/41750, as stated by README). Explicit `ORBICORE_API_HOST`/`ORBICORE_WEB_HOST` enables deliberate network test binds; no automatic public exposure. Launch both processes separately.
- Remove `allowedHosts: true` from Vite to retain its built-in development host validation.
- Only loopback peers (`127.0.0.1`, `::1`, mapped `::ffff:127.0.0.1`) can supply forwarded host/protocol authority. Other remote clients use the direct Host and cannot alter HTTPS cookie signal with forwarded metadata.
- Align default WebAuthn dev origin to `http://localhost:41750`; deployments must explicitly configure exact HTTPS origin and RP ID.

## Tests and acceptance

- Fake direct remote peer with `X-Forwarded-Host: attacker.example` and `X-Forwarded-Proto: https` cannot override the direct host or imply HTTPS; loopback proxy behavior remains intentionally compatible.
- API listen host defaults to loopback, explicit `0.0.0.0` override is opt-in.
- Vite development config executes with loopback default, port 41750 and no unrestricted allowed-hosts mode.
- Required: GitHub standard CI, browser and PostgreSQL/Redis service workflows, plan check, and smoke after code commit.

**Important limitations:** Remote reverse proxies outside loopback are not automatically trusted; they require separate operator-owned architecture/allowlist review. Loopback proxy trust is not a universal authenticated-proxy scheme. Local Vite is development-only. This does not provide distributed auth, production HTTPS, an audited reverse proxy trust chain, host firewall, WAF, live provider authorization, PostgreSQL identity cutover, or full production readiness.
