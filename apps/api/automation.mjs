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
    FROM accounts WHERE organization_id = ?`).all(organizationId);
  const sites = db.prepare(`SELECT s.id, s.domain, s.kind, s.php_version, s.status, a.label AS account_label
    FROM sites s JOIN accounts a ON a.id = s.account_id WHERE a.organization_id = ?`).all(organizationId);
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
        evidenceKind: "measured",
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
        evidenceKind: "measured",
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
      evidenceKind: "measured",
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
    insights,
  };
}

export function executePolicyRuleDryRun(db, { organizationId, actorId, rule }) {
  const now = new Date();
  const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const runsToday = db.prepare(`SELECT COUNT(*) AS count FROM automation_runs
    WHERE rule_id = ? AND organization_id = ? AND created_at >= ?`).get(rule.id, organizationId, dayStart).count;

  if (runsToday >= rule.daily_run_cap) {
    return {
      executed: false,
      status: "budget_capped",
      reason: `Daily execution cap (${rule.daily_run_cap}) reached for this rule.`,
    };
  }

  if (rule.approval_mode === "manual_approval" && rule.enabled === 0) {
    return {
      executed: false,
      status: "disabled_by_policy",
      reason: "Rule is currently paused.",
    };
  }

  const runId = randomUUID();
  const createdAt = now.toISOString();
  let summary = {};

  if (rule.rule_type === "inventory_stale_refresh") {
    const accounts = db.prepare("SELECT id, label, last_synced_at FROM accounts WHERE organization_id = ?").all(organizationId);
    summary = { dryRun: true, evaluatedAccounts: accounts.length, candidateRefreshIds: accounts.map((a) => a.id) };
  } else if (rule.rule_type === "quota_threshold_alert") {
    const highUsage = db.prepare(`SELECT id, label, used_bytes, quota_bytes FROM accounts
      WHERE organization_id = ? AND quota_bytes > 0 AND (used_bytes * 100 / quota_bytes) >= 80`).all(organizationId);
    summary = { dryRun: true, accountsOverThreshold: highUsage.map((a) => a.label), thresholdPercent: 80 };
  } else {
    const snapshots = db.prepare("SELECT COUNT(*) AS count FROM site_snapshots WHERE organization_id = ?").get(organizationId).count;
    summary = { dryRun: true, recordedSiteSnapshots: snapshots, action: "verify_backup_schedule_posture" };
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO automation_runs (id, organization_id, rule_id, actor_id, status, summary_json, created_at)
      VALUES (?, ?, ?, ?, 'completed', ?, ?)`)
      .run(runId, organizationId, rule.id, actorId, JSON.stringify(redactSecrets(summary)), createdAt);
    db.prepare("UPDATE automation_rules SET last_run_at = ? WHERE id = ? AND organization_id = ?").run(createdAt, rule.id, organizationId);
    appendAuditEvent(db, {
      organizationId,
      actor: actorId,
      action: "automation.rule.dry_run",
      targetId: rule.id,
      outcome: "completed",
      createdAt,
      details: { runId, ruleType: rule.rule_type, dryRun: true },
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { executed: true, runId, status: "completed", summary, createdAt };
}

export function buildAgencyReadinessReport(db, organizationId) {
  const org = db.prepare("SELECT id, name, created_at AS createdAt FROM organizations WHERE id = ?").get(organizationId);
  const accounts = db.prepare("SELECT id, label, host, health, used_bytes AS usedBytes, quota_bytes AS quotaBytes, source, capability_profile AS capabilityProfile FROM accounts WHERE organization_id = ? ORDER BY label").all(organizationId);
  const siteStats = db.prepare(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN s.status = 'active' THEN 1 ELSE 0 END) AS activeCount,
    SUM(CASE WHEN s.status = 'attention' THEN 1 ELSE 0 END) AS attentionCount
    FROM sites s JOIN accounts a ON a.id = s.account_id WHERE a.organization_id = ?`).get(organizationId);
  const migrations = db.prepare("SELECT state, COUNT(*) AS count FROM migration_plans WHERE organization_id = ? GROUP BY state").all(organizationId);
  const policies = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(estimated_reclaim_bytes), 0) AS reclaimBytes FROM storage_policies WHERE organization_id = ?").get(organizationId);
  const snapshots = db.prepare("SELECT COUNT(*) AS count FROM site_snapshots WHERE organization_id = ?").get(organizationId).count;
  const backups = db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE organization_id = ? AND action = 'system.backup' AND outcome = 'completed'").get(organizationId).count;
  const restoreDrills = db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE organization_id = ? AND action = 'system.restore_drill' AND outcome = 'completed'").get(organizationId).count;
  const teamMembers = db.prepare("SELECT role, COUNT(*) AS count FROM users WHERE organization_id = ? AND disabled = 0 GROUP BY role").all(organizationId);

  const totalUsedBytes = accounts.reduce((sum, acc) => sum + acc.usedBytes, 0);
  const totalQuotaBytes = accounts.reduce((sum, acc) => sum + acc.quotaBytes, 0);

  return {
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    organization: org ?? { id: organizationId, name: "Workspace" },
    measurementBoundary: {
      liveProviderConnections: 0,
      source: "mock_fixture",
      sharedDiskPoolingSupported: false,
      externalSmtpConfigured: false,
    },
    portfolio: {
      accountsCount: accounts.length,
      sitesTotal: siteStats.total ?? 0,
      sitesActive: siteStats.activeCount ?? 0,
      sitesAttention: siteStats.attentionCount ?? 0,
      usedBytes: totalUsedBytes,
      quotaBytes: totalQuotaBytes,
      utilizationPercent: totalQuotaBytes ? Math.round((totalUsedBytes / totalQuotaBytes) * 100) : 0,
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
