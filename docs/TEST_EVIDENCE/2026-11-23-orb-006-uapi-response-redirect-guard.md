# ORB-006 / ORB-010 — UAPI response metadata and outbound redirect safety

**Status:** GitHub-hosted test verification pending for the proposed mock-only adapter changes.

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
