import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decryptMfaSecretWithFallback } from "./mfa.mjs";
import { redactSecrets, resolveContainedPath } from "./security.mjs";

export function runPreflight({ db, dbPath, mfaKeyring, webauthnRPID, webauthnOrigin }) {
  const checks = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    id: "runtime.node",
    label: "Node.js runtime",
    status: nodeMajor >= 22 ? "pass" : "fail",
    detail: `${process.version} (requires >=22.0.0)`,
  });

  let sqliteOk = false;
  let schemaVersion = 0;
  try {
    db.prepare("SELECT 1").get();
    sqliteOk = true;
    const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
    schemaVersion = row?.version ?? 0;
  } catch {
    sqliteOk = false;
  }
  checks.push({
    id: "storage.sqlite",
    label: "Local SQLite database & schema",
    status: sqliteOk ? "pass" : "fail",
    detail: sqliteOk ? `Connected (${dbPath === ":memory:" ? "in-memory" : "file"}), migration v${schemaVersion}` : "SQLite query failed",
  });

  let dataDirWritable = dbPath === ":memory:";
  if (!dataDirWritable) {
    try {
      accessSync(dirname(dbPath), constants.W_OK);
      dataDirWritable = true;
    } catch {
      dataDirWritable = false;
    }
  }
  checks.push({
    id: "storage.datadir",
    label: "Data directory permissions",
    status: dataDirWritable ? "pass" : "fail",
    detail: dbPath === ":memory:" ? "In-memory test mode" : dataDirWritable ? "Writable local .data directory" : "Data directory is not writable",
  });

  checks.push({
    id: "security.mfa_keyring",
    label: "External MFA encryption key",
    status: mfaKeyring ? "pass" : "warn",
    detail: mfaKeyring ? `Configured (active key ID: ${mfaKeyring.primaryId}, keyring size: ${mfaKeyring.keys.size})` : "Unset (TOTP enrollment disabled; passkeys still available)",
  });

  checks.push({
    id: "security.webauthn",
    label: "WebAuthn relying party binding",
    status: webauthnRPID && webauthnOrigin ? "pass" : "warn",
    detail: `RP ID: ${webauthnRPID} · Origin configured`,
  });

  checks.push({
    id: "integrations.live_providers",
    label: "Live hosting provider connections",
    status: "info",
    detail: "0 live connections (synthetic fixture & dry-run mode active)",
  });

  return {
    ready: checks.every((check) => check.status !== "fail"),
    checkedAt: new Date().toISOString(),
    schemaVersion,
    mode: "local_sqlite_prototype",
    liveConnections: 0,
    checks,
  };
}

export function createDatabaseBackup(db, { dbPath, destinationPath }) {
  if (dbPath === ":memory:") {
    throw Object.assign(new Error("Cannot snapshot in-memory database to file."), { status: 400 });
  }
  const resolvedDest = resolve(destinationPath);
  if (existsSync(resolvedDest)) {
    throw Object.assign(new Error("Backup destination already exists."), { status: 409 });
  }
  const escaped = resolvedDest.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  const bytes = readFileSync(resolvedDest);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    path: resolvedDest,
    sizeBytes: statSync(resolvedDest).size,
    sha256,
    createdAt: new Date().toISOString(),
  };
}

