# ORB-005/010 — Fetch Metadata gate for browser-sourced local API writes

**Date:** 2026-11-23 UTC. **State:** Code+regression tests committed to branch; hosted CI and PR merge pending at record creation. Real localhost API and fixture SQLite only; no authorized production provider, user account, or external secret.

## Gap

The existing same-Origin helper rejects a supplied foreign, null or malformed `Origin` and correctly binds scheme + host + port. But it deliberately **permits no Origin** to support CLI/API clients. Some unsafe browser requests may omit the Origin header while carrying a browser-controlled `Sec-Fetch-Site` indication of their initiating site. In that scenario the existing Origin check alone cannot distinguish a cross-site browser write from a CLI request. Sibling origins on the same site are also untrusted for tenant action writes, despite SameSite cookie semantics.

## Change

- Add `isAllowedFetchSite` with an explicit allowlist: absent header (non-browser compatibility), literal `same-origin`, or `none` (user-originated navigation). Reject `cross-site`, `same-site`, malformed/empty, multiple/conflicting and unknown values.
- Check this before handling **any unsafe `/api/` method**, not only routes that call `allowSameOrigin`. Denied requests return `403 { error: 'fetch_metadata_denied' }` without beginning credential parsing or database work.
- Preserve independent existing `Origin` check for every handler already using it and the existing no-Origin API client contract. No new cookie attribute, remote secret or production configuration.

## Regression tests and CI plan

1. Unit values: deny 7 hostile or malformed Fetch Metadata representations, allow `same-origin`, `none` and absent metadata.
2. Real local HTTP owner bootstrap: test `cross-site`, `same-site` and malformed values with missing **and exact matching** Origin; assert 403 and zero users. Then accept exact same-origin browser headers.
3. Authenticated fixture API: same-site/cross-site metadata denies new sandbox account creation even when Origin matches. CLI-style no-Origin request with `none` retains existing supported behavior.

Verify final PR head standard Node CI, tasks ledger, browser matrix and path-scoped services if triggered; document measured outcomes before merge.

## Limits

Fetch Metadata is supplied by browsers and can be omitted or forged by non-browser clients. This is an additive browser trust signal, **not a standalone CSRF token mechanism**, and does not prove a production reverse-proxy configuration, third-party browser coverage, real PostgreSQL login authority, cross-instance CSRF defenses, complete MFA/key custody or external cPanel authorizations. ORB-005 stays `in_progress/integration_tested`, ORB-010 `in_progress/unit`.

## Measured PR #79 functional-head CI

At PR head `6b6a89b5c3ae62bbe967028676953c61d58fd1f9`:

- [Standard CI #45204101741](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45204101741) **passed 191/191 Node tests** and workflow lint/plan/security, CycloneDX, dependency audit, build, smoke and doctor.
- [PostgreSQL16/Redis7 services #45204101710](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45204101710) **passed 28/28 disposable synthetic jobs**; this is an integration regression, not production auth cutover.
- [Browser E2E & accessibility #45204101705](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45204101705) **passed 3/3** Chromium, Firefox and WebKit hosted jobs.
- [Trusted task-ledger #45204101747](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45204101747) **passed** with the canonical 20-row backlog table.

Final evidence-doc-head CI/merge were pending when this measured checkpoint was written. No browser navigation attack has been exercised against a real provider or production proxy. ORB-005 and ORB-010 statuses/verification levels unchanged.
