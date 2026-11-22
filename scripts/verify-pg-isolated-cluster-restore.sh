#!/usr/bin/env bash
# Isolated PG16 cluster recovery and authenticated encryption, CI only.
# Source DB: GitHub Postgres service on 5432. Target: a distinct ephemeral
# PostgreSQL *cluster* on port 5433, not a database inside the source cluster.
set -euo pipefail
if [[ "${GITHUB_ACTIONS:-}" != "true" ||
      "${ORBICORE_CI_PG_ISOLATED_RESTORE:-}" != "1" ]]; then
  echo "ci_pg_isolated_restore_hosted_fixture_gate_required" >&2; exit 2
fi
: "${PGHOST:?}"; : "${PGPORT:?}"; : "${PGUSER:?}"; : "${PGPASSWORD:?}"
ROOT=".data/ci/pg-isolated-recovery"
mkdir -p "$ROOT"
CONTAINER="orbicore-ci-pg16-independent-${GITHUB_RUN_ID:-fixture}"
RESTORE_PASS="$(openssl rand -hex 24)"
export ORBICORE_CI_PG_ARCHIVE_KEY_HEX="$(openssl rand -hex 32)"
cleanup(){
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -f "$ROOT"/database.dump "$ROOT"/globals.sql \
    "$ROOT"/database.restore "$ROOT"/globals.restore \
    "$ROOT"/database.enc "$ROOT"/globals.enc \
    "$ROOT"/database.tampered.enc "$ROOT"/database.wrong-key.restore \
    "$ROOT"/database.tampered.restore
}
trap cleanup EXIT
pg_src(){
  docker run --rm --network host --env PGPASSWORD \
    --volume "$(pwd)/$ROOT:/archive" postgres:16-alpine "$@"
}
pg_dst(){
  docker run --rm --network host --env PGPASSWORD="$RESTORE_PASS" \
    --volume "$(pwd)/$ROOT:/archive" postgres:16-alpine "$@"
}
source_query(){
  psql -X -A -t -v ON_ERROR_STOP=1 -d orbicore -c "$1"
}
target_query(){
  PGPASSWORD="$RESTORE_PASS" psql -X -A -t -v ON_ERROR_STOP=1 \
    -h 127.0.0.1 -p 5433 -U ci_restore_admin -d orbicore_recovered -c "$1"
}
same_rows(){
  local query="$1" first second
  first="$(source_query "$query" | sha256sum | cut -d' ' -f1)"
  second="$(target_query "$query" | sha256sum | cut -d' ' -f1)"
  [[ "$first" == "$second" ]]
}
# Create nonsecret fixture entries after applying migrations 001-004.
psql -X -v ON_ERROR_STOP=1 -d orbicore >/dev/null <<'SQL'
INSERT INTO organizations(id,name) VALUES
 ('ci-isolated-tenant-a','Fixture tenant A'),
 ('ci-isolated-tenant-b','Fixture tenant B');
INSERT INTO users(id,organization_id,email,password_salt,password_hash,role) VALUES
 ('ci-isolated-user-a','ci-isolated-tenant-a','ci_a@example.test','not-a-salt','not-a-verifier','owner'),
 ('ci-isolated-user-b','ci-isolated-tenant-b','ci_b@example.test','not-a-salt','not-a-verifier','viewer');
INSERT INTO accounts(id,organization_id,label,provider,host,username,health,used_bytes,quota_bytes,source)
VALUES ('ci-isolated-account-a','ci-isolated-tenant-a','Fixture account','mock','nonlive.example.invalid','none','healthy',64,256,'mock_fixture');
INSERT INTO sites(id,account_id,domain,kind,document_root,php_version,status)
VALUES ('ci-isolated-site-a','ci-isolated-account-a','nonlive.example.invalid','static','/fixture','8.3','active');
INSERT INTO jobs(id,organization_id,type,account_id,status,idempotency_key,result_json)
VALUES ('ci-isolated-job-a','ci-isolated-tenant-a','inventory_refresh',
 'ci-isolated-account-a','completed','ci-isolated-idempotency','{"fixture":true}');
INSERT INTO audit_events(id,organization_id,actor,action,target_id,outcome,details_json)
VALUES ('ci-isolated-audit-a','ci-isolated-tenant-a','ci-fixture','ci.backup',
 'ci-isolated-job-a','synthetic','{"fixture":true}');
