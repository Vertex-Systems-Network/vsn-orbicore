#!/usr/bin/env bash
set -euo pipefail

# Disposable service tests only: the existing ORBICORE API remains SQLite.
test -n "$PGPASSWORD" || { echo "missing disposable CI database password"; exit 1; }
mkdir -p .data/ci
psql -X -v ON_ERROR_STOP=1 -f db/migrations/001_postgres_job_leases.sql >/dev/null
psql -X -v ON_ERROR_STOP=1 -f db/migrations/001_postgres_job_leases.sql >/dev/null

psql -X -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO organizations (id, name) VALUES
  ('org-lease-a', 'Test tenant A'), ('org-lease-b', 'Test tenant B')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO accounts (id, organization_id, label, provider, host, username, health, used_bytes, quota_bytes, source) VALUES
  ('acct-lease-a', 'org-lease-a', 'Test A', 'fixture', 'a.invalid', 'demo-a', 'healthy', 0, 1, 'mock_fixture'),
  ('acct-lease-b', 'org-lease-b', 'Test B', 'fixture', 'b.invalid', 'demo-b', 'healthy', 0, 1, 'mock_fixture')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO jobs (id, organization_id, account_id, type, status, created_at, idempotency_key, max_attempts) VALUES
  ('job-lease-a', 'org-lease-a', 'acct-lease-a', 'inventory_refresh', 'queued', NOW(), 'lease-key-a', 3),
  ('job-lease-b', 'org-lease-b', 'acct-lease-b', 'inventory_refresh', 'queued', NOW(), 'lease-key-b', 1)
  ON CONFLICT (id) DO NOTHING;
DO $guard$
BEGIN
  INSERT INTO jobs (id, organization_id, account_id, type, status, created_at)
  VALUES ('invalid-cross-tenant', 'org-lease-a', 'acct-lease-b', 'inventory_refresh', 'queued', NOW());
  RAISE EXCEPTION 'cross-tenant FK accepted';
EXCEPTION WHEN foreign_key_violation THEN NULL;
END
$guard$;
SQL

claim_a=$(psql -X -tA -F '|' -v ON_ERROR_STOP=1 -c "SELECT job_id,claim_token,attempt FROM orbicore_claim_job('org-lease-a','worker-A',30)")
IFS='|' read -r job_a token_a attempt_a <<< "$claim_a"
test "$job_a" = "job-lease-a"
test -n "$token_a"
test "$attempt_a" = "1"
test -z "$(psql -X -tA -v ON_ERROR_STOP=1 -c "SELECT job_id FROM orbicore_claim_job('org-lease-a','worker-other',30)")"
wrong_tenant=$(psql -X -tA -v ON_ERROR_STOP=1 -c "SELECT orbicore_complete_job('org-lease-b','job-lease-a','$token_a','{}'::jsonb)")
test "$wrong_tenant" = "f"

# The first claiming process exited. Force expiry then reclaim in a new session.
psql -X -v ON_ERROR_STOP=1 -c "UPDATE jobs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = 'job-lease-a'" >/dev/null
claim_again=$(psql -X -tA -F '|' -v ON_ERROR_STOP=1 -c "SELECT job_id,claim_token,attempt FROM orbicore_claim_job('org-lease-a','worker-B',30)")
IFS='|' read -r job_again token_again attempt_again <<< "$claim_again"
test "$job_again" = "job-lease-a"
test "$attempt_again" = "2"
test "$token_again" != "$token_a"
test "$(psql -X -tA -v ON_ERROR_STOP=1 -c "SELECT orbicore_complete_job('org-lease-a','job-lease-a','$token_a','{}'::jsonb)")" = "f"
test "$(psql -X -tA -v ON_ERROR_STOP=1 -c "SELECT orbicore_complete_job('org-lease-a','job-lease-a','$token_again','{\"fixture\":true}'::jsonb)")" = "t"
test "$(psql -X -tA -v ON_ERROR_STOP=1 -c "SELECT status || ':' || attempts FROM jobs WHERE id = 'job-lease-a'")" = "completed:2"

