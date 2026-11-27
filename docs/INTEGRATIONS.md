# Integration boundaries

## cPanel UAPI

Adapter operations start read-only: validate connection, identify cPanel context/version where available, discover domains and account usage, normalize timestamps/errors and save capability evidence. Use HTTPS with certificate validation and API token auth where supported. No live connector is enabled in the initial PoC. UAPI functions/availability vary by version, roles and hosting provider.

## WHM API

Separate adapter and permission profile. Do not route a normal cPanel token through WHM operations. Root/reseller access is explicit and operation-level. Full account transfer is not available from ordinary user permission alone.

## Other adapters (future)

SFTP/SSH with pinned host-key validation; WordPress agent/WP-CLI with site consent; DNS provider APIs per zone; S3-compatible object stores with bucket-scoped credentials; IMAP with privacy controls. Each adapter must document versions, auth, capabilities, error map, retries/rate limits, mock fixtures, security tests and live evidence.

## Adapter contract (draft)

`discoverCapabilities(connectionRef) -> CapabilitySnapshot`; `fetchInventory(connectionRef, cursor?) -> InventoryPage`; `healthCheck(connectionRef) -> HealthResult`. Mutating methods will have separate typed operations with policy check, dry-run, idempotency, audit and explicit permission requirements. Never pass secret values into job payloads.

## cPanel UAPI fail-closed return and redirect policy (synthetic fixture checkpoint)

For the `/execute/Module/function` adapter, accept UAPI success only when the parsed response supplies an explicit numeric `status: 1`; reject status 0, missing status, unsupported status types, unexpected structures and explicit error arrays without exposing token data. Both direct `status/data` objects and documented `result.status/result.data` envelope fixtures are recognized. A 3xx response is never followed; Node fetch uses `redirect: "manual"` and returns a redacted `uapi_redirect_denied`. See [fixture-only tests](TEST_EVIDENCE/2026-11-23-orb-006-uapi-response-redirect-guard.md). This is not a claim that any live cPanel account or provider return shape was validated.

## Capability evidence scope (synthetic checkpoint)

Quota-only UAPI discovery reports read-only quota function success, not validated quota values. All other capabilities remain unknown/unprobed. Static fixture profiles are not proof of real account permissions. See [test plan](TEST_EVIDENCE/2026-11-27-orb-002-evidence-scoped-cpanel-capabilities.md).
