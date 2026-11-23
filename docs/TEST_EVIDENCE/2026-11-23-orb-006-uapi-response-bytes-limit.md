# ORB-006/010 — bounded success-body consumption at UAPI transport boundary

**Date:** 2026-11-23 UTC. **State:** Feature implementation committed; PR CI pending at document write. All test responses are synthetic in-process `fetchImpl` / Web Streams; no owner-authorized cPanel credentials, remote requests or DNS resolution.

## Finding

The credentialed cPanel UAPI adapter previously invoked `Response.json()` without limiting the size of the provider-controlled HTTP-200 response. An upstream host with malformed, unexpectedly large or deliberately infinite JSON can consume excessive process memory before validation of UAPI `status` or inventory fields. Reliance on a claimed `Content-Length` alone is insufficient, because the response may omit or lie about it.

## Implementation

- Bound success response bytes to **2 MiB**. Refuse a declared Content-Length over the cap *before* reading the body and abort the request.
- Read the response body incrementally through its Web Stream reader; independently track the actual decoded chunks and abort/cancel on first overflow before creating the combined buffer or JSON object.
- Decode UTF-8 with fatal malformed-byte detection and parse JSON in a dedicated fail-closed block. Return `invalid_uapi_response` for invalid encoding/JSON and redacted `uapi_response_too_large` for size breaches.
- Existing HTTP 401/403, 3xx redirect denial, non-2xx errors and UAPI success/status envelope validation remain unchanged.

## Regression cases and checks

- Oversized declared Content-Length: fake body stream, expected size denial and no parsed provider data.
- Lying small Content-Length: two synthetic data chunks cross the actual 2 MiB limit, size denial even when header claims `1`, zero invented sites.
- Valid compact response: one real-looking synthetic domain; malformed UTF-8 and malformed JSON: distinct invalid-response failures; 302 response: redirect denial persists.
- No test token appears in returned JSON, and no live network actions occur.

**Hosted result:** pending until branch/PR GitHub Actions finish. Review standard CI, task ledger and browser workflow before merge. PG16/Redis7 service workflow path-scoping can exclude adapter-only changes; do not infer service proof where not run.

## Limits

2 MiB is an explicit conservative adapter policy, not an owner-verified maximum for all real cPanel versions or large hosting estates. A legitimate larger provider inventory will now fail closed until the limit is reviewed using authorized sandbox evidence. TLS validation, DNS rebinding/peer pinning, live authentication, production key custody, PostgreSQL identity migration and off-host recovery remain unverified. ORB-006 stays `blocked/none`; ORB-010 `in_progress/unit`.