export function verifyBackupFile(backupPath, expectedSha256 = null) {
  const bytes = readFileSync(backupPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (expectedSha256 && sha256 !== expectedSha256) {
    return { valid: false, reason: "checksum_mismatch", sha256 };
  }
  let testDb;
  try {
    testDb = new DatabaseSync(backupPath, { readOnly: true });
    const integrity = testDb.prepare("PRAGMA integrity_check").get();
    const usersCount = testDb.prepare("SELECT COUNT(*) AS count FROM users").get().count;
    const accountsCount = testDb.prepare("SELECT COUNT(*) AS count FROM accounts").get().count;
    return {
      valid: integrity.integrity_check === "ok",
      sha256,
      sizeBytes: bytes.byteLength,
      usersCount,
      accountsCount,
    };
  } catch {
    return {
      valid: false,
      reason: "corrupt_sqlite_database",
      sha256,
      sizeBytes: bytes.byteLength,
    };
  } finally {
    testDb?.close();
  }
}

export function listBackups(backupsDir) {
  if (!existsSync(backupsDir)) return [];
  return readdirSync(backupsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sqlite"))
    .map((entry) => {
      const fullPath = resolveContainedPath(backupsDir, entry.name);
      const stat = statSync(fullPath);
      const bytes = readFileSync(fullPath);
      return {
        fileName: entry.name,
        sizeBytes: stat.size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        createdAt: stat.birthtime ? stat.birthtime.toISOString() : stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function runRestoreDrill(backupPath, { mfaKeyring = null } = {}) {
  const verification = verifyBackupFile(backupPath);
  if (!verification.valid) {
    return { passed: false, reason: verification.reason ?? "integrity_check_failed", ...verification };
  }
  const drillDb = new DatabaseSync(backupPath, { readOnly: true });
  try {
    const sitesCount = drillDb.prepare("SELECT COUNT(*) AS count FROM sites").get().count;
    const migrations = drillDb.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all();
    const authRows = drillDb.prepare("SELECT user_id, encrypted_secret, enabled FROM authenticators WHERE enabled = 1").all();
    let mfaSecretsVerified = 0;
    let mfaSecretsFailed = 0;
    for (const row of authRows) {
      if (!mfaKeyring) {
        mfaSecretsFailed += 1;
        continue;
      }
      try {
        const plain = decryptMfaSecretWithFallback(row.encrypted_secret, mfaKeyring);
        if (plain && plain.length >= 16) mfaSecretsVerified += 1;
        else mfaSecretsFailed += 1;
      } catch {
        mfaSecretsFailed += 1;
      }
    }
    return {
      passed: mfaSecretsFailed === 0,
      sha256: verification.sha256,
      sizeBytes: verification.sizeBytes,
      schemaVersion: migrations.at(-1)?.version ?? 0,
      usersCount: verification.usersCount,
      accountsCount: verification.accountsCount,
      sitesCount,
      mfaAuthenticatorsChecked: authRows.length,
      mfaSecretsVerified,
      mfaSecretsFailed,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    drillDb.close();
  }
}

export function buildDiagnosticBundle({ db, dbPath, mfaKeyring, webauthnRPID, webauthnOrigin, packageJson }) {
  const preflight = runPreflight({ db, dbPath, mfaKeyring, webauthnRPID, webauthnOrigin });
  const migrations = db.prepare("SELECT version, name, applied_at AS appliedAt FROM schema_migrations ORDER BY version").all();
  const counts = {
    accounts: db.prepare("SELECT COUNT(*) AS count FROM accounts").get().count,
    sites: db.prepare("SELECT COUNT(*) AS count FROM sites").get().count,
    jobs: db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count,
    migrationsPlanned: db.prepare("SELECT COUNT(*) AS count FROM migration_plans").get().count,
    storagePolicies: db.prepare("SELECT COUNT(*) AS count FROM storage_policies").get().count,
  };
  return redactSecrets({
    bundleVersion: 1,
    generatedAt: new Date().toISOString(),
    application: {
      name: packageJson?.name ?? "vsn-orbicore",
      version: packageJson?.version ?? "0.1.0",
      license: packageJson?.license ?? "UNLICENSED",
      dependencies: packageJson?.dependencies ?? {},
      devDependencies: packageJson?.devDependencies ?? {},
    },
    preflight,
    migrations,
    workspaceSummary: counts,
    redactionApplied: true,
    secretsIncluded: false,
  });
}

export function buildDeploymentReadiness({ mfaKeyring, webauthnOrigin, webauthnRPID }) {
  const hasPostgres = Boolean(process.env.ORBICORE_DATABASE_URL || process.env.DATABASE_URL);
  const hasRedis = Boolean(process.env.REDIS_URL || process.env.ORBICORE_REDIS_URL);
  const secureCookie = process.env.ORBICORE_COOKIE_SECURE === "1";
  const httpsOrigin = typeof webauthnOrigin === "string" && webauthnOrigin.startsWith("https://");
  const hasExternalSmtp = Boolean(process.env.ORBICORE_SMTP_URL || process.env.SMTP_URL);

  const gates = [
    {
      id: "db.postgres",
      service: "PostgreSQL 16+ Primary Database",
      status: hasPostgres ? "configured" : "missing",
      envVar: "ORBICORE_DATABASE_URL",
      detail: hasPostgres
        ? "PostgreSQL connection string configured (awaiting runtime migration probe)."
        : "Not configured — running local single-node SQLite prototype only.",
    },
    {
      id: "queue.redis",
      service: "Redis 7+ Worker Queue",
      status: hasRedis ? "configured" : "missing",
      envVar: "REDIS_URL",
      detail: hasRedis
        ? "Redis queue URL configured."
        : "Not configured — using in-process SQLite interval worker.",
    },
    {
      id: "crypto.mfa_kms",
      service: "External Secret / MFA Key Ring (32-byte AES-GCM)",
      status: mfaKeyring ? "configured" : "missing",
      envVar: "ORBICORE_MFA_ENCRYPTION_KEY",
      detail: mfaKeyring
        ? `Active key ID "${mfaKeyring.primaryId}" loaded in memory.`
        : "Unset — encrypted secret references and TOTP enrollment fail closed.",
    },
    {
      id: "transport.tls_cookies",
      service: "HTTPS Origin & Secure Cookie Policy",
      status: secureCookie && httpsOrigin ? "configured" : "local_only",
      envVar: "ORBICORE_COOKIE_SECURE=1 & ORBICORE_WEBAUTHN_ORIGIN",
      detail: secureCookie && httpsOrigin
        ? `TLS WebAuthn origin (${webauthnOrigin}, RP ${webauthnRPID}) and Secure cookies enabled.`
        : `Loopback/dev HTTP origin (${webauthnOrigin}) active; enable HTTPS reverse proxy and ORBICORE_COOKIE_SECURE=1 for production.`,
    },
    {
      id: "notify.smtp",
      service: "External Notification / SMTP Transport",
      status: hasExternalSmtp ? "configured" : "missing",
      envVar: "ORBICORE_SMTP_URL",
      detail: hasExternalSmtp
        ? "SMTP transport configured."
        : "Unset — recovery emails use simulated local outbox only.",
    },
  ];

  const missingCount = gates.filter((g) => g.status === "missing").length;
  return {
    checkedAt: new Date().toISOString(),
    profile: missingCount === 0 && secureCookie && httpsOrigin ? "production_ready" : "local_sqlite_prototype",
    productionReady: missingCount === 0 && secureCookie && httpsOrigin,
    missingRequiredServices: gates.filter((g) => g.status !== "configured").map((g) => g.service),
    gates,
  };
}

