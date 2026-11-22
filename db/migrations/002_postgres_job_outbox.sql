-- ORB-004 additive, retryable migration: PostgreSQL is the durable source of truth
-- for synthetic job creation and notification intent. Redis is a wake-up channel.
-- The existing SQLite auth/account/audit store is NOT migrated by this DDL.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS jobs_id_organization_unique ON jobs (id, organization_id);

CREATE TABLE IF NOT EXISTS job_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES organizations (id),
  job_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  published_at TIMESTAMPTZ,
  publish_attempts INTEGER NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
  redis_entry_id TEXT,
  CONSTRAINT job_outbox_job_tenant_fk
    FOREIGN KEY (job_id, organization_id) REFERENCES jobs (id, organization_id)
      ON DELETE CASCADE,
  CONSTRAINT job_outbox_single_initial_event UNIQUE (job_id)
);

CREATE INDEX IF NOT EXISTS job_outbox_unpublished
  ON job_outbox (organization_id, created_at, id) WHERE published_at IS NULL;
COMMIT;
