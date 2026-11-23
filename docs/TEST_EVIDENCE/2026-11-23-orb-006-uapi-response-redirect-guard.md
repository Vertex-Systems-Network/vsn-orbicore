# ORB-006 / ORB-010 — UAPI response metadata and outbound redirect safety

**Status:** Functional SHA `dfa3eda1c402bb9f65c5bda65f35c9ac3893fb26` passed GitHub-hosted mock verification on 2026-11-23 UTC; documentation-only head still requires CI before merge.

## Finding and scope

The adapter already refuses calls lacking `authorized: true` and explicit username/API token, and validates the initial endpoint with the existing SSRF policy. However, the default `fetch` transport could follow HTTP redirects beyond that validated initial endpoint. Additionally, an HTTP 200 with `{}` or other malformed UAPI metadata was previously interpreted as successful and silently converted to null data.

The bounded change sets `redirect: "manual"`, returns redacted `uapi_redirect_denied` for HTTP 3xx, recognizes either a direct `{ status, data }` response or a wrapped `{ result: { status, data } }` fixture, and only marks explicit numeric `status: 1` with no error entries as success. A `status: 0` (or nonempty `errors`) fails closed; missing/malformed status is `invalid_uapi_response`. All error responses omit the credential and raw provider messages. It does not change provider permissions, activate the live adapter, or call any external endpoint.

### Three synthetic Node tests

- Direct and wrapped successful API fixture results both parse correctly with no token in outputs; capture asserted outbound method, endpoint, and `redirect: "manual"`.
- Seven malformed/error fixtures produce redacted errors and never return `ok:true`.
- An injected HTTP 302 to private link-local metadata address is denied in one fake fetch call without following the Location.

### External reference and limitations

- [Official cPanel UAPI introduction](https://api.docs.cpanel.net/cpanel/introduction) documents `/execute/Module/function`.
- [Official UAPI OpenAPI example](https://api.docs.cpanel.net/specifications/cpanel.openapi/logs) documents `result.status`, `result.errors`, and `result.data` response metadata.
- Official API tokens authorize `cpanel username:APITOKEN` header and HTTPS port 2083: [cPanel token guide](https://api.docs.cpanel.net/cpanel/tokens).

**Important:** This is only mock/fake-fetch verification, not live provider acceptance. DNS resolution/rebinding defenses, full redirect/DNS peer pinning, TLS identity, cPanel capability scopes/version variations, provider-specific quotas and ownership approval remain externally unverified. ORB-006 and ORB-019 must stay `blocked/none` until independently authorized disposable credentials and real provider response checks are supplied. ORB-010 remains `in_progress`. No provider tokens are committed or surfaced.

## Observed GitHub Actions results

- [PR standard CI #45142304785](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45142304785) and [branch CI #45142265198](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45142265198) both completed **success** for functional head `dfa3eda1c402bb9f65c5bda65f35c9ac3893fb26`; **136/136 Node tests** (0 failures), including all three new ORB-006 fake HTTP tests. Standard lint/security gate, CycloneDX schema validation, build, smoke, doctor and dependency audit completed successfully.
- [Chromium/WebAuthn #45142304894](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45142304894) completed success.
- [Trusted-base PR task ledger #45142305018](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45142305018) completed success.
- The PostgreSQL/Redis service workflow did **not** run on this change because its path filters do not include this isolated cPanel adapter or its platform-slice tests. Do not misrepresent older service-workflow success as verification of this commit. No PostgreSQL service logic was changed.

**Unchanged gates:** ORB-006/019 remain blocked/none and ORB-010 remains in_progress/unit. No cPanel sandbox credentials/production network access, DNS peer validation, live provider compatibility, offsite backup, production identity or privilege promotion has been tested.
