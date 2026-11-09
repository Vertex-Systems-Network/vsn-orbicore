# Initial data model

All persistent business rows require stable IDs, tenant scope where applicable, creation/update times, provenance, and lifecycle state. Secrets are external references and never values.

| Entity | Key fields | Scope/relationship | Status |
|---|---|---|---|
| Organization | id, name, lifecycle | root tenant | Designed |
| Membership | organization_id, user_id, role_id | unique per organization/user | Designed; auth absent |
| HostingAccount | id, organization_id, provider_id, label, username_ref, capability_snapshot_id, health, last_synced_at | tenant scoped | Implemented locally with fixture data only |
| Connection | id, account_id, auth_mode, secret_reference, status, checked_at | secret reference only | Designed; not implemented |
| CapabilitySnapshot | id, account_id, provider_version, fetched_at, capabilities_json, source | immutable evidence | Designed |
| Domain / Website | id, account_id, domain, document_root, status, source | account scoped | Implemented locally with mock records |
| Database / EmailAccount | id, account_id, provider_id, masked metadata | account scoped | Designed |
| Job / JobStep | id, tenant_id, actor_id, type, state, idempotency_key, inputs_redacted, outputs_redacted, checkpoints, retries, timestamps | durable, audited | Local refresh job is first implementation |
| AuditEvent | id, tenant_id, actor_id, action, policy_decision, target, correlation_id, redacted_details, created_at | append-only | Designed; PoC event logging only |
| StorageEndpoint / Manifest | endpoint_ref, tenant_id, object_key, checksum, encryption, retention | tenant scoped | Designed |
| MigrationPlan / MigrationJob | source, destination, preflight, state, data checksums, approval and rollback window | tenant scoped | Designed |

Production PostgreSQL schema needs constraints/indexes, migrations, tenant query enforcement and retention rules. The local SQLite schema is disposable demonstration state, not authoritative customer state.
