export type AccountHealth = "healthy" | "attention" | "offline";

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
};

export type Site = {
  id: string;
  accountId: string;
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
