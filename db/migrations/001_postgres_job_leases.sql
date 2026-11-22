-- ORB-004: tenant-scoped PostgreSQL job ledger with expiring leases and fencing tokens.
-- This additive migration is safe to re-run; it does NOT switch the live API to PostgreSQL.
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS accounts_id_organization_unique
  ON accounts (id, organization_id);

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_account_tenant_fk') THEN
    ALTER TABLE jobs ADD CONSTRAINT jobs_account_tenant_fk
      FOREIGN KEY (account_id, organization_id)
      REFERENCES accounts (id, organization_id);
  END IF;
END
$guard$;

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 3;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_owner TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_token UUID;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_attempt_bounds') THEN
    ALTER TABLE jobs ADD CONSTRAINT jobs_attempt_bounds
      CHECK (attempts >= 0 AND max_attempts > 0 AND attempts <= max_attempts);
  END IF;
END
$guard$;

CREATE INDEX IF NOT EXISTS jobs_tenant_claimable
  ON jobs (organization_id, status, created_at, id);

-- Every claim takes one row lock. SKIP LOCKED prevents competing workers
-- from claiming the same row; the fresh UUID fences off late old owners.
CREATE OR REPLACE FUNCTION orbicore_claim_job(
  p_organization_id TEXT, p_worker_id TEXT, p_lease_seconds INTEGER DEFAULT 30
) RETURNS TABLE (job_id TEXT, claim_token UUID, attempt INTEGER)
LANGUAGE plpgsql AS $body$
BEGIN
  IF p_organization_id IS NULL OR btrim(p_organization_id) = ''
     OR p_worker_id IS NULL OR btrim(p_worker_id) = ''
     OR length(p_worker_id) > 128 OR p_lease_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'invalid_job_lease_request';
  END IF;
  RETURN QUERY
    WITH next_job AS (
      SELECT j.id
      FROM jobs AS j
      WHERE j.organization_id = p_organization_id
        AND j.attempts < j.max_attempts
        AND (j.status = 'queued' OR
          (j.status = 'running' AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= clock_timestamp())))
      ORDER BY j.created_at, j.id
      FOR UPDATE OF j SKIP LOCKED LIMIT 1
    )
    UPDATE jobs AS j
      SET status = 'running',
          attempts = j.attempts + 1,
          started_at = clock_timestamp(),
          lease_owner = p_worker_id,
          lease_token = gen_random_uuid(),
          lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
    FROM next_job
    WHERE j.id = next_job.id
    RETURNING j.id, j.lease_token, j.attempts;
END
$body$;

-- Completing a job requires its tenant and *current* unexpired lease token.
-- A worker that wakes up after a replacement claim cannot overwrite the result.
CREATE OR REPLACE FUNCTION orbicore_complete_job(
  p_organization_id TEXT, p_job_id TEXT, p_claim_token UUID, p_result JSONB
) RETURNS BOOLEAN LANGUAGE plpgsql AS $body$
DECLARE changed INTEGER;
BEGIN
  UPDATE jobs
    SET status = 'completed', completed_at = clock_timestamp(),
        result_json = p_result, error = NULL,
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
    WHERE organization_id = p_organization_id
      AND id = p_job_id AND lease_token = p_claim_token
      AND status = 'running' AND lease_expires_at > clock_timestamp();
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$body$;

-- Dead workers exhausted their configured attempts. Preserve failure and
-- prevent indefinite stuck 'running' rows without a new ownership claim.
CREATE OR REPLACE FUNCTION orbicore_fail_exhausted_jobs(p_organization_id TEXT)
RETURNS INTEGER LANGUAGE plpgsql AS $body$
DECLARE changed INTEGER;
BEGIN
  UPDATE jobs
    SET status = 'failed', error = 'lease_retry_exhausted',
        completed_at = clock_timestamp(),
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
    WHERE organization_id = p_organization_id AND status = 'running'
      AND attempts >= max_attempts
      AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp());
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END
$body$;

COMMIT;