claim_b=$(psql -X -tA -F '|' -v ON_ERROR_STOP=1 -c "SELECT job_id,claim_token,attempt FROM orbicore_claim_job('org-lease-b','worker-C',30)")
IFS='|' read -r job_b token_b attempt_b <<< "$claim_b"
test "$job_b" = "job-lease-b"
test "$attempt_b" = "1"
psql -X -v ON_ERROR_STOP=1 -c "UPDATE jobs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = 'job-lease-b'" >/dev/null
test "$(psql -X -tA -v ON_ERROR_STOP=1 -c "SELECT orbicore_fail_exhausted_jobs('org-lease-b')")" = "1"
test "$(psql -X -tA -v ON_ERROR_STOP=1 -c "SELECT status || ':' || error FROM jobs WHERE id = 'job-lease-b'")" = "failed:lease_retry_exhausted"
test -z "$(psql -X -tA -v ON_ERROR_STOP=1 -c "SELECT job_id FROM orbicore_claim_job('org-lease-b','worker-D',30)")"

# Simultaneous connections must not claim the same queued job.
psql -X -v ON_ERROR_STOP=1 -c "INSERT INTO jobs (id, organization_id, account_id, type, status, created_at) VALUES ('job-lease-race','org-lease-a','acct-lease-a','inventory_refresh','queued',NOW())" >/dev/null
psql -X -tA -v ON_ERROR_STOP=1 -c "SELECT job_id FROM orbicore_claim_job('org-lease-a','race-A',30)" > .data/ci/claim-a.txt &
pid_a=$!
psql -X -tA -v ON_ERROR_STOP=1 -c "SELECT job_id FROM orbicore_claim_job('org-lease-a','race-B',30)" > .data/ci/claim-b.txt &
pid_b=$!
wait "$pid_a"
wait "$pid_b"
claim_count=$(cat .data/ci/claim-a.txt .data/ci/claim-b.txt | grep -c '^job-lease-race$' || true)
test "$claim_count" = "1"
test "$(psql -X -tA -v ON_ERROR_STOP=1 -c "SELECT attempts FROM jobs WHERE id='job-lease-race'")" = "1"
rm -f .data/ci/claim-a.txt .data/ci/claim-b.txt

# Redis stream consumer has ended; next consumer reclaims unacked event.
stream=orbicore:ci:lease-signal
redis-cli -h 127.0.0.1 -p 6379 DEL "$stream" >/dev/null
test "$(redis-cli -h 127.0.0.1 -p 6379 --raw XGROUP CREATE "$stream" ci-consumers 0 MKSTREAM)" = "OK"
stream_id=$(redis-cli -h 127.0.0.1 -p 6379 --raw XADD "$stream" '*' job_id job-lease-race)
delivered=$(redis-cli -h 127.0.0.1 -p 6379 --raw XREADGROUP GROUP ci-consumers worker-A COUNT 1 STREAMS "$stream" '>')
[[ "$delivered" == *"$stream_id"* ]]
test "$(redis-cli -h 127.0.0.1 -p 6379 --raw XPENDING "$stream" ci-consumers | head -n 1)" = "1"
redelivered=$(redis-cli -h 127.0.0.1 -p 6379 --raw XAUTOCLAIM "$stream" ci-consumers worker-B 0 0-0 COUNT 1)
[[ "$redelivered" == *"$stream_id"* ]]
test "$(redis-cli -h 127.0.0.1 -p 6379 --raw XACK "$stream" ci-consumers "$stream_id")" = "1"
test "$(redis-cli -h 127.0.0.1 -p 6379 --raw XPENDING "$stream" ci-consumers | head -n 1)" = "0"
redis-cli -h 127.0.0.1 -p 6379 DEL "$stream" >/dev/null

printf '{"task":"ORB-004","kind":"service-backed-leased-job-contract","checkoutSha":"%s","migrationReapplied":true,"tenantFkEnforced":true,"leaseFencing":true,"workerReconnectRecovery":true,"exhaustedAttempts":true,"concurrentClaimUnique":true,"redisStreamRedelivery":true,"apiPostgresAdapterWired":false,"redisWorkerWired":false,"realContainerRestartTested":false}\n' \
  "$GITHUB_SHA" > .data/ci/orb-004-lease-evidence.json
echo "PostgreSQL lease fencing/retry and Redis Streams claim/redelivery passed (test-only)."