SQL
# Preserve roles and privileges: source has a NOLOGIN tenant reader.
# pg_dumpall --globals-only is needed; pg_dump alone misses global roles.
# No role password hashes are exported.
pg_src pg_dumpall --host=127.0.0.1 --port=5432 --username=orbicore \
  --globals-only --no-role-passwords --file=/archive/globals.sql
pg_src pg_dump --host=127.0.0.1 --port=5432 --username=orbicore \
  --format=custom --file=/archive/database.dump --dbname=orbicore
SOURCE_DIGEST="$(sha256sum "$ROOT/database.dump" | cut -d' ' -f1)"
# Both SQL globals and PG binary archive are envelope-encrypted on CI runner;
# the generated key is process-only, not an artifact or real KMS key.
node scripts/ci-pg-archive-envelope.mjs seal "$ROOT/database.dump" "$ROOT/database.enc" database >/dev/null
node scripts/ci-pg-archive-envelope.mjs seal "$ROOT/globals.sql" "$ROOT/globals.enc" globals >/dev/null
rm -f "$ROOT/database.dump" "$ROOT/globals.sql"
# Fail closed on wrong process key and modified authenticated ciphertext.
if ORBICORE_CI_PG_ARCHIVE_KEY_HEX="$(openssl rand -hex 32)" \
   node scripts/ci-pg-archive-envelope.mjs open "$ROOT/database.enc" \
   "$ROOT/database.wrong-key.restore" database >/dev/null 2>&1; then
  echo "wrong archive key unexpectedly accepted" >&2;exit 1
fi
[[ ! -e "$ROOT/database.wrong-key.restore" ]]
cp "$ROOT/database.enc" "$ROOT/database.tampered.enc"
printf 'X' | dd of="$ROOT/database.tampered.enc" bs=1 seek=39 conv=notrunc status=none
if node scripts/ci-pg-archive-envelope.mjs open "$ROOT/database.tampered.enc" \
  "$ROOT/database.tampered.restore" database >/dev/null 2>&1; then
  echo "tampered encrypted archive unexpectedly accepted" >&2;exit 1
fi
[[ ! -e "$ROOT/database.tampered.restore" ]]
if node scripts/ci-pg-archive-envelope.mjs open "$ROOT/globals.enc" \
  "$ROOT/database.tampered.restore" database >/dev/null 2>&1; then
  echo "globals archive was misidentified as database archive" >&2;exit 1
fi
node scripts/ci-pg-archive-envelope.mjs open "$ROOT/database.enc" "$ROOT/database.restore" database >/dev/null
node scripts/ci-pg-archive-envelope.mjs open "$ROOT/globals.enc" "$ROOT/globals.restore" globals >/dev/null
[[ "$SOURCE_DIGEST" == "$(sha256sum "$ROOT/database.restore" | cut -d' ' -f1)" ]]
# Separate Docker container, independent PGDATA, different bootstrap
# superuser; not just another database on the source PostgreSQL cluster.
docker run --rm -d --name "$CONTAINER" --network host \
  --env POSTGRES_DB=postgres \
  --env POSTGRES_USER=ci_restore_admin \
  --env POSTGRES_PASSWORD="$RESTORE_PASS" \
  postgres:16-alpine -c port=5433 >/dev/null
ready=0
for attempt in $(seq 1 40); do
  if PGPASSWORD="$RESTORE_PASS" pg_isready -h 127.0.0.1 -p 5433 \
    -U ci_restore_admin -d postgres >/dev/null 2>&1; then ready=1;break;fi
  sleep 1
done
[[ "$ready" == "1" ]] || { echo "isolated PG16 cluster not ready" >&2; exit 1; }
# Target's bootstrap superuser differs from source's orbicore user, so the
# restricted source role can be recreated without a preexisting role conflict.
pg_dst psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5433 \
  -U ci_restore_admin -d postgres -f /archive/globals.restore >/dev/null
pg_dst createdb -h 127.0.0.1 -p 5433 -U ci_restore_admin \
  --owner=orbicore orbicore_recovered
pg_dst pg_restore -h 127.0.0.1 -p 5433 -U ci_restore_admin \
  --single-transaction --exit-on-error \
  --dbname=orbicore_recovered /archive/database.restore >/dev/null
