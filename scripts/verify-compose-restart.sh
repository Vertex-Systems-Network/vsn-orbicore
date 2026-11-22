#!/usr/bin/env bash
set -euo pipefail

# Only disposable GitHub-hosted Compose projects; never touch a local operator
# stack or its volumes. The project name is unique per Actions run/attempt.
test "$GITHUB_ACTIONS" = "true"
test -n "$GITHUB_RUN_ID"
export COMPOSE_PROJECT_NAME="orbicoreci$GITHUB_RUN_ID$GITHUB_RUN_ATTEMPT"
export ORBICORE_POSTGRES_PASSWORD="ci-only-disposable-password"
export PGHOST=127.0.0.1
export PGPORT=5432
export PGUSER=orbicore
export PGDATABASE=orbicore
export PGPASSWORD="$ORBICORE_POSTGRES_PASSWORD"
mkdir -p .data/ci

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    docker compose ps || true
    docker compose logs --tail 30 postgres redis || true
  fi
  docker compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

pg_sql() {
  docker compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U orbicore -d orbicore "$@"
}
redis_cli() {
  docker compose exec -T redis redis-cli --raw "$@"
}

# This exercises the EXISTING docker-compose.yml with its named data volumes.
docker compose config --quiet
docker compose up -d --wait
pg_sql < db/migrations/001_postgres_job_leases.sql >/dev/null
pg_sql < db/migrations/002_postgres_job_outbox.sql >/dev/null

pg_sql <<'SQL' >/dev/null
INSERT INTO organizations(id, name) VALUES ('org-compose-ci','Disposable Compose tenant');
INSERT INTO accounts(id, organization_id, label, provider, host, username,
  health, used_bytes, quota_bytes, source)
VALUES ('acct-compose-ci','org-compose-ci','Fixture Account','mock',
  'compose.invalid','ci','healthy',0,1,'mock_fixture');
INSERT INTO users(id, organization_id, email, password_salt, password_hash, role)
VALUES ('user-compose-ci','org-compose-ci','compose-actor@example.invalid',
  'ci-placeholder-salt','ci-placeholder-hash','operator');
INSERT INTO jobs(id, organization_id, account_id, type, requested_by, status,
  attempts, max_attempts, lease_owner, lease_token, lease_expires_at, created_at)
VALUES ('job-compose','org-compose-ci','acct-compose-ci','inventory_refresh',
  'user-compose-ci','running',1,3,'dead-compose-worker',
  gen_random_uuid(),clock_timestamp() + INTERVAL '5 seconds',clock_timestamp());
INSERT INTO job_outbox(organization_id, job_id)
VALUES ('org-compose-ci','job-compose');
SQL

test "$(pg_sql -tA -c "SELECT COUNT(*) FROM job_outbox WHERE job_id = 'job-compose'")" = "1"
test "$(redis_cli CONFIG GET appendonly | tail -n 1)" = "yes"
node scripts/verify-compose-redis-aof.mjs > .data/ci/orb-016-compose-aof-before.json
pg_sql -c "UPDATE job_outbox SET published_at = clock_timestamp() WHERE job_id = 'job-compose'" >/dev/null

stream=orbicore:synthetic:jobs:v1:org-compose-ci
group=orbicore-synthetic-v1
test "$(redis_cli XPENDING "$stream" "$group" | head -n 1)" = "1"

before_pg=$(docker compose ps -q postgres)
before_redis=$(docker compose ps -q redis)
test -n "$before_pg"
test -n "$before_redis"

# Remove containers, not named volumes. Recreate from existing Compose config.
docker compose stop postgres redis
docker compose rm -f postgres redis
docker compose up -d --wait

after_pg=$(docker compose ps -q postgres)
after_redis=$(docker compose ps -q redis)
test -n "$after_pg"
test -n "$after_redis"
test "$before_pg" != "$after_pg"
test "$before_redis" != "$after_redis"

# PostgreSQL job, outbox, account and actor must survive *container replacement*.
test "$(pg_sql -tA -c "SELECT COUNT(*) FROM jobs j JOIN job_outbox o ON o.job_id=j.id WHERE j.id='job-compose' AND j.status='running'")" = "1"
test "$(pg_sql -tA -c "SELECT COUNT(*) FROM users WHERE id='user-compose-ci' AND disabled=false")" = "1"

# Redis AOF must restore stream + pending consumer-group state.
test "$(redis_cli EXISTS "$stream")" = "1"
test "$(redis_cli XPENDING "$stream" "$group" | head -n 1)" = "1"
test "$(redis_cli CONFIG GET appendonly | tail -n 1)" = "yes"

# This waits for the lease to expire *naturally*. No artificial timestamp
# update, unlike the previous worker SIGKILL fixture.
sleep 7
export ORBICORE_ENABLE_SYNTHETIC_REDIS_WORKER=1
export ORBICORE_WORKER_ORGANIZATION_ID=org-compose-ci
export ORBICORE_WORKER_ID=compose-recreated-worker
export ORBICORE_WORKER_ONCE=1
export ORBICORE_REDIS_URL=redis://127.0.0.1:6379
node apps/api/synthetic-worker-runner.mjs > .data/ci/orb-016-compose-worker.json

job_state=$(pg_sql -tA -c "SELECT status || ':' || attempts FROM jobs WHERE id='job-compose'")
test "$job_state" = "completed:2"
test "$(pg_sql -tA -c "SELECT result_json->>'processedBy' FROM jobs WHERE id='job-compose'")" = "synthetic_redis_worker"
test "$(redis_cli XPENDING "$stream" "$group" | head -n 1)" = "0"

printf '{"task":"ORB-016","kind":"disposable-compose-recreated-containers","testedSha":"%s","postgresContainerRecreated":true,"redisContainerRecreated":true,"namedVolumesRetained":true,"postgresJobOutboxActorPersisted":true,"redisAofLocalFsyncConfirmed":true,"redisPendingEntryPersisted":true,"naturalLeaseExpiryRecovered":true,"standaloneSyntheticWorkerCompleted":true,"redisPendingAcknowledged":true,"sqliteV7IdentityParity":false,"productionFailoverVerified":false,"liveProviderActions":false}\n' \
  "$GITHUB_SHA" > .data/ci/orb-016-compose-recovery.json

echo "Disposable Compose: Postgres/Redis new containers, retained named volumes, Redis AOF PEL, natural-lease reclaim and synthetic worker passed."
