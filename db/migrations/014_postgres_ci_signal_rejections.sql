-- ORB-004: bounded, metadata-only quarantine of invalid Redis Stream wakeup
-- signals. This is a SYNTHETIC job worker table, not a production DLQ for
-- arbitrary provider commands or payloads. Worker must persist BEFORE XACK.
BEGIN;
CREATE TABLE IF NOT EXISTS job_signal_rejections (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  redis_entry_id TEXT NOT NULL
    CHECK (redis_entry_id ~ '^[0-9]{1,20}-[0-9]{1,20}$'),
  reason TEXT NOT NULL CHECK (reason IN
    ('tenant_mismatch','invalid_job_id','missing_job')),
  worker_id TEXT NOT NULL CHECK (length(worker_id) BETWEEN 1 AND 128),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  occurrences INTEGER NOT NULL DEFAULT 1 CHECK (occurrences > 0),
  PRIMARY KEY (organization_id,redis_entry_id)
);
CREATE INDEX IF NOT EXISTS job_signal_rejections_recent
  ON job_signal_rejections (organization_id,last_seen_at DESC,redis_entry_id);
-- No policy grants this table to public/read-only tenants. Only the trusted
-- synthetic fixture writer may record rejections or inspect their metadata.
ALTER TABLE job_signal_rejections ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_signal_rejections FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE job_signal_rejections FROM PUBLIC;
COMMIT;
