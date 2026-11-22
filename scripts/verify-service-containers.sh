#!/usr/bin/env bash
set -euo pipefail
# Only disposable CI service containers; no application adapter or worker recovery.
command -v psql >/dev/null || { echo "psql client unavailable"; exit 1; }
command -v redis-cli >/dev/null || { echo "redis-cli unavailable"; exit 1; }
test -n "$PGPASSWORD" || { echo "CI PostgreSQL credential not provided"; exit 1; }

mkdir -p .data/ci
psql -X -v ON_ERROR_STOP=1 -f db/postgres-schema.sql
psql -X -v ON_ERROR_STOP=1 -f db/postgres-schema.sql

psql -X -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO organizations (id, name) VALUES ('org-ci', 'Synthetic CI organization')
ON CONFLICT (id) DO NOTHING;
INSERT INTO accounts (id, organization_id, label, provider, host, username, health, used_bytes, quota_bytes, source)
VALUES ('acct-ci', 'org-ci', 'Disposable test account', 'cpanel', 'ci.example.invalid', 'ci_user', 'healthy', 40, 100, 'mock_fixture')
ON CONFLICT (id) DO NOTHING;
INSERT INTO jobs (id, organization_id, type, account_id, status, idempotency_key)
VALUES ('job-ci', 'org-ci', 'inventory.refresh', 'acct-ci', 'queued', 'ci-job-key')
ON CONFLICT (id) DO NOTHING;
SQL

status=$(psql -X -tA -v ON_ERROR_STOP=1 -c "SELECT status FROM jobs WHERE id = 'job-ci'")
test "$status" = "queued" || { echo "Postgres job row did not persist"; exit 1; }

psql -X -v ON_ERROR_STOP=1 <<'SQL'
DO $block$
BEGIN
  INSERT INTO jobs (id, organization_id, type, account_id, status, idempotency_key)
  VALUES ('job-duplicate', 'org-ci', 'inventory.refresh', 'acct-ci', 'queued', 'ci-job-key');
  RAISE EXCEPTION 'idempotency key uniqueness was not enforced';
EXCEPTION WHEN unique_violation THEN NULL;
END $block$;
DO $block$
BEGIN
  INSERT INTO jobs (id, organization_id, type, account_id, status)
  VALUES ('job-invalid-tenant', 'org-missing', 'inventory.refresh', 'acct-ci', 'queued');
  RAISE EXCEPTION 'organization foreign key was not enforced';
EXCEPTION WHEN foreign_key_violation THEN NULL;
END $block$;
SQL

test "$(redis-cli -h 127.0.0.1 -p 6379 --raw PING)" = "PONG"
test "$(redis-cli -h 127.0.0.1 -p 6379 --raw SET orbicore:ci:probe disposable EX 60)" = "OK"
test "$(redis-cli -h 127.0.0.1 -p 6379 --raw GET orbicore:ci:probe)" = "disposable"
ttl=$(redis-cli -h 127.0.0.1 -p 6379 --raw TTL orbicore:ci:probe)
test "$ttl" -gt 0
test "$(redis-cli -h 127.0.0.1 -p 6379 --raw DEL orbicore:ci:probe)" = "1"

pg_client=$(psql --version)
redis_client=$(redis-cli --version)
printf '{"task":"ORB-016","testKind":"hosted-service-parity","checkoutSha":"%s","postgresClient":"%s","redisClient":"%s","schemaAppliedTwice":true,"syntheticJobPersisted":true,"uniqueConstraint":true,"organizationForeignKey":true,"redisRoundTrip":true,"redisTTL":true,"productionAdapterVerified":false,"workerRecoveryVerified":false}\n' \
  "$GITHUB_SHA" "$pg_client" "$redis_client" > .data/ci/orb-016-service-parity.json
echo "Hosted Postgres and Redis service-level checks passed; application DB/queue integration remains unverified."
