import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";

// Disposable Postgres 16 CI fixture only; this script never processes real
// passwords, shadow verifier bytes or provider accounts.
if (process.env.GITHUB_ACTIONS !== "true" ||
    process.env.ORBICORE_CI_SYNTHETIC_SHADOW_SCHEMA !== "1") {
  throw new Error("ci_shadow_schema_verification_gate_required");
}
const database = {
  host: process.env.PGHOST ?? "127.0.0.1",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "orbicore",
  database: process.env.PGDATABASE ?? "orbicore",
  password: process.env.PGPASSWORD,
  connectionTimeoutMillis: 5000,
  max: 4,
};
const owner = new Pool(database);
let restricted;
const hex = (byte, size) => byte.repeat(size);
const orgA = "org-shadow-a";
const orgB = "org-shadow-b";
const userA = "user-shadow-a";
const userB = "user-shadow-b";
const record = ({
  organizationId = orgA,
  userId = userA,
  credentialEpoch = 1,
  sourceEpoch = 1,
  marker = "ci_fixture_only_no_password",
  kdf = "ci_placeholder_not_a_verifier",
  salt = "ci_fixture:" + hex("a", 32),
  verifier = "ci_fixture:" + hex("b", 64),
  state = "shadow_only",
  key = hex("c", 64),
} = {}) => [
  organizationId, userId, credentialEpoch, sourceEpoch, marker, kdf,
  salt, verifier, state, key,
];
const insert =
  "INSERT INTO orbicore_ci_shadow.credential_drafts(" +
  "organization_id,user_id,credential_epoch,source_epoch,fixture_marker," +
  "kdf_profile,verifier_salt,verifier_digest,state,idempotency_key) " +
  "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)";

async function asStager(sql, parameters = []) {
  const connection = await restricted.connect();
  try {
    await connection.query("BEGIN");
    await connection.query("SET LOCAL ROLE orbicore_ci_shadow_stager");
    const result = await connection.query(sql, parameters);
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}
async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => error?.code === code);
}

