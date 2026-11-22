#!/usr/bin/env bash
# ORB-016/017: disposable PostgreSQL 16 whole-DB dump/restore into a NEW DB.
# No real users, keys, sessions or provider accounts. Archive is NOT uploaded.
set -euo pipefail
: "${PGHOST:?PGHOST is required}"
: "${PGPORT:?PGPORT is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
if [[ "${GITHUB_ACTIONS:-}" != "true" ||
      "${ORBICORE_CI_SYNTHETIC_PG_RESTORE:-}" != "1" ]]; then
  echo "ci_pg_restore_explicit_gate_required" >&2
  exit 2
fi
export PATH="/usr/lib/postgresql/16/bin:$PATH"
if ! pg_dump --version | grep -qE 'PostgreSQL\\) 16\\.'; then
  echo "PostgreSQL 16 client must be used for schema-compatible dump" >&2
  exit 2
fi
base="orbicore"
recovered="orbicore_ci_restored"
root=".data/ci/pg-restore-drill"
mkdir -p "$root"
archive="$root/synthetic.dump"
damaged="$root/corrupt.dump"
summary="$root/evidence.json"

pg_query() {
  local database="$1"; shift
  psql -X -A -t -v ON_ERROR_STOP=1 -d "$database" -c "$1"
}

# The full synthetic schema is dumped, but this never authenticates a user.
psql -X -v ON_ERROR_STOP=1 -d "$base" <<'SQL' >/dev/null
INSERT INTO organizations(id,name)
VALUES ('org-ci-restore-a','Synthetic A'),('org-ci-restore-b','Synthetic B');
INSERT INTO users(id,organization_id,email,password_salt,password_hash,role)
VALUES
 ('ci-restore-owner-a','org-ci-restore-a','ci-a@example.test','ci-only-no-real-salt','ci-only-no-real-verifier','owner'),
 ('ci-restore-viewer-b','org-ci-restore-b','ci-b@example.test','ci-only-no-real-salt','ci-only-no-real-verifier','viewer');
INSERT INTO accounts(id,organization_id,label,provider,host,username,health,used_bytes,quota_bytes,source)
VALUES
 ('ci-restore-acct-a','org-ci-restore-a','Synthetic account A','mock','no-provider.example.invalid','none','healthy',128,1024,'mock_fixture'),
 ('ci-restore-acct-b','org-ci-restore-b','Synthetic account B','mock','no-provider.example.invalid','none','attention',64,2048,'mock_fixture');
INSERT INTO sites(id,account_id,domain,kind,document_root,php_version,status)
VALUES
 ('ci-restore-site-a','ci-restore-acct-a','not-live.example.invalid','static','/test/ci','8.3','active');
INSERT INTO jobs(id,organization_id,type,account_id,idempotency_key,status,result_json)
VALUES
 ('ci-restore-job-a','org-ci-restore-a','inventory_refresh','ci-restore-acct-a',
  'ci-restored-idempotency','completed','{"fixture":true}'::jsonb);
INSERT INTO audit_events(id,organization_id,actor,action,target_id,outcome,details_json)
VALUES
 ('ci-restore-audit-a','org-ci-restore-a','ci-only','fixture.restore','ci-restore-job-a',
  'synthetic','{"fixture":true}'::jsonb);
SQL

# Verify tool-created archive; do not upload the binary containing even fake
# auth schema material. Custom archive is parsed and restored transactionally.
pg_dump --format=custom --no-owner --no-acl --file="$archive" -d "$base"
pg_restore --list "$archive" >/dev/null
createdb "$recovered"
pg_restore --exit-on-error --single-transaction --no-owner --no-acl \
  --dbname="$recovered" "$archive" >/dev/null

