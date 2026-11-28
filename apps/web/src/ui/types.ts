export type AccountHealth = "healthy" | "attention" | "offline";

export type NavSection =
  | "Overview"
  | "Hosting accounts"
  | "Websites"
  | "Migrations"
  | "Storage"
  | "Jobs & activity"
  | "Automation & reports"
  | "System & security";

export type HostingAccount = {
  id: string;
  label: string;
  provider: string;
  host: string;
  username: string;
  health: AccountHealth;
  siteCount: number;
  usedBytes: number;
  quotaBytes: number;
  lastSyncedAt: string | null;
  source: "mock_fixture" | "provider";
  capabilityProfile?: string;
};

export type CapabilityEntry = {
  capability: string;
  level: "supported" | "read_only" | "requires_whm" | "requires_ssh" | "requires_provider" | "not_available" | "unknown";
  note: string;
};

export type CapabilitySnapshot = {
  accountId: string;
  accountLabel: string;
  profileName: string;
  capabilities: CapabilityEntry[];
  source: string;
  fetchedAt: string | null;
  live: boolean;
};

export type Site = {
  id: string;
  accountId: string;
  accountLabel?: string;
  accountHost?: string;
  domain: string;
  kind: string;
  documentRoot: string;
  phpVersion: string;
  status: "active" | "attention";
};

export type Job = {
  id: string;
  type: string;
  accountId: string;
  accountLabel: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  completedAt: string | null;
  result: { source?: string; sites?: number } | null;
  error: string | null;
};

export type Overview = {
  accounts: HostingAccount[];
  jobs: Job[];
  counts: { accounts: number; sites: number; healthy: number; attention: number };
  storage: { usedBytes: number; quotaBytes: number };
  source: "mock_fixture";
  liveConnections: 0;
};

export type MigrationPlan = {
  id: string;
  siteId: string;
  siteDomain: string;
  sourceAccountId: string;
  sourceAccountLabel: string;
  targetAccountId: string;
  targetAccountLabel: string;
  strategy: "wordpress_optimized" | "generic_php" | "whm_account_package";
  state: string;
  checkpointPercent?: number;
  failedAtStage?: string | null;
  preflight: {
    sameAccount: boolean;
    estimatedSiteBytes: number;
    targetFreeBytes: number;
    quotaFit: boolean;
    phpVersion: string;
    dnsSeparateWorkstream: boolean;
    whmRequired: boolean;
    whmPermitted: boolean;
    dryRunOnly: boolean;
  };
  checksumSha256: string | null;
  rollbackNote: string | null;
  blockerReason: string | null;
  createdAt: string;
  updatedAt: string;
  mode: string;
};

export type StoragePolicy = {
  id: string;
  accountId: string;
  accountLabel: string;
  mode: "media_offload" | "backup_archival" | "static_assets";
  targetEndpoint: string;
  targetBucket: string;
  thresholdPercent: number;
  estimatedReclaimBytes: number | null;
  drillEligible: boolean;
  status: string;
  lastDrillStatus?: string | null;
  lastDrillAt?: string | null;
  createdAt: string;
};

export type StorageSummary = {
  accounts: Array<HostingAccount & { utilizationPercent: number; estimatedOffloadableBytes: number | null }>;
  policies: StoragePolicy[];
  sharedDiskPoolingSupported: boolean;
  note: string;
};

export type AuditEvent = {
  id: string;
  actor: string;
  action: string;
  targetId: string;
  outcome: string;
  createdAt: string;
  details: Record<string, unknown>;
  prevHash?: string | null;
  entryHash?: string | null;
};

export type AuditVerification = {
  valid: boolean;
  checkedCount: number;
  legacyUnchainedCount: number;
  headHash: string;
  brokenAtId: string | null;
  reason: string | null;
  checkedAt?: string;
};

export type RecoveryContact = {
  id: string;
  channel: string;
  address: string;
  verifiedAt: string | null;
  verificationExpiresAt: string | null;
  createdAt: string;
};

export type OutboxItem = {
  id: string;
  event: string;
  recipient: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
};

export type PreflightReport = {
  ready: boolean;
  checkedAt: string;
  schemaVersion: number;
  mode: string;
  liveConnections: number;
  checks: Array<{ id: string; label: string; status: "pass" | "warn" | "fail" | "info"; detail: string }>;
};

