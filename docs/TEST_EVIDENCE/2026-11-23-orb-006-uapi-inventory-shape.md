# ORB-006/010 — fail-closed domain inventory shape and no invented document roots

**Date:** 2026-11-23 UTC. **State:** Feature implementation; GitHub PR CI pending. All cPanel responses in this task are synthetic injected JSON, no live provider access.

## Finding

The `LiveCpanelAdapterBoundary.fetchInventory` mock-injectable reader treated any HTTP 200 + UAPI `status:1` as a successful inventory snapshot, even when `data` was absent, an array or missing `main_domain`. This could produce `ok:true, sites:[]` instead of reporting provider response corruption. Per-row normalization also invented `unknown.invalid` and `/public_html` values for missing domain/document-root fields. An invented document root is especially unsafe as a basis for future migration or backup plans.

## Implementation

- Require a non-array object `data`, a non-array `main_domain` object, optional arrays for addons/subdomains, and nonempty string domains across all entries; malformed inventory is rejected with redacted `invalid_uapi_inventory_response`, `accounts:[]`, `sites:[]`.
- Keep real domain and root/version strings unmodified. Missing document root or PHP version is explicit `null` and `metadataComplete:false`, never a made-up path/version; complete records use `metadataComplete:true`.
- Two Node regressions inject ten malformed UAPI success JSON variants and one valid two-domain result. They assert error, zero fake sites, safe metadata and no token returned. `fetchImpl` is always fake, and redirect refusal/UAPI status parsing remain unchanged.

## Required verification

GitHub standard Node/plan/security/npm audit/SBOM/build/smoke/doctor CI, hosted Chromium/Firefox/WebKit browser workflow if triggered, PR task ledger; PostgreSQL16/Redis7 workflow may not be triggered by this isolated adapter path. Record final SHA and actual GitHub Action statuses before merge, then postmerge `main` CI.

## Limits

Actual UAPI response compatibility across cPanel versions, DNS pinning, live token privileges, network/PHP capability restrictions, backup/migration authorization, real HTTP identity and external service access remain unverified. The `ORB-006` lifecycle stays `blocked/none` awaiting owner-authorized disposable scoped cPanel credentials, and `ORB-010` remains `in_progress/unit` until broader security verification.
