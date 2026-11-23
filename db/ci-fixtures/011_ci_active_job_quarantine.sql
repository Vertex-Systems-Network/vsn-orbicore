-- ORB-004/016: CI-ONLY quarantine of active SQLite fixture job metadata.
-- NOT a production migration, job queue, recovery mechanism, worker entrypoint
-- or permission grant. Applied ONLY by a disposable GitHub Actions service job.
BEGIN;
CREATE SCHEMA IF NOT EXISTS orbicore_ci_quarantine;
REVOKE ALL ON SCHEMA orbicore_ci_quarantine FROM PUBLIC;
CREATE TABLE IF NOT EXISTS orbicore_ci_quarantine.active_jobs (
  source_job_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  source_status TEXT NOT NULL CHECK (source_status IN ('queued','running')),
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  metadata_sha256 TEXT NOT NULL CHECK (metadata_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ci_quarantined_key_unique UNIQUE (organization_id, idempotency_key),
  CONSTRAINT ci_quarantined_start_consistency CHECK (
    (source_status = 'queued' AND started_at IS NULL) OR
    (source_status = 'running' AND started_at IS NOT NULL AND started_at >= created_at)
  )
);
ALTER TABLE orbicore_ci_quarantine.active_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE orbicore_ci_quarantine.active_jobs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA orbicore_ci_quarantine FROM PUBLIC;
-- Intentionally no RLS policy, public view, function, worker permission or grant.
COMMIT;