export type TeamMember = {
  id: string;
  email: string;
  role: "owner" | "admin" | "operator" | "viewer";
  disabled: number;
  mfaEnabled: number;
  createdAt: string;
};

export type SiteSnapshot = {
  id: string;
  action: string;
  status: string;
  checksumSha256: string;
  details: Record<string, unknown>;
  createdAt: string;
};

export type SiteInspection = {
  site: Site;
  account: { id: string; label: string; host: string; capabilityProfile: string; source: string };
  sslStatus: { state: string; issuer: string; validUntil: string; note: string };
  dnsAlignment: { registrarManagedExternally: boolean; recordStatus: string; note: string };
  wordpress: {
    detected: boolean;
    simulatedCoreVersion: string | null;
    activePluginsCount: number;
    pendingUpdates: number;
    stagingUrl?: string | null;
    stagingCreatedAt?: string | null;
    lastRestorePointSha256?: string | null;
    lastAction?: string | null;
    canRollback?: boolean;
    adminCredentialAssumption: string;
    note: string;
  };
  phpGuidance: { current: string; recommended: string; status: string };
  capabilityBoundary: { canPackageFullAccount: boolean; canArchiveSite: boolean; canEditDnsZones: boolean };
  operations: Array<{ id: string; label: string; permitted: boolean; level: string; reason: string }>;
  snapshots: SiteSnapshot[];
  live: boolean;
  source: string;
};

export type BackupSummary = {
  fileName: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
};

export type RestoreDrillResult = {
  passed: boolean;
  reason?: string;
  sha256: string;
  sizeBytes: number;
  schemaVersion: number;
  usersCount: number;
  accountsCount: number;
  sitesCount: number;
  mfaAuthenticatorsChecked: number;
  mfaSecretsVerified: number;
  mfaSecretsFailed: number;
  checkedAt: string;
};

export type AdvisoryInsight = {
  id: string;
  severity: "high" | "medium" | "low" | "info";
  category: string;
  title: string;
  detail: string;
  evidenceKind: string;
  observedAt: string;
  recommendedAction: NavSection;
};

export type AutomationRule = {
  id: string;
  name: string;
  ruleType: "inventory_stale_refresh" | "quota_threshold_alert" | "backup_snapshot_schedule";
  approvalMode: "manual_approval" | "dry_run_bounded";
  dailyRunCap: number;
  enabled: number;
  lastRunAt: string | null;
  createdAt: string;
};

export type AutomationRun = {
  id: string;
  ruleId: string;
  ruleName: string;
  status: string;
  summary: Record<string, unknown>;
  createdAt: string;
};

export type AgencyReport = {
  reportVersion: number;
  generatedAt: string;
  organization: { id: string; name: string };
  measurementBoundary: { liveProviderConnections: number; source: string; hostingScope: "synthetic_accounts_only"; localSystemScope: "organization"; sharedDiskPoolingSupported: boolean; externalSmtpConfigured: boolean };
  excludedProviderInventory: { accountsCount: number; sitesTotal: number; reason: string };
  portfolio: { accountsCount: number; sitesTotal: number; sitesActive: number; sitesAttention: number; usedBytes: number; quotaBytes: number; utilizationPercent: number | null };
  readiness: {
    verifiedSiteSnapshots: number;
    completedSystemBackups: number;
    completedRestoreDrills: number;
    storageOffloadPolicies: number;
    estimatedOffloadReclaimBytes: number;
    migrationCountsByState: Record<string, number>;
    activeTeamByRole: Record<string, number>;
  };
};

export type DeploymentGate = {
  id: string;
  service: string;
  status: "configured" | "missing" | "local_only";
  envVar: string;
  detail: string;
};

export type DeploymentReadinessReport = {
  checkedAt: string;
  profile: "production_ready" | "local_sqlite_prototype";
  productionReady: boolean;
  missingRequiredServices: string[];
  gates: DeploymentGate[];
};

export type SecretReference = {
  id: string;
  label: string;
  kind: "cpanel_uapi_token" | "s3_access_key" | "smtp_credential";
  referenceUri: string;
  maskedPreview: string;
  keyId: string;
  status: "active" | "revoked";
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
};

