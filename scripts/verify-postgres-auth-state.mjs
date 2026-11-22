import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createApp } from "../apps/api/server.mjs";
import { appendAuditEvent, verifyAuditChain } from "../apps/api/audit.mjs";
import {
  copySyntheticIdentityWithAuthSnapshot, createPostgresIdentityCoreReader,
} from "../apps/api/postgres-identity-core.mjs";

// Never use an actual person, authenticator secret or hosting account.
if (process.env.GITHUB_ACTIONS !== "true" ||
    process.env.ORBICORE_CI_SYNTHETIC_AUTH_IMPORT !== "1") {
  throw new Error("synthetic_ci_only");
}
const pool = new Pool({
  host: process.env.PGHOST ?? "127.0.0.1",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "orbicore",
  database: process.env.PGDATABASE ?? "orbicore",
  password: process.env.PGPASSWORD,
  connectionTimeoutMillis: 5000,
});
const app = createApp({
  dbPath: ":memory:", startWorker: false,
  bootstrapToken: "ci-auth-only-bootstrap-token-do-not-use",
});
const hash = (s) => createHash("sha256").update(s).digest("hex");
const now = new Date().toISOString();
const future = new Date(Date.now() + 15 * 60_000).toISOString();
let ownerId, userOther, tokenHash;
function sourceCount(table) {
  return app.db.prepare("SELECT COUNT(*) AS n FROM " + table).get().n;
}
async function pgCount(table) {
  return Number((await pool.query("SELECT COUNT(*)::int AS n FROM " + table)).rows[0].n);
}
async function actorFor(tenant, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE orbicore_tenant_readonly");
    if (tenant) await client.query("SELECT set_config('orbicore.tenant_id',$1,true)", [tenant]);
    return await operation(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
try {
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0,"127.0.0.1",resolve);
  });
  const response = await fetch(
    "http://127.0.0.1:" + app.server.address().port + "/api/auth/bootstrap",
    { method:"POST", headers:{"content-type":"application/json"},
      body:JSON.stringify({
        token:"ci-auth-only-bootstrap-token-do-not-use",
        email:"auth-owner@example.test", password:"ci-auth-secret-not-for-production",
      }) },
  );
  assert.equal(response.status, 201);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  tokenHash = hash(cookie.slice(cookie.indexOf("=") + 1));
  ownerId = app.db.prepare("SELECT id FROM users WHERE email = 'auth-owner@example.test'").get().id;
  userOther = randomUUID();
  app.db.prepare("INSERT INTO organizations (id,name,created_at) VALUES (?,?,?)")
    .run("org-auth-other", "Disposable other", now);
  app.db.prepare(
    "INSERT INTO users (id,organization_id,email,password_salt,password_hash,role,created_at) " +
    "VALUES (?,?,?,?,?,'viewer',?)",
  ).run(userOther,"org-auth-other","other-user@example.invalid","synthetic-salt","synthetic-hash",now);
  app.db.prepare(
    "INSERT INTO accounts (id,organization_id,label,provider,host,username,health,used_bytes,quota_bytes,source) " +
    "VALUES (?,?,?,?,?,?,?,0,1,?)",
  ).run("other-auth-acct","org-auth-other","Fixture","mock","none.invalid","ci","healthy","mock_fixture");

  app.db.prepare("UPDATE users SET mfa_enabled=1 WHERE id=?").run(ownerId);
  app.db.prepare(
    "INSERT INTO authenticators(user_id,encrypted_secret,enabled,pending_expires_at,last_totp_step) " +
    "VALUES(?,?,1,NULL,?)",
  ).run(ownerId,"ci-fixture-encrypted:dummy-not-an-authenticator-key",18);
  const passkey1="ci-key-owner",passkey2="ci-key-other";
  const insertPasskey=app.db.prepare(
    "INSERT INTO passkeys(credential_id,user_id,public_key,counter,transports_json,device_type,backed_up,created_at,last_used_at) " +
    "VALUES(?,?,?,?,?,?,?, ?,?)",
  );
  insertPasskey.run(passkey1,ownerId,"ci-fixture-credential:owner-public-only",4,
    '["internal","usb"]',"singleDevice",0,now,null);
  insertPasskey.run(passkey2,userOther,"ci-fixture-credential:other-public-only",0,
    '[]',"multiDevice",1,now,null);
  app.db.prepare(
    "INSERT INTO webauthn_challenges(handle_hash,challenge,user_id,purpose,expires_at,created_at) " +
    "VALUES(?, ?, ?, 'registration', ?, ?)",
  ).run(hash("fixture-handle"),"ci-fixture-challenge",ownerId,future,now);
  app.db.prepare(
    "INSERT INTO recovery_codes(user_id,code_hash,used_at) VALUES (?,?,NULL)",
  ).run(ownerId,hash("fixture-recovery-code"));
  app.db.prepare(
    "INSERT INTO login_challenges(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)",
  ).run(hash("fixture-login-challenge"),ownerId,future,now);
  app.db.prepare(
    "INSERT INTO notification_outbox(id,user_id,event,recipient,status,attempts,last_error,idempotency_key,created_at,updated_at) " +
    "VALUES(?,?,?,?,?,0,NULL,?,?,?)",
  ).run("notice-auth-ci",ownerId,"mfa.confirmed","owner@example.test","queued",
    "synthetic-idempotency",now,now);
  app.db.prepare(
    "INSERT INTO recovery_contacts(id,user_id,channel,address,verified_at,verification_token_hash,verification_expires_at,created_at) " +
    "VALUES (?,?,?,?,?,?,?,?)",
  ).run("contact-auth-ci",ownerId,"email","owner@example.test",now,
    hash("fixture-verification-token"),future,now);
  appendAuditEvent(app.db,{
    organizationId:"org-auth-other",actor:userOther,action:"fixture.auth.sample",
    targetId:userOther,outcome:"created",details:{ second:2, first:1 },
    createdAt:now,
  });
  assert.equal(verifyAuditChain(app.db,"org-demo").valid,true);
  assert.equal(verifyAuditChain(app.db,"org-auth-other").valid,true);
  const run = () => copySyntheticIdentityWithAuthSnapshot({
    sqlite:app.db,postgres:pool,consent:"fixture_only_auth_offline_copy",
  });

  // Exact refusal and rollback boundaries before the valid copy.
  await assert.rejects(copySyntheticIdentityWithAuthSnapshot({
    sqlite:app.db,postgres:pool,
  }),/explicit_synthetic_offline_copy_required/);
  app.db.prepare("UPDATE passkeys SET public_key='non-fixture' WHERE credential_id=?")
    .run(passkey1);
  await assert.rejects(run(),/non_fixture_auth_material_refused/);
  app.db.prepare("UPDATE passkeys SET public_key='ci-fixture-credential:owner-public-only' WHERE credential_id=?")
    .run(passkey1);

  app.db.prepare("UPDATE passkeys SET counter=-1 WHERE credential_id=?").run(passkey1);
  await assert.rejects(run(),(error)=>error.code==="23514");
  // PostgreSQL failure halfway through the copy must leave *all* tables empty.
  for(const table of [
    "organizations","users","accounts","sessions","audit_events",
    "passkeys","authenticators","recovery_codes","notification_outbox",
  ]) assert.equal(await pgCount(table),0,"non-atomic rollback: "+table);
  app.db.prepare("UPDATE passkeys SET counter=4 WHERE credential_id=?").run(passkey1);

  const result=await run();
  assert.equal(result.scope,"synthetic_auth_state_only");
  assert.equal(result.counts.passkeys,2);
  assert.equal(result.counts.authenticators,1);
  assert.equal(result.counts.recovery_codes,1);
  assert.equal(result.counts.webauthn_challenges,1);
  assert.equal(result.counts.login_challenges,1);
  assert.equal(result.counts.notification_outbox,1);
  assert.equal(result.counts.recovery_contacts,1);
  for(const [table,n] of Object.entries(result.counts)){
    assert.equal(await pgCount(table),n,"count mismatch: "+table);
    assert.equal(sourceCount(table),n,"source touched: "+table);
  }

  const reader=createPostgresIdentityCoreReader(pool);
  assert.equal(await reader.actorForSession({tokenHash}),null,"MFA session is not verified");
  await pool.query("UPDATE sessions SET mfa_verified=TRUE WHERE token_hash=$1",[tokenHash]);
  assert.equal((await reader.actorForSession({tokenHash})).id,ownerId);

  // Confirm tenant relationship is the copied *user's* organization.
  assert.deepEqual((await pool.query(
    "SELECT credential_id,organization_id FROM passkeys ORDER BY credential_id"
  )).rows,[
    {credential_id:passkey2,organization_id:"org-auth-other"},
    {credential_id:passkey1,organization_id:"org-demo"},
  ]);
  await assert.rejects(pool.query(
    "INSERT INTO recovery_codes(user_id,organization_id,code_hash) VALUES($1,$2,$3)",
    [ownerId,"org-auth-other",hash("cross-tenant")],
  ),error=>error.code==="23503");

  // Reading safe metadata through a read-only role is scoped by tenant;
  // raw credentials, verification links, MFA secrets and delivery addresses
  // are not accessible through that role (even for own tenant).
  const metadata=async(tenant,table)=>actorFor(tenant,async(client)=>{
    const rows=await client.query("SELECT user_id FROM "+table+" ORDER BY user_id");
    return rows.rows.map(r=>r.user_id);
  });
  assert.deepEqual(await metadata("org-demo","passkeys"),[ownerId]);
  assert.deepEqual(await metadata("org-auth-other","passkeys"),[userOther]);
  assert.deepEqual(await metadata(null,"passkeys"),[]);
  assert.deepEqual(await metadata("org-auth-other","notification_outbox"),[]);
  assert.deepEqual(await metadata("org-demo","notification_outbox"),[ownerId]);
  assert.deepEqual(await metadata("org-demo","recovery_contacts"),[ownerId]);
  for(const q of [
    "SELECT public_key FROM passkeys",
    "SELECT encrypted_secret FROM authenticators",
    "SELECT code_hash FROM recovery_codes",
    "SELECT challenge FROM webauthn_challenges",
    "SELECT token_hash FROM login_challenges",
    "SELECT recipient FROM notification_outbox",
    "SELECT address FROM recovery_contacts",
    "SELECT token_hash FROM bootstrap_tokens",
  ]) {
    await assert.rejects(actorFor("org-demo",client=>client.query(q)),
      error=>error.code==="42501", "unprotected read: "+q);
  }
  await assert.rejects(actorFor("org-demo",client=>client.query(
    "UPDATE recovery_contacts SET channel='phone' WHERE id='contact-auth-ci'",
  )),error=>error.code==="42501");

  await assert.rejects(run(),/nonempty_postgres_target_refused/);
  console.log(JSON.stringify({
    task:"ORB-005",kind:"synthetic-postgres-auth-state-snapshot",
    schemaMigration:"004_postgres_auth_state",
    testedWith:"hosted-postgres-16",source:"synthetic-fixture",
    atomicRollbackAfterPasskeyConstraintFailure:true,
    idempotentEmptyTargetGuard:true,
    passkeysAndTotpAndRecoveryAndOutboxCopied:true,
    counts:result.counts,
    mfaSessionDeniedUntilVerified:true,
    crossTenantCredentialFkRejected:true,
    rlsScopedAuthMetadata:true,
    deniedSensitiveReadQueries:8,
    readonlyRoleCannotMutate:true,
    runtimeAuthenticationCutover:false,
    allSqliteV7FeatureTablesMigrated:false,
    liveProviderActions:false,
  }));
} finally {
  app.close();
  await pool.end();
}