for query in \
  "SELECT id,organization_id,role,disabled,mfa_enabled FROM users ORDER BY id" \
  "SELECT id,organization_id,health,used_bytes,quota_bytes FROM accounts ORDER BY id" \
  "SELECT id,account_id,domain,status FROM sites ORDER BY id" \
  "SELECT id,organization_id,status,result_json FROM jobs ORDER BY id" \
  "SELECT id,organization_id,action,outcome,details_json FROM audit_events ORDER BY id"; do
  if ! same_rows "$query"; then echo "isolated database row drift" >&2;exit 1;fi
done
[[ "$(target_query 'SELECT count(*) FROM organizations')" == "2" ]]
[[ "$(target_query 'SELECT count(*) FROM users')" == "2" ]]
[[ "$(target_query "SELECT rolcanlogin::text||','||rolbypassrls::text FROM pg_roles WHERE rolname='orbicore_tenant_readonly'")" == "false,false" ]] || \
 { echo "tenant reader role metadata missing" >&2;exit 1; }
[[ "$(target_query "SELECT relrowsecurity::text FROM pg_class WHERE oid='public.users'::regclass")" == "true" ]] || \
 { echo "tenant user RLS missing" >&2;exit 1; }
[[ "$(target_query "SELECT has_column_privilege('orbicore_tenant_readonly','public.users','email','SELECT')::text")" == "true" ]] || \
 { echo "tenant reader email grant missing" >&2;exit 1; }
[[ "$(target_query "SELECT has_column_privilege('orbicore_tenant_readonly','public.users','password_hash','SELECT')::text")" == "false" ]] || \
 { echo "credential verifier grant leaked" >&2;exit 1; }
# Cross-tenant query must be scoped in actual non-owner role in target DB.
read_count(){
  target_query "BEGIN; SET LOCAL ROLE orbicore_tenant_readonly; SET LOCAL orbicore.tenant_id='$1'; SELECT count(*) FROM users; ROLLBACK;" | \
    grep -E '^[0-9]+$' | tail -n1
}
[[ "$(read_count ci-isolated-tenant-a)" == "1" ]] || \
 { echo "tenant-A scoped read mismatch" >&2;exit 1; }
[[ "$(read_count ci-isolated-tenant-b)" == "1" ]] || \
 { echo "tenant-B scoped read mismatch" >&2;exit 1; }
[[ "$(read_count ci-unrecognized-tenant)" == "0" ]] || \
 { echo "unknown tenant scoped read mismatch" >&2;exit 1; }
# Illegal relationship fails even when attempted by new cluster's superuser.
if PGPASSWORD="$RESTORE_PASS" psql -X -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 -p 5433 -U ci_restore_admin -d orbicore_recovered \
  -c "INSERT INTO sessions(token_hash,organization_id,user_id,expires_at) VALUES('ci-invalid','ci-isolated-tenant-b','ci-isolated-user-a',NOW()+INTERVAL '1 hour')" >/dev/null 2>&1;then
 echo "cross-tenant restored FK accepted forbidden insert" >&2;exit 1
fi
# Blind second restore into nonempty database must fail.
if pg_dst pg_restore -h 127.0.0.1 -p 5433 -U ci_restore_admin \
 --single-transaction --exit-on-error \
 --dbname=orbicore_recovered /archive/database.restore >/dev/null 2>&1; then
 echo "blind duplicate restore should have failed" >&2;exit 1
fi
printf '%s\n' '{"check":"orb-016-isolated-pg16-cluster-restore","encryption":"AES-256-GCM","sourceAndTargetSeparateClusters":true,"syntheticWholePgArchiveRestored":true,"globalsRolesAndGrants":true,"tenantNonownerRlsProbed":true,"credentialColumnDenied":true,"crossTenantFkDenied":true,"wrongKeyAndTamperDenied":true,"distinctAadContexts":true,"blindReimportDenied":true,"backupKeyPersisted":false,"archiveArtifactUploaded":false,"independentAdminCustody":false,"externalObjectLock":false,"crossRunnerOrOffsiteRestore":false,"realSecretsRestored":false,"productionLoginAuthorized":false}' > "$ROOT/evidence.json"