try {
  const flags = (await owner.query(
    "SELECT c.relrowsecurity AS enabled,c.relforcerowsecurity AS forced " +
    "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace " +
    "WHERE n.nspname='orbicore_ci_shadow' AND c.relname='credential_drafts'",
  )).rows[0];
  assert.deepEqual(flags, { enabled: true, forced: true });
  assert.equal(Number((await owner.query(
    "SELECT COUNT(*) AS n FROM pg_policies " +
    "WHERE schemaname='orbicore_ci_shadow' AND tablename='credential_drafts'",
  )).rows[0].n), 0);

  const stager = (await owner.query(
    "SELECT rolcanlogin,rolsuper,rolbypassrls,rolinherit " +
    "FROM pg_roles WHERE rolname='orbicore_ci_shadow_stager'",
  )).rows[0];
  assert.deepEqual(stager, {
    rolcanlogin: false, rolsuper: false,
    rolbypassrls: false, rolinherit: false,
  });

  for (const [id, name] of [[orgA, "Synthetic tenant A"], [orgB, "Synthetic tenant B"]]) {
    await owner.query("INSERT INTO public.organizations(id,name) VALUES($1,$2)", [id, name]);
  }
  for (const [id, org, email] of [
    [userA, orgA, "shadow-a@example.test"],
    [userB, orgB, "shadow-b@example.test"],
  ]) {
    await owner.query(
      "INSERT INTO public.users(id,organization_id,email,password_salt," +
      "password_hash,role) VALUES($1,$2,$3,'ci-not-a-real-salt'," +
      "'ci-not-a-real-hash','owner')", [id, org, email],
    );
  }

  await owner.query(insert, record());
  assert.equal(Number((await owner.query(
    "SELECT COUNT(*) AS n FROM orbicore_ci_shadow.credential_drafts",
  )).rows[0].n), 1);

  // The composite (user,tenant) FK prevents a tenant-B row for tenant-A user.
  await rejectsCode(owner.query(insert, record({
    organizationId: orgB, userId: userA, key: hex("d", 64),
  })), "23503");
  await rejectsCode(owner.query(insert, record({
    sourceEpoch: 0, key: hex("d", 64),
  })), "23514");
  await rejectsCode(owner.query(insert, record({
    verifier: "ci_fixture:incorrect", key: hex("d", 64),
  })), "23514");
  await rejectsCode(owner.query(insert, record({
    marker: "real_password", key: hex("d", 64),
  })), "23514");
  await rejectsCode(owner.query(insert, record()), "23505");
  // A second still-pending epoch of the same user is denied.
  await rejectsCode(owner.query(insert, record({
    credentialEpoch: 2, key: hex("d", 64),
  })), "23505");

  // Partial writes roll back as a unit; no claimed shadow checkpoint remains.
  const connection = await owner.connect();
  try {
    await connection.query("BEGIN");
    await connection.query(insert, record({
      organizationId: orgB, userId: userB, key: hex("e", 64),
    }));
    await rejectsCode(connection.query(insert, record({
      organizationId: orgB, userId: userB, key: hex("e", 64),
    })), "23505");
    await connection.query("ROLLBACK");
  } finally {
    connection.release();
  }
  assert.equal(Number((await owner.query(
    "SELECT COUNT(*) AS n FROM orbicore_ci_shadow.credential_drafts " +
    "WHERE organization_id=$1", [orgB],
  )).rows[0].n), 0);

  // An actual non-owner, non-bypass login cannot access the private schema.
  const login = "orbicore_ci_shadow_negative_login";
  const loginPassword = randomBytes(30).toString("hex");
  await owner.query(
    "CREATE ROLE " + login + " LOGIN NOINHERIT NOBYPASSRLS PASSWORD '" +
    loginPassword + "'",
  );
  await owner.query(
    "GRANT orbicore_ci_shadow_stager TO " + login +
    " WITH SET TRUE, INHERIT FALSE",
  );
  restricted = new Pool({ ...database, user: login, password: loginPassword });
  const actor = (await restricted.query(
    "SELECT rolcanlogin,rolsuper,rolbypassrls FROM pg_roles " +
    "WHERE rolname=current_user",
  )).rows[0];
  assert.deepEqual(actor, {
    rolcanlogin: true, rolsuper: false, rolbypassrls: false,
  });
  for (const role of [
    "orbicore_ci_shadow_stager",
    "orbicore_tenant_readonly",
    "orbicore_synthetic_submitter",
  ]) {
    const permission = (await owner.query(
      "SELECT has_schema_privilege($1,'orbicore_ci_shadow','USAGE') AS schema_access," +
      "has_table_privilege($1,'orbicore_ci_shadow.credential_drafts','SELECT') AS read_access," +
      "has_table_privilege($1,'orbicore_ci_shadow.credential_drafts','INSERT') AS write_access",
      [role],
    )).rows[0];
    assert.deepEqual(permission, {
      schema_access: false, read_access: false, write_access: false,
    });
  }
  await rejectsCode(asStager(
    "SELECT verifier_digest FROM orbicore_ci_shadow.credential_drafts",
  ), "42501");
  await rejectsCode(asStager(insert, record({
    organizationId: orgB, userId: userB, key: hex("f", 64),
  })), "42501");

  // Even a mistakenly granted table privilege stays deny-all with FORCE
  // RLS and no policies. The schema/table grant is revoked after this proof.
  await owner.query(
    "GRANT USAGE ON SCHEMA orbicore_ci_shadow TO orbicore_ci_shadow_stager",
  );
  await owner.query(
    "GRANT SELECT,INSERT,UPDATE,DELETE " +
    "ON orbicore_ci_shadow.credential_drafts TO orbicore_ci_shadow_stager",
  );
  assert.equal(Number((await asStager(
    "SELECT COUNT(*) AS n FROM orbicore_ci_shadow.credential_drafts",
  )).rows[0].n), 0);
  await rejectsCode(asStager(insert, record({
    organizationId: orgB, userId: userB, key: hex("f", 64),
  })), "42501");
  assert.equal((await asStager(
    "DELETE FROM orbicore_ci_shadow.credential_drafts WHERE organization_id=$1",
    [orgA],
  )).rowCount, 0);

  const bypass = await restricted.connect();
  try {
    await bypass.query("BEGIN");
    await bypass.query("SET LOCAL ROLE orbicore_ci_shadow_stager");
    await bypass.query("SET LOCAL row_security=off");
    await rejectsCode(bypass.query(
      "SELECT COUNT(*) FROM orbicore_ci_shadow.credential_drafts",
    ), "42501");
    await bypass.query("ROLLBACK");
  } finally {
    bypass.release();
  }
  await owner.query(
    "REVOKE ALL ON orbicore_ci_shadow.credential_drafts " +
    "FROM orbicore_ci_shadow_stager",
  );
  await owner.query(
    "REVOKE ALL ON SCHEMA orbicore_ci_shadow " +
    "FROM orbicore_ci_shadow_stager",
  );
  assert.equal((await owner.query(
    "SELECT has_table_privilege('orbicore_ci_shadow_stager'," +
    "'orbicore_ci_shadow.credential_drafts','SELECT') AS access",
  )).rows[0].access, false);
  assert.equal(Number((await owner.query(
    "SELECT COUNT(*) AS n FROM orbicore_ci_shadow.credential_drafts",
  )).rows[0].n), 1);

  process.stdout.write(JSON.stringify({
    check: "orb-005-ci-pg-shadow-schema",
    fixtureOnly: true,
    postgresRealNonOwner: true,
    forceRls: true,
    noPoliciesDefaultDeny: true,
    compoundTenantFk: true,
    duplicateAndEpochConflict: true,
    transactionRollback: true,
    noDirectSecretsOrWrites: true,
    productionAuthCutover: false,
  }) + "\n");
} finally {
  if (restricted) await restricted.end();
  await owner.end();
}
