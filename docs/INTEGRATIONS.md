# Integration boundaries

## cPanel UAPI

Adapter operations start read-only: validate connection, identify cPanel context/version where available, discover domains and account usage, normalize timestamps/errors and save capability evidence. Use HTTPS with certificate validation and API token auth where supported. No live connector is enabled in the initial PoC. UAPI functions/availability vary by version, roles and hosting provider.

## WHM API

Separate adapter and permission profile. Do not route a normal cPanel token through WHM operations. Root/reseller access is explicit and operation-level. Full account transfer is not available from ordinary user permission alone.

## Other adapters (future)

SFTP/SSH with pinned host-key validation; WordPress agent/WP-CLI with site consent; DNS provider APIs per zone; S3-compatible object stores with bucket-scoped credentials; IMAP with privacy controls. Each adapter must document versions, auth, capabilities, error map, retries/rate limits, mock fixtures, security tests and live evidence.

## Adapter contract (draft)

`discoverCapabilities(connectionRef) -> CapabilitySnapshot`; `fetchInventory(connectionRef, cursor?) -> InventoryPage`; `healthCheck(connectionRef) -> HealthResult`. Mutating methods will have separate typed operations with policy check, dry-run, idempotency, audit and explicit permission requirements. Never pass secret values into job payloads.
