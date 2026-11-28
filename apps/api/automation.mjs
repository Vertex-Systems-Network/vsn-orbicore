import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "./audit.mjs";
import { redactSecrets } from "./security.mjs";

export const RULE_TYPES = [
  "inventory_stale_refresh",
  "quota_threshold_alert",
  "backup_snapshot_schedule",
];

export const APPROVAL_MODES = [
  "manual_approval",
  "dry_run_bounded",
];

export function generateAdvisoryInsights(db, organizationId, { now = new Date() } = {}) {
  const insights = [];
  const accounts = db.prepare(`SELECT id, label, host, health, used_bytes, quota_bytes, last_synced_at, capability_profile
    FROM accounts WHERE organization_id = ? AND source = 'mock_fixture'`).all(organizationId);
  const sites = db.prepare(`SELECT s.id, s.domain, s.kind, s.php_version, s.status, a.label AS account_label
    FROM sites s JOIN accounts a ON a.id = s.account_id WHERE a.organization_id = ? AND a.source = 'mock_fixture'`).all(organizationId);
  const excludedProviderAccounts = db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE organization_id = ? AND source <> 'mock_fixture'").get(organizationId).count;
  if (excludedProviderAccounts > 0) {
    insights.push({
      id: "insight-provider-unverified", severity: "info", category: "capability_boundary",
      title: "Provider accounts excluded from synthetic advisor",
      detail: `${excludedProviderAccounts} account(s) lack authorized live provider evidence. No synthetic health or capability conclusion is available for them.`,
      evidenceKind: "unknown", observedAt: now.toISOString(), recommendedAction: "Hosting accounts",
    });
  }
  const verifiedContacts = db.prepare(`SELECT COUNT(*) AS count FROM recovery_contacts rc
    JOIN users u ON u.id = rc.user_id WHERE u.organization_id = ? AND rc.verified_at IS NOT NULL`).get(organizationId).count;
  const completedBackups = db.prepare(`SELECT COUNT(*) AS count FROM audit_events
    WHERE organization_id = ? AND action = 'system.backup' AND outcome = 'completed'`).get(organizationId).count;

  const staleThresholdMs = 24 * 60 * 60 * 1000;
  for (const acc of accounts) {
    const pct = acc.quota_bytes ? Math.round((acc.used_bytes / acc.quota_bytes) * 100) : 0;
    if (pct >= 80) {
      insights.push({
        id: `insight-quota-${acc.id}`,
        severity: pct >= 90 ? "high" : "medium",
        category: "storage_capacity",
        title: `${acc.label} storage at ${pct}% quota`,
        detail: `Account uses ${pct}% of allocated disk. Evaluate S3 archival or media offload dry-run policy.`,
        evidenceKind: "configured",
        observedAt: acc.last_synced_at ?? now.toISOString(),
        recommendedAction: "Storage",
      });
    }
    const syncedAtMs = acc.last_synced_at ? Date.parse(acc.last_synced_at) : 0;
    if (!syncedAtMs || now.getTime() - syncedAtMs > staleThresholdMs) {
      insights.push({
        id: `insight-stale-${acc.id}`,
        severity: "low",
        category: "inventory_freshness",
        title: `${acc.label} snapshot is over 24h old`,
        detail: `Last fixture sync was recorded at ${acc.last_synced_at ?? "never"}. Queue a read-only refresh.`,
        evidenceKind: "configured",
        observedAt: acc.last_synced_at ?? now.toISOString(),
        recommendedAction: "Overview",
      });
    }
    if (acc.capability_profile === "cpanel_uapi_restricted") {
      insights.push({
        id: `insight-cap-${acc.id}`,
        severity: "info",
        category: "capability_boundary",
        title: `${acc.label} has restricted archive & DNS scope`,
        detail: "Host plan disables user archives and externalizes DNS. Keep migrations within UAPI limits.",
        evidenceKind: "configured",
        observedAt: now.toISOString(),
        recommendedAction: "Hosting accounts",
      });
    }
  }

  const php81Sites = sites.filter((s) => s.php_version === "8.1");
  if (php81Sites.length > 0) {
    insights.push({
      id: "insight-php-81",
      severity: "medium",
      category: "runtime_lifecycle",
      title: `${php81Sites.length} site(s) still target PHP 8.1`,
      detail: `Review compatibility for ${php81Sites.map((s) => s.domain).join(", ")} prior to migration or runtime upgrades.`,
      evidenceKind: "configured",
      observedAt: now.toISOString(),
      recommendedAction: "Websites",
    });
  }

  if (verifiedContacts === 0) {
    insights.push({
      id: "insight-recovery-unverified",
      severity: "high",
      category: "identity_recovery",
      title: "No verified recovery contact configured",
      detail: "Recovery code alerts remain blocked from delivery until at least one contact completes verification.",
      evidenceKind: "measured",
      observedAt: now.toISOString(),
      recommendedAction: "System & security",
    });
  }

  if (completedBackups === 0) {
    insights.push({
      id: "insight-backup-none",
      severity: "medium",
      category: "disaster_recovery",
      title: "No verified SQLite backup recorded yet",
      detail: "Run a database snapshot and restore drill in System & security to establish recovery evidence.",
      evidenceKind: "measured",
      observedAt: now.toISOString(),
      recommendedAction: "System & security",
    });
  }

  return {
    generatedAt: now.toISOString(),
    readOnly: true,
    liveProviderConnections: 0,
    excludedProviderAccounts,
    insights,
  };
}

