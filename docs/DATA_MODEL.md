# Initial data model

All persistent business rows require stable IDs, tenant scope where applicable, creation/update times, provenance, and lifecycle state. Secrets are external references and never values.

| Entity | Key fields | Scope/relationship | Status |
|---|---|---|---|
| Organization | id, name, lifecycle | root tenant | Local `org-demo` tenant seeded for the synthetic fixture |
| User | id, organization_id, email, scrypt salt/hash, role, disabled, created_at | unique by organization/email | Local bootstrap and session sign-in implemented; MFA/recovery not implemented |
| Session | token_hash, user_id, expires_at, created_at | user scoped; opaque token hash only | Local SQLite; 12-hour expiry and logout revocation |
| HostingAccount | id, organization_id, provider_id, label, username_ref, capability_snapshot_id, health, last_synced_at | tenant scoped | Implemented locally with fixture data only |
| Connection | id, account_id, auth_mode, secret_reference, status, checked_at | secret reference only | Designed; not implemented |
| CapabilitySnapshot | id, account_id, provider_version, fetched_at, capabilities_json, source | immutable evidence | Designed |
| Domain / Website | id, account_id, domain, document_root, status, source | account scoped | Implemented locally with mock records |
| Database / EmailAccount | id, account_id, provider_id, masked metadata | account scoped | Designed |
| Job / JobStep | id, tenant_id, actor_id, type, state, idempotency_key, inputs_redacted, outputs_redacted, checkpoints, retries, timestamps | durable, audited | Local refresh job persists tenant and requester; worker rechecks role/tenant/enabled status |
| AuditEvent | id, tenant_id, actor_id, action, policy_decision, target, correlation_id, redacted_details, created_at | tenant scoped; owner/admin read | Local API records bootstrap and refresh success/failure, and exposes tenant-filtered read-only audit rows; tamper evidence/retention/export remain unimplemented |
| StorageEndpoint / Manifest | endpoint_ref, tenant_id, object_key, checksum, encryption, retention | tenant scoped | Designed |
| MigrationPlan / MigrationJob | source, destination, preflight, state, data checksums, approval and rollback window | tenant scoped | Designed |

Production PostgreSQL schema needs reviewed migrations, stronger relational constraints, query enforcement and retention rules. The local SQLite schema is demonstration state, not authoritative customer state.