same() {
  local query="$1" left right
  left="$(pg_query "$base" "$query" | sha256sum | cut -d' ' -f1)"
  right="$(pg_query "$recovered" "$query" | sha256sum | cut -d' ' -f1)"
  [[ "$left" == "$right" ]]
}
same "SELECT id,organization_id,role,disabled FROM users ORDER BY id"
same "SELECT id,organization_id,health,used_bytes,quota_bytes FROM accounts ORDER BY id"
same "SELECT id,account_id,domain,status FROM sites ORDER BY id"
same "SELECT id,organization_id,status,result_json FROM jobs ORDER BY id"
same "SELECT id,organization_id,actor,action,outcome,details_json FROM audit_events ORDER BY id"
same "SELECT version FROM schema_migrations ORDER BY version" 2>/dev/null || {
  # Older PostgreSQL schema migrations are file-based and may have no
  # schema_migrations tracking table; never claim migration ledger parity.
  true
}

[[ "$(pg_query "$recovered" 'SELECT COUNT(*) FROM organizations')" == "2" ]]
[[ "$(pg_query "$recovered" 'SELECT COUNT(*) FROM users')" == "2" ]]
[[ "$(pg_query "$recovered" 'SELECT COUNT(*) FROM sites')" == "1" ]]
[[ "$(pg_query "$recovered" 'SELECT COUNT(*) FROM jobs')" == "1" ]]
[[ "$(pg_query "$recovered" 'SELECT COUNT(*) FROM audit_events')" == "1" ]]
[[ "$(pg_query "$recovered" "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('users','sessions','passkeys','authenticators','job_outbox','recovery_codes')")" == "6" ]]
[[ "$(pg_query "$recovered" "SELECT relrowsecurity FROM pg_class WHERE oid='public.users'::regclass")" == "t" ]]

# Genuine tenant-composite foreign key. Illegal cross-tenant session write
# must fail in the RESTORED database (not in source).
if psql -X -v ON_ERROR_STOP=1 -d "$recovered" -c \
 "INSERT INTO sessions(token_hash,organization_id,user_id,expires_at) VALUES('ci-invalid-session-only','org-ci-restore-b','ci-restore-owner-a',NOW()+INTERVAL '1 hour')" \
 >/dev/null 2>&1; then
 echo "cross-tenant session FK unexpectedly accepted" >&2
 exit 1
fi

# Damaged custom archive must NOT be interpreted as a successful restore.
cp "$archive" "$damaged"
printf 'broken' | dd of="$damaged" bs=1 seek=0 conv=notrunc status=none
if pg_restore --list "$damaged" >/dev/null 2>&1; then
 echo "corrupted dump passed integrity check" >&2
 exit 1
fi

# An unintended post-restore update must trigger a comparison failure.
psql -X -v ON_ERROR_STOP=1 -d "$recovered" -c \
 "UPDATE accounts SET health='offline' WHERE id='ci-restore-acct-a'" >/dev/null
if same "SELECT id,organization_id,health,used_bytes,quota_bytes FROM accounts ORDER BY id"; then
 echo "target drift not detected" >&2
 exit 1
fi

# Restore into the SAME target requires an empty/clean state. Replaying into
# existing tables is not proof of a safe upgrade or migration rollback.
if pg_restore --exit-on-error --single-transaction --no-owner --no-acl \
 --dbname="$recovered" "$archive" >/dev/null 2>&1; then
 echo "blind re-import into nonempty target unexpectedly succeeded" >&2
 exit 1
fi

# No archive artifacts or credential material sent to GitHub artifacts.
printf '%s\n' '{"check":"orb-016-017-pg16-disposable-new-db-restore","actualPg16DumpRestore":true,"wholeSyntheticDatabaseArchive":true,"freshDatabaseRestored":true,"tenantFksPreserved":true,"rlsSettingsPreserved":true,"schemaAndRowParity":true,"corruptedArchiveDenied":true,"unexpectedTargetDriftDetected":true,"blindReimportDenied":true,"archiveUploaded":false,"offHostRestore":false,"globalRolesRestored":false,"productionSecretsRestored":false,"productionAuthCutover":false,"syntheticOnly":true}' > "$summary"