export function executePolicyRuleDryRun(db, { organizationId, actorId, rule }) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db.prepare("SELECT * FROM automation_rules WHERE id = ? AND organization_id = ?").get(rule.id, organizationId);
    const deny = (status, reason) => {
      db.exec("ROLLBACK");
      return { executed: false, status, reason };
    };
    if (!current || current.enabled !== 1 || !RULE_TYPES.includes(current.rule_type) || !APPROVAL_MODES.includes(current.approval_mode)) {
      return deny("disabled_by_policy", "Rule is paused or unavailable.");
    }
    const now = new Date();
    const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
    const runsToday = db.prepare(`SELECT COUNT(*) AS count FROM automation_runs
      WHERE rule_id = ? AND organization_id = ? AND created_at >= ?`).get(current.id, organizationId, dayStart).count;
    if (runsToday >= current.daily_run_cap) {
      return deny("budget_capped", `Daily execution cap (${current.daily_run_cap}) reached for this rule.`);
    }
    const excludedProviderAccounts = db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE organization_id = ? AND source <> 'mock_fixture'").get(organizationId).count;
    const accounts = db.prepare("SELECT id, label, used_bytes, quota_bytes, last_synced_at FROM accounts WHERE organization_id = ? AND source = 'mock_fixture' ORDER BY id").all(organizationId);
    if (accounts.length === 0) return deny("no_synthetic_accounts", "No synthetic accounts are available. Provider automation is not enabled.");
    const runId = randomUUID();
    const createdAt = now.toISOString();
    let summary = { dryRun: true, source: "mock_fixture", excludedProviderAccounts };
    if (current.rule_type === "inventory_stale_refresh") {
      const staleThresholdMs = 24 * 60 * 60 * 1000;
      summary = { ...summary, evaluatedAccounts: accounts.length, candidateRefreshIds: accounts.filter((account) => {
        const lastSync = account.last_synced_at ? Date.parse(account.last_synced_at) : NaN;
        return !Number.isFinite(lastSync) || now.getTime() - lastSync > staleThresholdMs;
      }).map((account) => account.id) };
    } else if (current.rule_type === "quota_threshold_alert") {
      const highUsage = accounts.filter((account) => account.quota_bytes > 0 && (account.used_bytes * 100 / account.quota_bytes) >= 80);
      summary = { ...summary, accountsOverThreshold: highUsage.map((account) => account.label), thresholdPercent: 80 };
    } else {
      const snapshots = db.prepare(`SELECT COUNT(*) AS count FROM site_snapshots ss
        JOIN sites s ON s.id = ss.site_id JOIN accounts a ON a.id = s.account_id AND a.organization_id = ss.organization_id
        WHERE ss.organization_id = ? AND a.source = 'mock_fixture'`).get(organizationId).count;
      summary = { ...summary, recordedSiteSnapshots: snapshots, action: "verify_backup_schedule_posture" };
    }
    db.prepare(`INSERT INTO automation_runs (id, organization_id, rule_id, actor_id, status, summary_json, created_at)
      VALUES (?, ?, ?, ?, 'completed', ?, ?)`)
      .run(runId, organizationId, current.id, actorId, JSON.stringify(redactSecrets(summary)), createdAt);
    db.prepare("UPDATE automation_rules SET last_run_at = ? WHERE id = ? AND organization_id = ?").run(createdAt, current.id, organizationId);
    appendAuditEvent(db, {
      organizationId, actor: actorId, action: "automation.rule.dry_run", targetId: current.id,
      outcome: "completed", createdAt, details: { runId, ruleType: current.rule_type, dryRun: true },
    });
    db.exec("COMMIT");
    return { executed: true, runId, status: "completed", summary, createdAt };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function buildAgencyReadinessReport(db, organizationId) {
  const org = db.prepare("SELECT id, name, created_at AS createdAt FROM organizations WHERE id = ?").get(organizationId);
  const accounts = db.prepare("SELECT id, label, host, health, used_bytes AS usedBytes, quota_bytes AS quotaBytes, source, capability_profile AS capabilityProfile FROM accounts WHERE organization_id = ? AND source = 'mock_fixture' ORDER BY label").all(organizationId);
  const excludedAccounts = db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE organization_id = ? AND source <> 'mock_fixture'").get(organizationId).count;
  const excludedSites = db.prepare(`SELECT COUNT(*) AS count FROM sites s JOIN accounts a ON a.id = s.account_id
    WHERE a.organization_id = ? AND a.source <> 'mock_fixture'`).get(organizationId).count;
  const siteStats = db.prepare(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN s.status = 'active' THEN 1 ELSE 0 END) AS activeCount,
    SUM(CASE WHEN s.status = 'attention' THEN 1 ELSE 0 END) AS attentionCount
    FROM sites s JOIN accounts a ON a.id = s.account_id WHERE a.organization_id = ? AND a.source = 'mock_fixture'`).get(organizationId);
  const migrations = db.prepare(`SELECT m.state, COUNT(*) AS count FROM migration_plans m
    JOIN sites s ON s.id = m.site_id AND s.account_id = m.source_account_id
    JOIN accounts src ON src.id = m.source_account_id AND src.organization_id = m.organization_id
    JOIN accounts dst ON dst.id = m.target_account_id AND dst.organization_id = m.organization_id
    WHERE m.organization_id = ? AND src.source = 'mock_fixture' AND dst.source = 'mock_fixture'
    GROUP BY m.state`).all(organizationId);
  const policies = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(p.estimated_reclaim_bytes), 0) AS reclaimBytes
    FROM storage_policies p JOIN accounts a ON a.id = p.account_id AND a.organization_id = p.organization_id
    WHERE p.organization_id = ? AND a.source = 'mock_fixture'`).get(organizationId);
  const snapshots = db.prepare(`SELECT COUNT(*) AS count FROM site_snapshots ss
    JOIN sites s ON s.id = ss.site_id JOIN accounts a ON a.id = s.account_id AND a.organization_id = ss.organization_id
    WHERE ss.organization_id = ? AND a.source = 'mock_fixture' AND ss.status = 'completed'`).get(organizationId).count;
  const backups = db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE organization_id = ? AND action = 'system.backup' AND outcome = 'completed'").get(organizationId).count;
  const restoreDrills = db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE organization_id = ? AND action = 'system.restore_drill' AND outcome = 'completed'").get(organizationId).count;
  const teamMembers = db.prepare("SELECT role, COUNT(*) AS count FROM users WHERE organization_id = ? AND disabled = 0 GROUP BY role").all(organizationId);

  const totalUsedBytes = accounts.reduce((sum, acc) => sum + acc.usedBytes, 0);
  const totalQuotaBytes = accounts.reduce((sum, acc) => sum + acc.quotaBytes, 0);

  return {
    reportVersion: 2,
    generatedAt: new Date().toISOString(),
    organization: org ?? { id: organizationId, name: "Workspace" },
    measurementBoundary: {
      liveProviderConnections: 0,
      source: "mock_fixture",
      hostingScope: "synthetic_accounts_only",
      localSystemScope: "organization",
      sharedDiskPoolingSupported: false,
      externalSmtpConfigured: false,
    },
    excludedProviderInventory: { accountsCount: excludedAccounts, sitesTotal: excludedSites, reason: "live_provider_evidence_not_authorized" },
    portfolio: {
      accountsCount: accounts.length,
      sitesTotal: siteStats.total ?? 0,
      sitesActive: siteStats.activeCount ?? 0,
      sitesAttention: siteStats.attentionCount ?? 0,
      usedBytes: totalUsedBytes,
      quotaBytes: totalQuotaBytes,
      utilizationPercent: totalQuotaBytes > 0 ? Math.round((totalUsedBytes / totalQuotaBytes) * 100) : null,
    },
    readiness: {
      verifiedSiteSnapshots: snapshots,
      completedSystemBackups: backups,
      completedRestoreDrills: restoreDrills,
      storageOffloadPolicies: policies.count,
      estimatedOffloadReclaimBytes: policies.reclaimBytes,
      migrationCountsByState: Object.fromEntries(migrations.map((m) => [m.state, m.count])),
      activeTeamByRole: Object.fromEntries(teamMembers.map((u) => [u.role, u.count])),
    },
    accounts,
  };
}
