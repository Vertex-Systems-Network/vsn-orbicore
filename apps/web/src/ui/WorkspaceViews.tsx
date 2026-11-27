import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Icon } from "./icons";
import type {
  AdvisoryInsight,
  AgencyReport,
  AuditEvent,
  AuditVerification,
  AutomationRule,
  AutomationRun,
  BackupSummary,
  CapabilitySnapshot,
  DeploymentReadinessReport,
  HostingAccount,
  Job,
  MigrationPlan,
  NavSection,
  OutboxItem,
  PreflightReport,
  RecoveryContact,
  RestoreDrillResult,
  SecretReference,
  Site,
  SiteInspection,
  StorageSummary,
  TeamMember,
} from "./types";

const formatBytes = (bytes: number) => {
  if (!bytes) return "0 GB";
  const gb = bytes / 1024 ** 3;
  return `${gb >= 100 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
};

const formatDateTime = (value: string | null) => {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
};

const MIGRATION_STEPS = [
  "planned",
  "preflight",
  "snapshot",
  "transfer",
  "restore",
  "verify",
  "ready_for_cutover",
  "cutover",
  "monitor",
  "completed",
];

function CapabilityLevelBadge({ level }: { level: string }) {
  const cls =
    level === "supported"
      ? "cap-supported"
      : level === "read_only"
        ? "cap-readonly"
        : "cap-restricted";
  return <span className={`cap-badge ${cls}`}>{level.replaceAll("_", " ")}</span>;
}

export function AccountsView({
  accounts,
  selectedAccountId,
  onSelectAccount,
  canMutate,
  refreshBusy = false,
  isAdmin = false,
  onAccountCreated,
  onRefreshAccount,
}: {
  accounts: HostingAccount[];
  selectedAccountId: string | null;
  onSelectAccount: (id: string) => void;
  canMutate: boolean;
  refreshBusy?: boolean;
  isAdmin?: boolean;
  onAccountCreated: () => Promise<void>;
  onRefreshAccount: (accountId: string) => Promise<void>;
}) {
  const [capabilityResult, setCapabilities] = useState<CapabilitySnapshot | null>(null);
  const [capLoading, setCapLoading] = useState(false);
  const [capError, setCapError] = useState<string | null>(null);
  const [capRequestVersion, setCapRequestVersion] = useState(0);
  const [showAddForm, setShowAddForm] = useState(false);
  const [label, setLabel] = useState("");
  const [host, setHost] = useState("");
  const [username, setUsername] = useState("");
  const [quotaGb, setQuotaGb] = useState("60");
  const [profile, setProfile] = useState("cpanel_uapi_standard");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [probeHost, setProbeHost] = useState("cpanel.example.org");
  const [probeMessage, setProbeMessage] = useState<string | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  const activeAccount = accounts.find((a) => a.id === selectedAccountId) ?? accounts[0] ?? null;

  const capabilities = capabilityResult?.accountId === activeAccount?.id &&
    capabilityResult?.source === (activeAccount?.source === "mock_fixture" ? "mock_fixture" : "unverified_provider")
    ? capabilityResult : null;

  useEffect(() => {
    setCapabilities(null);
    setCapError(null);
    if (!activeAccount) { setCapLoading(false); return; }
    let cancelled = false;
    setCapLoading(true);
    const id = activeAccount.id;
    const source = activeAccount.source === "mock_fixture" ? "mock_fixture" : "unverified_provider";
    fetch(`/api/accounts/${encodeURIComponent(id)}/capabilities`)
      .then(async (res) => {
        if (!res.ok) throw new Error("Capability snapshot unavailable");
        const data = await res.json() as CapabilitySnapshot;
        if (data.accountId !== id || data.source !== source || !Array.isArray(data.capabilities)) {
          throw new Error("Capability snapshot does not match account provenance");
        }
        if (!cancelled) setCapabilities(data);
      })
      .catch(() => { if (!cancelled) setCapError(id); })
      .finally(() => { if (!cancelled) setCapLoading(false); });
    return () => { cancelled = true; };
  }, [activeAccount?.id, activeAccount?.source, capRequestVersion]);

  const submitSandbox = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      const response = await fetch("/api/accounts/sandbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label, host, username, quotaGb: Number(quotaGb), capabilityProfile: profile }),
      });
      const data = await response.json() as { account?: HostingAccount; error?: string };
      if (!response.ok || !data.account) {
        const msg = data.error === "blocked_private_or_loopback_host"
          ? "Host rejected by outbound safety policy (private, loopback, and metadata addresses are blocked)."
          : "Provide a valid label, public hostname (e.g. cpanel.example.org), and alphanumeric username.";
        throw new Error(msg);
      }
      setShowAddForm(false);
      setLabel("");
      setHost("");
      setUsername("");
      await onAccountCreated();
      onSelectAccount(data.account.id);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Could not add synthetic sandbox account.");
    } finally {
      setBusy(false);
    }
  };

  const runBoundaryProbe = async (event: FormEvent) => {
    event.preventDefault();
    setProbeError(null);
    setProbeMessage(null);
    const res = await fetch("/api/accounts/cpanel/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: probeHost }),
    });
    const data = await res.json() as { error?: string; host?: string; probe?: { reason?: string; error?: string } };
    if (!res.ok) {
      setProbeError(data.error === "blocked_private_or_loopback_host"
        ? "Blocked by outbound SSRF guard: private, loopback, and metadata addresses cannot be probed."
        : "Provide a valid public hostname to validate.");
      return;
    }
    setProbeMessage(`SSRF check passed for ${data.host}. Live boundary status: ${data.probe?.reason ?? data.probe?.error ?? "fail_closed"}.`);
  };

  return (
    <div className="workspace-stack">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <div className="panel-title-row">
              <h2>Connected hosting accounts &amp; capability profiles</h2>
              <span className="count-chip">{accounts.length}</span>
            </div>
            <p>Each account operates strictly within discovered provider capabilities. Live customer credentials remain disabled in local mode.</p>
          </div>
          {canMutate && (
            <button type="button" className="primary-button compact-btn" onClick={() => setShowAddForm((v) => !v)}>
              <Icon name="plus" /> {showAddForm ? "Close form" : "Add sandbox account"}
            </button>
          )}
        </div>

        {showAddForm && (
          <form className="inline-form" onSubmit={(e) => void submitSandbox(e)}>
            <div className="form-grid">
              <label>
                Account label
                <input required placeholder="e.g. Horizon Reseller Sandbox" value={label} onChange={(e) => setLabel(e.target.value)} />
              </label>
              <label>
                Public host (SSRF-validated)
                <input required placeholder="e.g. node04.agency-host.example" value={host} onChange={(e) => setHost(e.target.value)} />
              </label>
              <label>
                cPanel username
                <input required pattern="[a-zA-Z0-9_-]{2,32}" placeholder="e.g. horizonweb" value={username} onChange={(e) => setUsername(e.target.value)} />
              </label>
              <label>
                Quota (GB)
                <input required type="number" min={1} max={5000} value={quotaGb} onChange={(e) => setQuotaGb(e.target.value)} />
              </label>
              <label>
                Simulated capability profile
                <select value={profile} onChange={(e) => setProfile(e.target.value)}>
                  <option value="cpanel_uapi_standard">cPanel UAPI Standard</option>
                  <option value="cpanel_uapi_restricted">cPanel UAPI Restricted</option>
                  <option value="whm_reseller">WHM Reseller Scope</option>
                </select>
              </label>
            </div>
            {formError && <div className="auth-error" role="alert">{formError}</div>}
            <div className="inline-form-actions">
              <small>Creates a local synthetic sandbox account in SQLite without storing real hosting tokens.</small>
              <button className="primary-button compact-btn" disabled={busy}>{busy ? "Creating..." : "Create synthetic account"}</button>
            </div>
          </form>
        )}

        <div className="data-table">
          <div className="data-table-head accounts-cols">
            <span>ACCOUNT</span><span>HOST / USER</span><span>PROFILE</span><span>STORAGE</span><span>SITES</span><span>ACTION</span>
          </div>
          {accounts.map((account) => {
            const pct = account.quotaBytes ? Math.round((account.usedBytes / account.quotaBytes) * 100) : 0;
            return (
              <div
                key={account.id}
                className={`data-table-row accounts-cols ${activeAccount?.id === account.id ? "selected" : ""}`}
                onClick={() => onSelectAccount(account.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectAccount(account.id); } }}
              >
                <span><strong>{account.label}</strong><small className="cell-sub">{account.source === "mock_fixture" ? "Synthetic fixture" : "Provider"}</small></span>
                <span>{account.host}<small className="cell-sub">{account.username}</small></span>
                <span><span className="php-tag">{(account.capabilityProfile ?? "cpanel_uapi_standard").replaceAll("_", " ")}</span></span>
                <span>{formatBytes(account.usedBytes)} / {formatBytes(account.quotaBytes)} ({pct}%)</span>
                <span>{account.siteCount} sites</span>
                <span>
                  <button
                    type="button"
                    className="secondary-button mini-btn"
                    disabled={!canMutate || refreshBusy || account.source !== "mock_fixture"}
                    title={account.source !== "mock_fixture" ? "Provider refresh is not enabled" : !canMutate ? "Requires operator, admin, or owner role" : undefined}
                    onClick={(e) => { e.stopPropagation(); void onRefreshAccount(account.id); }}
                  >
                    Refresh
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <div className="panel-title-row">
              <h2>Capability snapshot: {activeAccount?.label ?? "None selected"}</h2>
              {capabilities && <span className="count-chip">{capabilities.profileName}</span>}
            </div>
            <p>{activeAccount?.source === "provider" ? "Provider capabilities are unverified. No authorized live capability evidence is available." : "Synthetic capability profile only; not a live permission grant."}</p>
          </div>
        </div>
        {activeAccount && capError === activeAccount.id && !capLoading ? (
          <div className="error-banner" role="alert">Capability snapshot unavailable. No permissions can be inferred. <button type="button" onClick={() => setCapRequestVersion((v) => v + 1)}>Retry capabilities</button></div>
        ) : activeAccount && (capLoading || !capabilities) ? (
          <div className="loading-state" role="status"><span className="loader" /> Loading capability snapshot...</div>
        ) : capabilities ? (
          <div className="capability-grid">
            {capabilities.capabilities.map((cap) => (
              <div className="capability-card" key={cap.capability}>
                <div className="capability-top">
                  <code>{cap.capability}</code>
                  <CapabilityLevelBadge level={cap.level} />
                </div>
                <p>{cap.note}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-inline">Select a hosting account to inspect its capability matrix.</div>
        )}
      </section>

      {isAdmin && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Live cPanel UAPI boundary pre-check</h2>
              <p>Validates outbound SSRF policy and confirms that live connections stay fail-closed until authorized tokens are provisioned.</p>
            </div>
          </div>
          <form className="inline-form" onSubmit={(e) => void runBoundaryProbe(e)}>
            <div className="form-grid">
              <label>
                Target cPanel hostname (SSRF-checked)
                <input required placeholder="cpanel.example.org" value={probeHost} onChange={(e) => setProbeHost(e.target.value)} />
              </label>
            </div>
            {probeMessage && <div className="environment-banner">{probeMessage}</div>}
            {probeError && <div className="auth-error" role="alert">{probeError}</div>}
            <div className="inline-form-actions">
              <small>No tokens are accepted or persisted in prototype mode (liveConnections stays 0).</small>
              <button className="secondary-button compact-btn">Validate boundary</button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}

export function WebsitesView({ sites, globalQuery, canMutate }: { sites: Site[]; globalQuery: string; canMutate: boolean }) {
  const [phpFilter, setPhpFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortKey, setSortKey] = useState<"domain" | "kind" | "phpVersion" | "status">("domain");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(sites[0]?.id ?? null);
  const [inspectionResult, setInspection] = useState<SiteInspection | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [inspectError, setInspectError] = useState<{ siteId: string; message: string } | null>(null);
  const inspectionRequest = useRef(0);
  const currentSite = useRef(selectedSiteId);
  currentSite.current = selectedSiteId;
  const inspection = inspectionResult?.site.id === selectedSiteId ? inspectionResult : null;
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const phpVersions = useMemo(() => Array.from(new Set(sites.map((s) => s.phpVersion))).sort(), [sites]);

  const toggleSort = (col: "domain" | "kind" | "phpVersion" | "status") => {
    if (sortKey === col) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(col);
      setSortDir("asc");
    }
  };

  const filtered = useMemo(() => {
    const q = globalQuery.trim().toLowerCase();
    const list = sites.filter((site) => {
      if (phpFilter !== "all" && site.phpVersion !== phpFilter) return false;
      if (statusFilter !== "all" && site.status !== statusFilter) return false;
      if (!q) return true;
      return `${site.domain} ${site.accountLabel ?? ""} ${site.kind} ${site.documentRoot}`.toLowerCase().includes(q);
    });
    return [...list].sort((a, b) => {
      const cmp = a[sortKey].localeCompare(b[sortKey]);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [sites, globalQuery, phpFilter, statusFilter, sortKey, sortDir]);

  useEffect(() => {
    if (!selectedSiteId && filtered[0]) setSelectedSiteId(filtered[0].id);
  }, [filtered, selectedSiteId]);

  const loadInspection = useCallback(async (siteId: string) => {
    if (currentSite.current !== siteId) return;
    const request = ++inspectionRequest.current;
    setInspection(null);
    setInspectError(null);
    setInspectLoading(true);
    const isCurrent = () => inspectionRequest.current === request && currentSite.current === siteId;
    try {
      const res = await fetch(`/api/sites/${encodeURIComponent(siteId)}/inspection`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error === "provider_site_operations_not_enabled"
          ? "Provider site inspection and dry-run operations are not enabled."
          : "Site inspection unavailable. No permissions can be inferred.");
      }
      const data = await res.json() as SiteInspection;
      if (data.site.id !== siteId || data.account.source !== "mock_fixture") {
        throw new Error("Site inspection does not match synthetic account provenance.");
      }
      if (isCurrent()) setInspection(data);
    } catch (error) {
      if (isCurrent()) setInspectError({ siteId, message: error instanceof Error ? error.message : "Site inspection unavailable." });
    } finally {
      if (isCurrent()) setInspectLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedSiteId) { setInspection(null); setInspectError(null); setInspectLoading(false); return; }
    void loadInspection(selectedSiteId);
    return () => { inspectionRequest.current += 1; };
  }, [selectedSiteId, loadInspection]);

  const triggerSiteAction = async (actionId: string) => {
    if (!selectedSiteId) return;
    setActionBusy(actionId);
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await fetch(`/api/sites/${encodeURIComponent(selectedSiteId)}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: actionId }),
      });
      const data = await res.json() as { error?: string; message?: string; checksumSha256?: string };
      if (!res.ok) {
        setActionError(data.message ?? "This operation is restricted for the current role or hosting capability profile.");
        return;
      }
      setActionMessage(`Dry-run ${actionId.replaceAll("_", " ")} verified (SHA-256: ${data.checksumSha256?.slice(0, 14)}…).`);
      await loadInspection(selectedSiteId);
    } finally {
      setActionBusy(null);
    }
  };

  const triggerWpStaging = async (action: "create" | "destroy") => {
    if (!selectedSiteId) return;
    setActionBusy(`wp_staging_${action}`);
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await fetch(`/api/sites/${encodeURIComponent(selectedSiteId)}/wordpress/staging`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json() as { stagingUrl?: string | null; error?: string };
      if (!res.ok) {
        setActionError("Could not update WordPress staging environment.");
        return;
      }
      setActionMessage(data.stagingUrl ? `Dry-run staging clone provisioned at ${data.stagingUrl} (production files untouched).` : "Dry-run staging clone removed.");
      await loadInspection(selectedSiteId);
    } finally {
      setActionBusy(null);
    }
  };

  const triggerWpUpdate = async (action: "apply_updates" | "rollback") => {
    if (!selectedSiteId) return;
    setActionBusy(`wp_${action}`);
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await fetch(`/api/sites/${encodeURIComponent(selectedSiteId)}/wordpress/update`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json() as { coreVersion?: string; restorePointSha256?: string; error?: string };
      if (!res.ok) {
        setActionError(data.error === "no_restore_point_available" ? "No prior restore point available for rollback." : "Could not run WordPress lifecycle update.");
        return;
      }
      setActionMessage(action === "rollback"
        ? `Rolled back dry-run WordPress state to version ${data.coreVersion}.`
        : `Simulated WordPress update to ${data.coreVersion} with restore point (${data.restorePointSha256?.slice(0, 14)}…).`);
      await loadInspection(selectedSiteId);
    } finally {
      setActionBusy(null);
    }
  };

  return (
    <div className="workspace-stack">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <div className="panel-title-row">
              <h2>Websites directory</h2>
              <span className="count-chip">{filtered.length}</span>
            </div>
            <p>Select any site to inspect SSL/DNS boundaries, PHP/WordPress readiness, and capability-gated dry-run snapshots.</p>
          </div>
          <div className="filter-bar">
            <select aria-label="Filter by PHP version" value={phpFilter} onChange={(e) => setPhpFilter(e.target.value)}>
              <option value="all">All PHP versions</option>
              {phpVersions.map((v) => <option key={v} value={v}>PHP {v}</option>)}
            </select>
            <select aria-label="Filter by status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">All statuses</option>
              <option value="active">Operational</option>
              <option value="attention">Needs attention</option>
            </select>
          </div>
        </div>

        {filtered.length ? (
          <div className="data-table">
            <div className="data-table-head websites-cols">
              <button type="button" className="sort-btn" aria-sort={sortKey === "domain" ? (sortDir === "asc" ? "ascending" : "descending") : "none"} onClick={() => toggleSort("domain")}>
                DOMAIN {sortKey === "domain" ? (sortDir === "asc" ? "↑" : "↓") : ""}
              </button>
              <span>HOSTING ACCOUNT</span>
              <button type="button" className="sort-btn" aria-sort={sortKey === "kind" ? (sortDir === "asc" ? "ascending" : "descending") : "none"} onClick={() => toggleSort("kind")}>
                KIND {sortKey === "kind" ? (sortDir === "asc" ? "↑" : "↓") : ""}
              </button>
              <span>DOCUMENT ROOT</span>
              <button type="button" className="sort-btn" aria-sort={sortKey === "phpVersion" ? (sortDir === "asc" ? "ascending" : "descending") : "none"} onClick={() => toggleSort("phpVersion")}>
                PHP {sortKey === "phpVersion" ? (sortDir === "asc" ? "↑" : "↓") : ""}
              </button>
              <button type="button" className="sort-btn" aria-sort={sortKey === "status" ? (sortDir === "asc" ? "ascending" : "descending") : "none"} onClick={() => toggleSort("status")}>
                STATUS {sortKey === "status" ? (sortDir === "asc" ? "↑" : "↓") : ""}
              </button>
            </div>
            {filtered.map((site) => (
              <div
                className={`data-table-row websites-cols ${selectedSiteId === site.id ? "selected" : ""}`}
                key={site.id}
                role="button"
                tabIndex={0}
                onClick={() => { setSelectedSiteId(site.id); setActionMessage(null); setActionError(null); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedSiteId(site.id); } }}
              >
                <span><strong>{site.domain}</strong></span>
                <span>{site.accountLabel ?? site.accountId}<small className="cell-sub">{site.accountHost ?? ""}</small></span>
                <span>{site.kind}</span>
                <span className="path-cell">{site.documentRoot}</span>
                <span><span className="php-tag">{site.phpVersion}</span></span>
                <span>
                  <span className={`status-badge status-${site.status === "active" ? "healthy" : "attention"}`}>
                    <span className="status-dot" />
                    {site.status === "active" ? "Operational" : "Attention"}
                  </span>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-inline">No websites match the current search or filters.</div>
        )}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <div className="panel-title-row">
              <h2>Site inspection &amp; capability gates: {inspection?.site.domain ?? "Select a site"}</h2>
              {inspection && <span className="count-chip">{inspection.account.capabilityProfile.replaceAll("_", " ")}</span>}
            </div>
            <p>Read-only diagnostics and dry-run site actions strictly scoped by the parent hosting account profile.</p>
          </div>
        </div>
        {selectedSiteId && inspectError?.siteId === selectedSiteId && !inspectLoading ? (
          <div className="error-banner" role="alert">{inspectError.message} <button type="button" onClick={() => void loadInspection(selectedSiteId)}>Retry inspection</button></div>
        ) : selectedSiteId && (inspectLoading || !inspection) ? (
          <div className="loading-state" role="status"><span className="loader" /> Inspecting website posture...</div>
        ) : inspection ? (
          <div className="inspection-body">
            <div className="capability-grid">
              <div className="capability-card">
                <div className="capability-top">
                  <strong>SSL &amp; TLS certificate</strong>
                  <span className={`cap-badge ${inspection.sslStatus.state === "valid" ? "cap-supported" : "cap-readonly"}`}>{inspection.sslStatus.state.replaceAll("_", " ")}</span>
                </div>
                <p>{inspection.sslStatus.issuer} · Valid until {formatDateTime(inspection.sslStatus.validUntil)}. {inspection.sslStatus.note}</p>
              </div>
              <div className="capability-card">
                <div className="capability-top">
                  <strong>DNS &amp; registrar scope</strong>
                  <span className={`cap-badge ${inspection.dnsAlignment.recordStatus === "aligned" ? "cap-supported" : "cap-readonly"}`}>{inspection.dnsAlignment.recordStatus.replaceAll("_", " ")}</span>
                </div>
                <p>{inspection.dnsAlignment.note}</p>
              </div>
              <div className="capability-card">
                <div className="capability-top">
                  <strong>Runtime &amp; WordPress</strong>
                  <span className={`cap-badge ${inspection.phpGuidance.status === "current" ? "cap-supported" : "cap-readonly"}`}>PHP {inspection.phpGuidance.current}</span>
                </div>
                <p>
                  {inspection.wordpress.detected
                    ? `WordPress ${inspection.wordpress.simulatedCoreVersion} (${inspection.wordpress.activePluginsCount} plugins, ${inspection.wordpress.pendingUpdates} pending updates). ${inspection.wordpress.stagingUrl ? `Staging: ${inspection.wordpress.stagingUrl}. ` : ""}${inspection.wordpress.note}`
                    : inspection.wordpress.note}
                </p>
                {inspection.wordpress.detected && canMutate && (
                  <div className="drill-actions">
                    <button
                      type="button"
                      className="secondary-button mini-btn"
                      disabled={actionBusy !== null}
                      onClick={() => void triggerWpStaging(inspection.wordpress.stagingUrl ? "destroy" : "create")}
                    >
                      {inspection.wordpress.stagingUrl ? "Remove staging clone" : "Create staging clone"}
                    </button>
                    <button
                      type="button"
                      className="secondary-button mini-btn"
                      disabled={actionBusy !== null}
                      onClick={() => void triggerWpUpdate("apply_updates")}
                    >
                      Simulate WP update
                    </button>
                    {inspection.wordpress.canRollback && (
                      <button
                        type="button"
                        className="primary-button mini-btn"
                        disabled={actionBusy !== null}
                        onClick={() => void triggerWpUpdate("rollback")}
                      >
                        Roll back WP update
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="site-actions-strip">
              {inspection.operations.map((op) => (
                <div className="site-op-card" key={op.id}>
                  <div>
                    <strong>{op.label}</strong>
                    <small className="cell-sub">{op.reason}</small>
                  </div>
                  <button
                    type="button"
                    className={op.permitted ? "primary-button mini-btn" : "secondary-button mini-btn"}
                    disabled={!canMutate || !op.permitted || actionBusy !== null}
                    title={!op.permitted ? op.reason : undefined}
                    onClick={() => void triggerSiteAction(op.id)}
                  >
                    {actionBusy === op.id ? "Running..." : op.permitted ? "Run dry-run" : "Restricted"}
                  </button>
                </div>
              ))}
            </div>

            {actionMessage && <div className="environment-banner panel-banner">{actionMessage}</div>}
            {actionError && <div className="error-banner panel-banner" role="alert">{actionError}</div>}

            {inspection.snapshots.length > 0 && (
              <div className="data-table">
                <div className="data-table-head snapshot-cols">
                  <span>ACTION</span><span>STATUS</span><span>VERIFICATION CHECKSUM</span><span>RECORDED</span>
                </div>
                {inspection.snapshots.map((snap) => (
                  <div className="data-table-row snapshot-cols" key={snap.id}>
                    <span><strong>{snap.action.replaceAll("_", " ")}</strong></span>
                    <span><span className="cap-badge cap-supported">{snap.status}</span></span>
                    <span className="path-cell">{snap.checksumSha256.slice(0, 24)}…</span>
                    <span>{formatDateTime(snap.createdAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="empty-inline">Select a website above to inspect SSL, DNS, and permitted operations.</div>
        )}
      </section>
    </div>
  );
}

export function MigrationsView({
  accounts,
  sites,
  canMutate,
}: {
  accounts: HostingAccount[];
  sites: Site[];
  canMutate: boolean;
}) {
  const [migrations, setMigrations] = useState<MigrationPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const mockAccounts = accounts.filter((account) => account.source === "mock_fixture");
  const mockIds = new Set(mockAccounts.map((account) => account.id));
  const mockSites = sites.filter((site) => mockIds.has(site.accountId));
  const [siteId, setSiteId] = useState(mockSites[0]?.id ?? "");
  const [targetAccountId, setTargetAccountId] = useState(mockAccounts[1]?.id ?? mockAccounts[0]?.id ?? "");
  const eligibleSelection = mockSites.some((site) => site.id === siteId) && mockIds.has(targetAccountId);
  const [strategy, setStrategy] = useState<"wordpress_optimized" | "generic_php" | "whm_account_package">("wordpress_optimized");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/migrations");
      if (res.ok) {
        const data = await res.json() as { migrations: MigrationPlan[] };
        setMigrations(data.migrations);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!mockSites.some((site) => site.id === siteId)) setSiteId(mockSites[0]?.id ?? "");
    if (!mockIds.has(targetAccountId)) setTargetAccountId(mockAccounts[1]?.id ?? mockAccounts[0]?.id ?? "");
  }, [sites, accounts, siteId, targetAccountId]);

  const createPlan = async (e: FormEvent) => {
    e.preventDefault();
    if (!canMutate || !eligibleSelection || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/migrations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ siteId, targetAccountId, strategy }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error === "provider_migration_not_enabled"
          ? "Provider migration is not enabled; both accounts must be synthetic."
          : "Could not create dry-run migration plan.");
      }
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to plan migration.");
    } finally {
      setBusy(false);
    }
  };

  const advance = async (
    id: string,
    { confirmCutover = false, simulatePartialFailure = false }: { confirmCutover?: boolean; simulatePartialFailure?: boolean } = {},
  ) => {
    setError(null);
    const res = await fetch(`/api/migrations/${encodeURIComponent(id)}/advance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmCutover, simulatePartialFailure }),
    });
    const data = await res.json() as { error?: string };
    if (!res.ok) {
      setError(data.error === "cutover_authorization_required"
        ? "DNS cutover requires explicit confirmation."
        : data.error === "provider_migration_not_enabled"
          ? "Provider migration is not enabled; the local plan may still be rolled back."
          : "Migration stage could not advance.");
      return;
    }
    await load();
  };

  const rollback = async (id: string) => {
    setError(null);
    const res = await fetch(`/api/migrations/${encodeURIComponent(id)}/rollback`, { method: "POST" });
    if (!res.ok) setError("Could not roll back migration plan.");
    await load();
  };

  return (
    <div className="workspace-stack">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Site migration planner (dry-run simulation)</h2>
            <p>Preflight validates destination quota, capability boundaries, and checksums. Source files remain untouched and DNS is a separate workstream.</p>
          </div>
        </div>
        <form className="inline-form" onSubmit={(e) => void createPlan(e)}>
          <div className="form-grid">
            <label>
              Source website
              <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                {mockSites.map((s) => <option key={s.id} value={s.id}>{s.domain} ({s.accountLabel ?? s.accountId})</option>)}
              </select>
            </label>
            <label>
              Destination account
              <select value={targetAccountId} onChange={(e) => setTargetAccountId(e.target.value)}>
                {mockAccounts.map((a) => <option key={a.id} value={a.id}>{a.label} ({formatBytes(Math.max(0, a.quotaBytes - a.usedBytes))} free)</option>)}
              </select>
            </label>
            <label>
              Migration strategy
              <select value={strategy} onChange={(e) => setStrategy(e.target.value as typeof strategy)}>
                <option value="wordpress_optimized">WordPress Optimized (Site-Level)</option>
                <option value="generic_php">Generic PHP Site Path</option>
                <option value="whm_account_package">WHM Account Package (Requires WHM)</option>
              </select>
            </label>
          </div>
          {error && <div className="auth-error" role="alert">{error}</div>}
          <div className="inline-form-actions">
            <small>Only synthetic accounts are eligible. No live server transfer is performed; records persist locally.</small>
            <button className="primary-button compact-btn" disabled={busy || !canMutate || !eligibleSelection}>
              {busy ? "Evaluating preflight..." : "Run dry-run preflight"}
            </button>
          </div>
        </form>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <div className="panel-title-row">
              <h2>Migration plans &amp; state machine</h2>
              <span className="count-chip">{migrations.length}</span>
            </div>
            <p>Tracks each step through verification, explicit cutover gate, monitoring, and safe rollback.</p>
          </div>
        </div>
        {loading ? (
          <div className="loading-state"><span className="loader" /> Loading migration plans...</div>
        ) : migrations.length === 0 ? (
          <div className="empty-inline">No migration plans created yet. Run a dry-run preflight above to test feasibility.</div>
        ) : (
          <div className="migration-list">
            {migrations.map((plan) => {
              const stepIdx = MIGRATION_STEPS.indexOf(plan.state);
              const needsCutoverApproval = plan.state === "ready_for_cutover";
              const isTerminal = ["completed", "rolled_back", "blocked", "failed"].includes(plan.state);
              const canResumeFromFailure = plan.state === "failed" && plan.failedAtStage === "transfer";
              const sourceEligible = mockIds.has(plan.sourceAccountId) && mockIds.has(plan.targetAccountId);
              return (
                <article className="migration-card" key={plan.id}>
                  <div className="migration-card-top">
                    <div>
                      <strong>{plan.siteDomain}</strong>
                      <small className="cell-sub">{plan.sourceAccountLabel} → {plan.targetAccountLabel} · {plan.strategy.replaceAll("_", " ")}</small>
                    </div>
                    <span className={`status-badge ${plan.state === "completed" ? "status-healthy" : "status-attention"}`}>
                      <span className="status-dot" />
                      {plan.state.replaceAll("_", " ")}
                    </span>
                  </div>
                  <div className="stepper-track" aria-label="Migration state progression">
                    {MIGRATION_STEPS.map((step, idx) => (
                      <span key={step} className={`step-pill ${idx <= stepIdx ? "done" : ""}`}>{step.replaceAll("_", " ")}</span>
                    ))}
                  </div>
                  {plan.blockerReason && <div className="auth-error">{plan.blockerReason}</div>}
                  {!sourceEligible && <div className="auth-error">Advance unavailable: both accounts must be synthetic. Local rollback remains available where permitted.</div>}
                  <div className="migration-meta">
                    <span>Est. transfer: {formatBytes(plan.preflight.estimatedSiteBytes)}</span>
                    <span>Target free: {formatBytes(plan.preflight.targetFreeBytes)}</span>
                    <span>PHP: {plan.preflight.phpVersion}</span>
                    <span>Checkpoint: {plan.checkpointPercent ?? 0}%</span>
                    {plan.checksumSha256 && <span className="path-cell">SHA-256: {plan.checksumSha256.slice(0, 16)}…</span>}
                  </div>
                  {canMutate && (
                    <div className="migration-actions">
                      {!isTerminal && (
                        <button
                          type="button"
                          className="primary-button mini-btn"
                          disabled={!sourceEligible}
                          onClick={() => void advance(plan.id, { confirmCutover: needsCutoverApproval })}
                        >
                          {needsCutoverApproval ? "Authorize dry-run cutover" : "Advance next step"}
                        </button>
                      )}
                      {plan.state === "transfer" && (
                        <button
                          type="button"
                          className="secondary-button mini-btn"
                          disabled={!sourceEligible}
                          onClick={() => void advance(plan.id, { simulatePartialFailure: true })}
                        >
                          Simulate 30% failure
                        </button>
                      )}
                      {canResumeFromFailure && (
                        <button
                          type="button"
                          className="primary-button mini-btn"
                          disabled={!sourceEligible}
                          onClick={() => void advance(plan.id)}
                        >
                          Resume from 30% checkpoint
                        </button>
                      )}
                      {plan.state !== "completed" && plan.state !== "rolled_back" && (
                        <button type="button" className="secondary-button mini-btn" onClick={() => void rollback(plan.id)}>
                          Roll back
                        </button>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

export function StorageView({ canMutate }: { canMutate: boolean }) {
  const [summary, setSummary] = useState<StorageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [accountId, setAccountId] = useState("");
  const [mode, setMode] = useState<"media_offload" | "backup_archival" | "static_assets">("backup_archival");
  const [targetEndpoint, setTargetEndpoint] = useState("https://s3.us-east-1.example.org");
  const [targetBucket, setTargetBucket] = useState("orbicore-offload-archive");
  const [thresholdPercent, setThresholdPercent] = useState("80");
  const [error, setError] = useState<string | null>(null);
  const [drillMessage, setDrillMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/storage/summary");
      if (res.ok) {
        const data = await res.json() as StorageSummary;
        setSummary(data);
        setAccountId((curr) => curr || data.accounts[0]?.id || "");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const createPolicy = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setDrillMessage(null);
    const res = await fetch("/api/storage/policies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId, mode, targetEndpoint, targetBucket, thresholdPercent: Number(thresholdPercent) }),
    });
    const data = await res.json() as { error?: string };
    if (!res.ok) {
      setError(data.error === "blocked_private_or_loopback_host" || data.error === "https_required"
        ? "Endpoint must use HTTPS and cannot target private, loopback, or metadata networks."
        : "Check bucket naming (lowercase letters, digits, hyphens) and threshold (50-99%).");
      return;
    }
    await load();
  };

  const runDrill = async (policyId: string, drillType: "dry_run_offload" | "simulate_outage" | "rehydrate_verify") => {
    setError(null);
    setDrillMessage(null);
    const res = await fetch(`/api/storage/policies/${encodeURIComponent(policyId)}/drill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ drillType }),
    });
    const data = await res.json() as { lastDrillStatus?: string; status?: string; error?: string };
    if (!res.ok) {
      setError("Could not execute storage drill.");
      return;
    }
    setDrillMessage(`Drill recorded: ${(data.lastDrillStatus ?? drillType).replaceAll("_", " ")} (policy state: ${(data.status ?? "").replaceAll("_", " ")}; source files untouched).`);
    await load();
  };

  if (loading) return <div className="panel loading-state"><span className="loader" /> Loading storage capacity...</div>;

  return (
    <div className="workspace-stack">
      <div className="environment-banner" role="status">
        <span className="banner-icon">i</span>
        <span><strong>Realistic storage separation:</strong> {summary?.note}</span>
      </div>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Per-account quota &amp; estimated offload eligibility</h2>
            <p>Estimates are dry-run projections only; local files are never moved before verification and retention gates.</p>
          </div>
        </div>
        <div className="data-table">
          <div className="data-table-head storage-cols">
            <span>ACCOUNT</span><span>USED / QUOTA</span><span>UTILIZATION</span><span>EST. OFFLOADABLE (DRY-RUN)</span>
          </div>
          {summary?.accounts.map((acc) => (
            <div className="data-table-row storage-cols" key={acc.id}>
              <span><strong>{acc.label}</strong><small className="cell-sub">{acc.host}</small></span>
              <span>{formatBytes(acc.usedBytes)} / {formatBytes(acc.quotaBytes)}</span>
              <span>{acc.utilizationPercent}%</span>
              <span>~{formatBytes(acc.estimatedOffloadableBytes)} (estimated)</span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Object-storage offload policies (dry-run)</h2>
            <p>Configure S3-compatible offload targets validated against outbound network rules.</p>
          </div>
        </div>
        <form className="inline-form" onSubmit={(e) => void createPolicy(e)}>
          <div className="form-grid">
            <label>
              Source account
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {summary?.accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </label>
            <label>
              Offload mode
              <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                <option value="backup_archival">Approved Backup Archival</option>
                <option value="media_offload">WordPress Media Offload (Agent)</option>
                <option value="static_assets">Static / Download Assets</option>
              </select>
            </label>
            <label>
              S3-compatible HTTPS endpoint
              <input required type="url" value={targetEndpoint} onChange={(e) => setTargetEndpoint(e.target.value)} />
            </label>
            <label>
              Bucket name
              <input required value={targetBucket} onChange={(e) => setTargetBucket(e.target.value)} />
            </label>
            <label>
              Trigger threshold (%)
              <input required type="number" min={50} max={99} value={thresholdPercent} onChange={(e) => setThresholdPercent(e.target.value)} />
            </label>
          </div>
          {error && <div className="auth-error" role="alert">{error}</div>}
          <div className="inline-form-actions">
            <small>Policies start in dry-run-only mode until object-store credentials are provisioned.</small>
            <button className="primary-button compact-btn" disabled={!canMutate}>Save dry-run policy</button>
          </div>
        </form>

        {drillMessage && <div className="environment-banner panel-banner">{drillMessage}</div>}
        {summary && summary.policies.length > 0 && (
          <div className="data-table">
            <div className="data-table-head policy-cols">
              <span>ACCOUNT</span><span>MODE</span><span>TARGET</span><span>EST. RECLAIM</span><span>STATE &amp; RESILIENCE DRILLS</span>
            </div>
            {summary.policies.map((p) => (
              <div className="data-table-row policy-cols" key={p.id}>
                <span><strong>{p.accountLabel}</strong></span>
                <span>{p.mode.replaceAll("_", " ")}</span>
                <span className="path-cell">{p.targetEndpoint}/{p.targetBucket}</span>
                <span>~{formatBytes(p.estimatedReclaimBytes)}</span>
                <span>
                  <span className="php-tag">{p.status.replaceAll("_", " ")}</span>
                  {p.lastDrillStatus && <small className="cell-sub">Last drill: {p.lastDrillStatus.replaceAll("_", " ")}</small>}
                  {canMutate && (
                    <div className="drill-actions">
                      <button type="button" className="secondary-button mini-btn" onClick={() => void runDrill(p.id, "dry_run_offload")}>Dry-run offload</button>
                      <button type="button" className="secondary-button mini-btn" onClick={() => void runDrill(p.id, "simulate_outage")}>Outage test</button>
                      <button type="button" className="secondary-button mini-btn" onClick={() => void runDrill(p.id, "rehydrate_verify")}>Rehydrate verify</button>
                    </div>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export function JobsAndAuditView({ jobs, isAdmin }: { jobs: Job[]; isAdmin: boolean }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loadingAudit, setLoadingAudit] = useState(isAdmin);
  const [chainStatus, setChainStatus] = useState<AuditVerification | null>(null);
  const [verifyingChain, setVerifyingChain] = useState(false);

  const loadAudit = useCallback(() => {
    if (!isAdmin) return;
    setLoadingAudit(true);
    Promise.all([
      fetch("/api/audit?limit=50").then((res) => (res.ok ? res.json() : { events: [] })),
      fetch("/api/audit/verify").then((res) => (res.ok ? res.json() : null)),
    ])
      .then(([auditData, verifyData]: [{ events?: AuditEvent[] }, AuditVerification | null]) => {
        setEvents(auditData.events ?? []);
        if (verifyData) setChainStatus(verifyData);
      })
      .finally(() => setLoadingAudit(false));
  }, [isAdmin]);

  useEffect(() => {
    loadAudit();
  }, [loadAudit, jobs.length]);

  const verifyChain = async () => {
    setVerifyingChain(true);
    try {
      const res = await fetch("/api/audit/verify");
      if (res.ok) {
        const data = (await res.json()) as AuditVerification;
        setChainStatus(data);
      }
    } finally {
      setVerifyingChain(false);
    }
  };

  const exportAuditCsv = () => {
    const escapeCell = (val: unknown) => {
      const raw = String(val ?? "");
      const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
      return `"${safe.replaceAll("\"", "\"\"")}"`;
    };
    const header = ["id", "action", "targetId", "outcome", "createdAt", "details"].join(",");
    const rows = events.map((ev) => [
      escapeCell(ev.id),
      escapeCell(ev.action),
      escapeCell(ev.targetId),
      escapeCell(ev.outcome),
      escapeCell(ev.createdAt),
      escapeCell(JSON.stringify(ev.details)),
    ].join(","));
    const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `orbicore-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="workspace-stack">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <div className="panel-title-row">
              <h2>Durable job queue</h2>
              <span className="count-chip">{jobs.length}</span>
            </div>
            <p>Persisted background worker operations with idempotency and actor rechecks.</p>
          </div>
        </div>
        {jobs.length ? (
          <div className="data-table">
            <div className="data-table-head jobs-cols">
              <span>JOB TYPE</span><span>ACCOUNT</span><span>STATUS</span><span>CREATED</span><span>RESULT</span>
            </div>
            {jobs.map((job) => (
              <div className="data-table-row jobs-cols" key={job.id}>
                <span><strong>{job.type}</strong></span>
                <span>{job.accountLabel}</span>
                <span><span className={`status-badge status-${job.status === "completed" ? "healthy" : "attention"}`}><span className="status-dot" />{job.status}</span></span>
                <span>{formatDateTime(job.createdAt)}</span>
                <span className="path-cell">{job.error ?? (job.result ? `${job.result.sites ?? 0} sites (${job.result.source})` : "Queued")}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-inline">No jobs recorded yet. Click Refresh inventory to enqueue a job.</div>
        )}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <div className="panel-title-row">
              <h2>Redacted audit log</h2>
              <span className="count-chip">{isAdmin ? events.length : "Restricted"}</span>
            </div>
            <p>Tenant-scoped security and operation trail (owner/admin access only).</p>
          </div>
          {isAdmin && (
            <div className="row-actions">
              <button type="button" className="secondary-button compact-btn" disabled={verifyingChain} onClick={() => void verifyChain()}>
                {verifyingChain ? "Verifying..." : "Verify audit chain"}
              </button>
              {events.length > 0 && (
                <button type="button" className="secondary-button compact-btn" onClick={exportAuditCsv}>Export audit CSV</button>
              )}
            </div>
          )}
        </div>
        {isAdmin && chainStatus && (
          <div className={chainStatus.valid ? "notice-strip" : "error-banner"} role="status">
            {chainStatus.valid
              ? `SHA-256 audit chain verified (${chainStatus.checkedCount} chained entries · head ${chainStatus.headHash.slice(0, 12)}…)`
              : `Audit chain integrity failure at ${chainStatus.brokenAtId ?? "unknown"} (${chainStatus.reason ?? "hash_mismatch"})`}
          </div>
        )}
        {!isAdmin ? (
          <div className="empty-inline">Audit logs require owner or admin role permissions.</div>
        ) : loadingAudit ? (
          <div className="loading-state"><span className="loader" /> Loading audit trail...</div>
        ) : (
          <div className="data-table">
            <div className="data-table-head audit-cols">
              <span>ACTION</span><span>TARGET</span><span>OUTCOME</span><span>TIMESTAMP</span><span>DETAILS</span>
            </div>
            {events.map((ev) => (
              <div className="data-table-row audit-cols" key={ev.id}>
                <span><strong>{ev.action}</strong></span>
                <span className="path-cell">{ev.targetId}</span>
                <span>{ev.outcome}</span>
                <span>{formatDateTime(ev.createdAt)}</span>
                <span className="path-cell">{JSON.stringify(ev.details)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export function SystemAndSecurityView({
  actorId,
  role,
  mfaEnabled,
  onOpenMfaModal,
}: {
  actorId: string;
  role: string;
  mfaEnabled: boolean;
  onOpenMfaModal: () => void;
}) {
  const isAdmin = ["owner", "admin"].includes(role);
  const [preflight, setPreflight] = useState<PreflightReport | null>(null);
  const [readiness, setReadiness] = useState<DeploymentReadinessReport | null>(null);
  const [secrets, setSecrets] = useState<SecretReference[]>([]);
  const [encryptionReady, setEncryptionReady] = useState(false);
  const [activeKeyId, setActiveKeyId] = useState<string | null>(null);
  const [secretLabel, setSecretLabel] = useState("");
  const [secretKind, setSecretKind] = useState<"cpanel_uapi_token" | "s3_access_key" | "smtp_credential">("cpanel_uapi_token");
  const [secretUri, setSecretUri] = useState("https://cpanel.example.org:2083");
  const [secretValue, setSecretValue] = useState("");
  const [secretNotice, setSecretNotice] = useState<string | null>(null);
  const [secretError, setSecretError] = useState<string | null>(null);
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [drillResult, setDrillResult] = useState<RestoreDrillResult | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [newMemberEmail, setNewMemberEmail] = useState("");
  const [newMemberPassword, setNewMemberPassword] = useState("");
  const [newMemberRole, setNewMemberRole] = useState<"operator" | "viewer" | "admin">("operator");
  const [teamMessage, setTeamMessage] = useState<string | null>(null);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [contacts, setContacts] = useState<RecoveryContact[]>([]);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [contactEmail, setContactEmail] = useState("");
  const [contactPassword, setContactPassword] = useState("");
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [verifyToken, setVerifyToken] = useState("");
  const [rotateKeyId, setRotateKeyId] = useState("k2");
  const [rotateKeyValue, setRotateKeyValue] = useState("");
  const [rotatePassword, setRotatePassword] = useState("");
  const [rotateMessage, setRotateMessage] = useState<string | null>(null);
  const [backupResult, setBackupResult] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    const reqs: Promise<void>[] = [
      fetch("/api/auth/recovery-contacts").then(async (r) => {
        if (r.ok) {
          const d = await r.json() as { contacts: RecoveryContact[]; outbox: OutboxItem[] };
          setContacts(d.contacts);
          setOutbox(d.outbox);
        }
      }),
    ];
    if (isAdmin) {
      reqs.push(
        fetch("/api/system/preflight").then(async (r) => {
          if (r.ok) setPreflight(await r.json() as PreflightReport);
        }),
        fetch("/api/system/deployment-readiness").then(async (r) => {
          if (r.ok) setReadiness(await r.json() as DeploymentReadinessReport);
        }),
        fetch("/api/secrets").then(async (r) => {
          if (r.ok) {
            const d = await r.json() as { encryptionReady: boolean; activeKeyId: string | null; secrets: SecretReference[] };
            setEncryptionReady(d.encryptionReady);
            setActiveKeyId(d.activeKeyId);
            setSecrets(d.secrets ?? []);
          }
        }),
        fetch("/api/system/backups").then(async (r) => {
          if (r.ok) {
            const d = await r.json() as { backups: BackupSummary[] };
            setBackups(d.backups ?? []);
          }
        }),
        fetch("/api/team/members").then(async (r) => {
          if (r.ok) {
            const d = await r.json() as { members: TeamMember[] };
            setMembers(d.members ?? []);
          }
        }),
      );
    }
    await Promise.all(reqs);
  }, [isAdmin]);

  useEffect(() => { void loadAll(); }, [loadAll]);

  const submitRecoveryContact = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);
    const res = await fetch("/api/auth/recovery-contacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: contactEmail, password: contactPassword }),
    });
    const data = await res.json() as { localVerificationToken?: string; error?: string };
    if (!res.ok || !data.localVerificationToken) {
      setError(data.error === "reauthentication_required" ? "Current password is required to update recovery contact." : "Provide a valid email address.");
      return;
    }
    setIssuedToken(data.localVerificationToken);
    setVerifyToken(data.localVerificationToken);
    setContactPassword("");
    setMessage("Verification token issued locally (no external email provider is configured). Verify below to activate simulated local delivery.");
    await loadAll();
  };

  const confirmContact = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const res = await fetch("/api/auth/recovery-contacts/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: verifyToken }),
    });
    if (!res.ok) {
      setError("Verification token is invalid or expired.");
      return;
    }
    setIssuedToken(null);
    setVerifyToken("");
    setMessage("Recovery contact verified for local notification adapter testing.");
    await loadAll();
  };

  const retryOutbox = async (outboxId: string) => {
    setError(null);
    const res = await fetch("/api/auth/recovery-contacts/outbox/retry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outboxId }),
    });
    if (!res.ok) {
      setError("Could not retry outbox notification.");
      return;
    }
    setMessage("Notification retry processed through local adapter.");
    await loadAll();
  };

  const addTeamMember = async (e: FormEvent) => {
    e.preventDefault();
    setTeamError(null);
    setTeamMessage(null);
    const res = await fetch("/api/team/members", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: newMemberEmail, password: newMemberPassword, role: newMemberRole }),
    });
    const data = await res.json() as { member?: TeamMember; error?: string };
    if (!res.ok || !data.member) {
      setTeamError(
        data.error === "member_already_exists"
          ? "A user with this email already belongs to the workspace."
          : data.error === "password_policy"
            ? "Passphrase must contain at least 12 characters."
            : "Could not add workspace member.",
      );
      return;
    }
    setNewMemberEmail("");
    setNewMemberPassword("");
    setTeamMessage(`Added ${data.member.email} as ${data.member.role}.`);
    await loadAll();
  };

  const updateMember = async (memberId: string, patch: { role?: string; disabled?: boolean }) => {
    setTeamError(null);
    setTeamMessage(null);
    const res = await fetch(`/api/team/members/${encodeURIComponent(memberId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = await res.json() as { error?: string };
    if (!res.ok) {
      setTeamError(
        data.error === "cannot_modify_own_access"
          ? "You cannot demote or disable your own signed-in account."
          : data.error === "last_owner_protected"
            ? "At least one active workspace owner must remain enabled."
            : "Role update was rejected by policy.",
      );
      return;
    }
    setTeamMessage("Workspace member access updated and active sessions reconciled.");
    await loadAll();
  };

  const generateRotationKey = () => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    setRotateKeyValue(btoa(String.fromCharCode(...bytes)));
  };

  const submitKeyRotation = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setRotateMessage(null);
    const res = await fetch("/api/system/mfa/rotate-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newKeyId: rotateKeyId, newKey: rotateKeyValue, password: rotatePassword }),
    });
    const data = await res.json() as { rotated?: number; activeKeyId?: string; error?: string };
    if (!res.ok) {
      setError(
        data.error === "reauthentication_required"
          ? "Current password is required to rotate the MFA key ring."
          : data.error === "mfa_key_unavailable"
            ? "Primary MFA encryption key must be configured in the server environment first."
            : "Provide a valid 32-byte Base64 encryption key and alphanumeric key ID.",
      );
      return;
    }
    setRotateKeyValue("");
    setRotatePassword("");
    setRotateMessage(`Rotated ${data.rotated} authenticator record(s) to key ID "${data.activeKeyId}". Existing TOTP authenticators remain valid.`);
    await loadAll();
  };

  const triggerBackup = async () => {
    setError(null);
    setBackupResult(null);
    const res = await fetch("/api/system/backup", { method: "POST" });
    const data = await res.json() as { fileName?: string; sha256?: string; verified?: boolean; error?: string };
    if (!res.ok) {
      setError(data.error === "permission_denied" ? "Only workspace owners can trigger snapshots." : "Backup failed.");
      return;
    }
    setBackupResult(`Verified snapshot ${data.fileName} (SHA-256: ${data.sha256?.slice(0, 16)}…)`);
    await loadAll();
  };

  const runDrill = async (fileName: string) => {
    setError(null);
    setDrillResult(null);
    const res = await fetch("/api/system/restore-drill", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileName }),
    });
    if (!res.ok) {
      setError("Restore verification drill failed.");
      return;
    }
    setDrillResult(await res.json() as RestoreDrillResult);
  };

  const downloadDiagnostics = async () => {
    const res = await fetch("/api/system/diagnostics/bundle");
    if (!res.ok) {
      setError("Could not generate redacted diagnostics bundle.");
      return;
    }
    const bundle = await res.json();
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `orbicore-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const createSecretReference = async (e: FormEvent) => {
    e.preventDefault();
    setSecretError(null);
    setSecretNotice(null);
    const res = await fetch("/api/secrets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: secretLabel, kind: secretKind, referenceUri: secretUri, secretValue }),
    });
    const data = await res.json() as { secret?: SecretReference; error?: string };
    if (!res.ok) {
      setSecretError(
        data.error === "mfa_key_unavailable"
          ? "Encrypted secret registry fails closed until ORBICORE_MFA_ENCRYPTION_KEY is configured."
          : data.error === "invalid_secret_reference"
            ? "Provide label, non-empty URI, and secret >= 8 characters."
            : `Secret reference rejected (${data.error ?? "validation_error"}).`,
      );
      return;
    }
    setSecretLabel("");
    setSecretValue("");
    setSecretNotice(`Encrypted secret reference "${data.secret?.label}" stored (${data.secret?.maskedPreview}) under key "${data.secret?.keyId}".`);
    await loadAll();
  };

  const revokeSecretReference = async (secretId: string) => {
    setSecretError(null);
    setSecretNotice(null);
    const res = await fetch(`/api/secrets/${encodeURIComponent(secretId)}/revoke`, { method: "POST" });
    if (!res.ok) {
      setSecretError("Only workspace owners can revoke secret references.");
      return;
    }
    setSecretNotice("Secret reference revoked and ciphertext purged.");
    await loadAll();
  };

  return (
    <div className="workspace-stack">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Authentication, passkeys &amp; key-ring rotation</h2>
            <p>Manage FIDO2/WebAuthn passkeys, encrypted TOTP fallback, and versioned MFA encryption keys.</p>
          </div>
          {isAdmin && (
            <button type="button" className="primary-button compact-btn" onClick={onOpenMfaModal}>
              <Icon name="shield" /> {mfaEnabled ? "Manage MFA & passkeys" : "Set up MFA / passkey"}
            </button>
          )}
        </div>
        {role === "owner" && (
          <form className="inline-form" onSubmit={(e) => void submitKeyRotation(e)}>
            <div className="form-grid">
              <label>
                Next MFA key ID
                <input required pattern="[a-zA-Z0-9_-]{2,24}" value={rotateKeyId} onChange={(e) => setRotateKeyId(e.target.value)} />
              </label>
              <label>
                32-byte Base64 encryption key
                <input required placeholder="Click Generate or paste 32-byte base64 key" value={rotateKeyValue} onChange={(e) => setRotateKeyValue(e.target.value)} />
              </label>
              <label>
                Owner password (required)
                <input type="password" required value={rotatePassword} onChange={(e) => setRotatePassword(e.target.value)} />
              </label>
            </div>
            {rotateMessage && <div className="environment-banner">{rotateMessage}</div>}
            <div className="inline-form-actions">
              <small>Re-encrypts stored MFA seeds with a new versioned key ID without invalidating enrolled TOTP apps.</small>
              <div className="heading-actions">
                <button type="button" className="secondary-button compact-btn" onClick={generateRotationKey}>Generate key</button>
                <button className="primary-button compact-btn">Rotate MFA key ring</button>
              </div>
            </div>
          </form>
        )}
      </section>

      {isAdmin && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <div className="panel-title-row">
                <h2>Workspace team &amp; role access control</h2>
                <span className="count-chip">{members.length}</span>
              </div>
              <p>Tenant-scoped operators, admins, and read-only viewers. Role changes or disables revoke active sessions immediately.</p>
            </div>
          </div>
          <form className="inline-form" onSubmit={(e) => void addTeamMember(e)}>
            <div className="form-grid">
              <label>
                Member email
                <input type="email" required placeholder="operator@agency.example" value={newMemberEmail} onChange={(e) => setNewMemberEmail(e.target.value)} />
              </label>
              <label>
                Initial passphrase (12+ chars)
                <input type="password" required minLength={12} value={newMemberPassword} onChange={(e) => setNewMemberPassword(e.target.value)} />
              </label>
              <label>
                Role
                <select value={newMemberRole} onChange={(e) => setNewMemberRole(e.target.value as typeof newMemberRole)}>
                  <option value="operator">Operator (can run dry-runs &amp; refreshes)</option>
                  <option value="viewer">Viewer (read-only inventory)</option>
                  <option value="admin">Admin (team &amp; preflight access)</option>
                </select>
              </label>
            </div>
            {teamMessage && <div className="environment-banner">{teamMessage}</div>}
            {teamError && <div className="error-banner" role="alert">{teamError}</div>}
            <div className="inline-form-actions">
              <small>Members are isolated strictly to this workspace tenant.</small>
              <button className="primary-button compact-btn">Add workspace member</button>
            </div>
          </form>
          {members.length > 0 && (
            <div className="data-table">
              <div className="data-table-head team-cols">
                <span>USER</span><span>ROLE</span><span>MFA</span><span>STATE</span><span>ACCESS CONTROL</span>
              </div>
              {members.map((m) => {
                const isSelf = m.id === actorId;
                return (
                  <div className="data-table-row team-cols" key={m.id}>
                    <span><strong>{m.email}</strong>{isSelf && <small className="cell-sub">Signed in (you)</small>}</span>
                    <span>
                      <select
                        aria-label={`Role for ${m.email}`}
                        disabled={isSelf || (m.role === "owner" && role !== "owner")}
                        value={m.role}
                        onChange={(e) => void updateMember(m.id, { role: e.target.value })}
                      >
                        {m.role === "owner" && <option value="owner">owner</option>}
                        <option value="admin">admin</option>
                        <option value="operator">operator</option>
                        <option value="viewer">viewer</option>
                      </select>
                    </span>
                    <span><span className={`cap-badge ${m.mfaEnabled ? "cap-supported" : "cap-readonly"}`}>{m.mfaEnabled ? "Enabled" : "Not set"}</span></span>
                    <span><span className={`cap-badge ${m.disabled ? "cap-restricted" : "cap-supported"}`}>{m.disabled ? "Disabled" : "Active"}</span></span>
                    <span>
                      <button
                        type="button"
                        className="secondary-button mini-btn"
                        disabled={isSelf || (m.role === "owner" && role !== "owner")}
                        onClick={() => void updateMember(m.id, { disabled: !m.disabled })}
                      >
                        {m.disabled ? "Re-enable" : "Disable"}
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Verified recovery contact &amp; notification outbox</h2>
            <p>Recovery notices are blocked until a contact is verified. External SMTP/webhooks are disabled in local mode.</p>
          </div>
        </div>
        <form className="inline-form" onSubmit={(e) => void submitRecoveryContact(e)}>
          <div className="form-grid">
            <label>
              Recovery email
              <input type="email" required placeholder="recovery@example.org" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
            </label>
            <label>
              Current password (required)
              <input type="password" required value={contactPassword} onChange={(e) => setContactPassword(e.target.value)} />
            </label>
          </div>
          <div className="inline-form-actions">
            <small>{contacts[0] ? `Current: ${contacts[0].address} (${contacts[0].verifiedAt ? "Verified" : "Unverified"})` : "No recovery contact configured."}</small>
            <button className="primary-button compact-btn">Register &amp; issue local token</button>
          </div>
        </form>
        {issuedToken && (
          <form className="inline-form" onSubmit={(e) => void confirmContact(e)}>
            <div className="form-grid">
              <label>
                Local verification token
                <input required value={verifyToken} onChange={(e) => setVerifyToken(e.target.value)} />
              </label>
            </div>
            <div className="inline-form-actions">
              <small>Token shown here only because external email delivery is disabled in local prototype mode.</small>
              <button className="secondary-button compact-btn">Verify recovery contact</button>
            </div>
          </form>
        )}
        {message && <div className="environment-banner">{message}</div>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        {outbox.length > 0 && (
          <div className="data-table">
            <div className="data-table-head outbox-cols">
              <span>EVENT</span><span>RECIPIENT</span><span>STATUS</span><span>ATTEMPTS</span><span>ACTION</span>
            </div>
            {outbox.map((item) => (
              <div className="data-table-row outbox-cols" key={item.id}>
                <span>{item.event}<small className="cell-sub">{formatDateTime(item.createdAt)}</small></span>
                <span>{item.recipient}</span>
                <span><span className="php-tag">{item.status}</span></span>
                <span>{item.attempts}</span>
                <span>
                  {item.status === "retry_pending" ? (
                    <button type="button" className="secondary-button mini-btn" onClick={() => void retryOutbox(item.id)}>Retry</button>
                  ) : (
                    <small className="cell-sub">—</small>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {isAdmin && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Installation preflight, backup restore drill &amp; diagnostics</h2>
              <p>Idempotent runtime checks, SQLite snapshot verification, and redacted diagnostics bundle export.</p>
            </div>
            <div className="heading-actions">
              <button type="button" className="secondary-button compact-btn" onClick={() => void downloadDiagnostics()}>Download redacted diagnostics</button>
              <button type="button" className="secondary-button compact-btn" onClick={() => void loadAll()}>Re-run preflight</button>
              {role === "owner" && (
                <button type="button" className="primary-button compact-btn" onClick={() => void triggerBackup()}>Create &amp; verify DB backup</button>
              )}
            </div>
          </div>
          {backupResult && <div className="environment-banner panel-banner">{backupResult}</div>}
          {drillResult && (
            <div className={`${drillResult.passed ? "environment-banner" : "error-banner"} panel-banner`}>
              Restore drill {drillResult.passed ? "PASSED" : "FAILED"} — schema v{drillResult.schemaVersion}, {drillResult.usersCount} user(s), {drillResult.accountsCount} account(s), {drillResult.sitesCount} site(s), MFA seeds verified: {drillResult.mfaSecretsVerified}/{drillResult.mfaAuthenticatorsChecked}.
            </div>
          )}
          {preflight && (
            <div className="capability-grid">
              {preflight.checks.map((chk) => (
                <div className="capability-card" key={chk.id}>
                  <div className="capability-top">
                    <strong>{chk.label}</strong>
                    <span className={`cap-badge ${chk.status === "pass" ? "cap-supported" : chk.status === "warn" ? "cap-readonly" : chk.status === "fail" ? "cap-restricted" : "cap-info"}`}>
                      {chk.status}
                    </span>
                  </div>
                  <p>{chk.detail}</p>
                </div>
              ))}
            </div>
          )}
          {backups.length > 0 && (
            <div className="data-table">
              <div className="data-table-head backups-cols">
                <span>SNAPSHOT FILE</span><span>SIZE</span><span>SHA-256</span><span>RESTORE DRILL</span>
              </div>
              {backups.map((b) => (
                <div className="data-table-row backups-cols" key={b.fileName}>
                  <span><strong>{b.fileName}</strong><small className="cell-sub">{formatDateTime(b.createdAt)}</small></span>
                  <span>{Math.max(1, Math.round(b.sizeBytes / 1024))} KB</span>
                  <span className="path-cell">{b.sha256.slice(0, 24)}…</span>
                  <span>
                    {role === "owner" ? (
                      <button type="button" className="secondary-button mini-btn" onClick={() => void runDrill(b.fileName)}>Run restore drill</button>
                    ) : (
                      <small className="cell-sub">Owner only</small>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {isAdmin && readiness && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Production deployment readiness wizard</h2>
              <p>Active profile: <strong>{readiness.profile}</strong> — truthful environment verification for external PostgreSQL, Redis, KMS, TLS, and SMTP.</p>
            </div>
            <span className={`cap-badge ${readiness.productionReady ? "cap-supported" : "cap-readonly"}`}>
              {readiness.productionReady ? "production_ready" : "local_sqlite_prototype"}
            </span>
          </div>
          <div className="capability-grid">
            {readiness.gates.map((gate) => (
              <div className="capability-card" key={gate.id}>
                <div className="capability-top">
                  <strong>{gate.service}</strong>
                  <span className={`cap-badge ${gate.status === "configured" ? "cap-supported" : gate.status === "local_only" ? "cap-info" : "cap-readonly"}`}>
                    {gate.status}
                  </span>
                </div>
                <p><code>{gate.envVar}</code> — {gate.detail}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {isAdmin && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Encrypted secret references registry</h2>
              <p>AES-256-GCM envelope storage for provider tokens and offsite backup credentials ({encryptionReady ? `key "${activeKeyId}" ready` : "encryption key unset — fails closed"}).</p>
            </div>
            <span className="count-chip">{secrets.length}</span>
          </div>
          {!encryptionReady && (
            <div className="environment-banner panel-banner">
              Set <strong>ORBICORE_MFA_ENCRYPTION_KEY</strong> (32-byte Base64) to unlock encrypted secret creation. Plaintext values are never stored or returned in API responses.
            </div>
          )}
          <form className="inline-form" onSubmit={createSecretReference}>
            <div className="form-grid">
              <label>Label
                <input value={secretLabel} onChange={(e) => setSecretLabel(e.target.value)} placeholder="Production cPanel UAPI token" required />
              </label>
              <label>Credential kind
                <select value={secretKind} onChange={(e) => setSecretKind(e.target.value as "cpanel_uapi_token" | "s3_access_key" | "smtp_credential")}>
                  <option value="cpanel_uapi_token">cpanel_uapi_token</option>
                  <option value="s3_access_key">s3_access_key</option>
                  <option value="smtp_credential">smtp_credential</option>
                </select>
              </label>
              <label>Target endpoint / URI
                <input value={secretUri} onChange={(e) => setSecretUri(e.target.value)} placeholder="https://cpanel.example.org:2083" required />
              </label>
              <label>Secret material (AES-GCM encrypted at rest)
                <input type="password" value={secretValue} onChange={(e) => setSecretValue(e.target.value)} placeholder="Min 8 characters" minLength={8} required />
              </label>
            </div>
            <div className="inline-form-actions">
              <small>SSRF private/loopback URLs rejected automatically; API lists only masked suffix previews.</small>
              <button type="submit" className="primary-button compact-btn" disabled={!encryptionReady}>Store encrypted reference</button>
            </div>
          </form>
          {secretNotice && <div className="environment-banner panel-banner">{secretNotice}</div>}
          {secretError && <div className="error-banner panel-banner" role="alert">{secretError}</div>}
          {secrets.length > 0 && (
            <div className="data-table">
              <div className="data-table-head secrets-cols">
                <span>LABEL</span><span>KIND</span><span>ENDPOINT / URI</span><span>PREVIEW</span><span>KEY ID</span><span>STATUS / ACTION</span>
              </div>
              {secrets.map((sec) => (
                <div className="data-table-row secrets-cols" key={sec.id}>
                  <span><strong>{sec.label}</strong><small className="cell-sub">{formatDateTime(sec.createdAt)}</small></span>
                  <span><span className="php-tag">{sec.kind}</span></span>
                  <span className="path-cell">{sec.referenceUri}</span>
                  <span><code>{sec.maskedPreview}</code></span>
                  <span><code>{sec.keyId}</code></span>
                  <span>
                    {sec.status === "active" && role === "owner" ? (
                      <button type="button" className="secondary-button mini-btn" onClick={() => void revokeSecretReference(sec.id)}>Revoke</button>
                    ) : (
                      <span className={`cap-badge ${sec.status === "active" ? "cap-supported" : "cap-restricted"}`}>{sec.status}</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export function AutomationAndReportsView({
  isAdmin,
  canMutate,
  onNavigate,
}: {
  isAdmin: boolean;
  canMutate: boolean;
  onNavigate: (section: NavSection) => void;
}) {
  const [insights, setInsights] = useState<AdvisoryInsight[]>([]);
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [report, setReport] = useState<AgencyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [ruleType, setRuleType] = useState<AutomationRule["ruleType"]>("inventory_stale_refresh");
  const [approvalMode, setApprovalMode] = useState<AutomationRule["approvalMode"]>("manual_approval");
  const [dailyRunCap, setDailyRunCap] = useState("3");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [insRes, rulesRes, repRes] = await Promise.all([
        fetch("/api/automation/insights"),
        fetch("/api/automation/rules"),
        fetch("/api/agency/report"),
      ]);
      if (insRes.ok) {
        const d = await insRes.json() as { insights: AdvisoryInsight[] };
        setInsights(d.insights ?? []);
      }
      if (rulesRes.ok) {
        const d = await rulesRes.json() as { rules: AutomationRule[]; runs: AutomationRun[] };
        setRules(d.rules ?? []);
        setRuns(d.runs ?? []);
      }
      if (repRes.ok) {
        setReport(await repRes.json() as AgencyReport);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const createRule = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);
    const res = await fetch("/api/automation/rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, ruleType, approvalMode, dailyRunCap: Number(dailyRunCap) }),
    });
    const data = await res.json() as { rule?: AutomationRule; error?: string };
    if (!res.ok || !data.rule) {
      setError("Provide a rule name and daily execution cap between 1 and 50.");
      return;
    }
    setName("");
    setMessage(`Policy rule "${data.rule.name}" created in non-autonomous dry-run mode.`);
    await load();
  };

  const runRuleDryRun = async (ruleId: string) => {
    setError(null);
    setMessage(null);
    const res = await fetch(`/api/automation/rules/${encodeURIComponent(ruleId)}/run`, { method: "POST" });
    const data = await res.json() as { executed?: boolean; reason?: string; runId?: string };
    if (!res.ok) {
      setError(data.reason ?? "Rule execution blocked by policy or daily run cap.");
      return;
    }
    setMessage(`Dry-run execution completed (run ${data.runId?.slice(0, 8)}…). No autonomous background mutations occurred.`);
    await load();
  };

  const downloadReport = () => {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `orbicore-agency-readiness-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) return <div className="panel loading-state"><span className="loader" /> Loading advisor insights and agency readiness...</div>;

  return (
    <div className="workspace-stack">
      <div className="environment-banner" role="status">
        <span className="banner-icon">i</span>
        <span><strong>Deterministic operations boundary:</strong> Telemetry insights are computed locally from measured workspace state. No autonomous background loop or external LLM API is enabled.</span>
      </div>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <div className="panel-title-row">
              <h2>Read-only risk &amp; capacity advisor</h2>
              <span className="count-chip">{insights.length}</span>
            </div>
            <p>Deterministic signals synthesized from account quotas, snapshot freshness, runtime versions, and recovery readiness.</p>
          </div>
        </div>
        {insights.length ? (
          <div className="capability-grid">
            {insights.map((ins) => (
              <div className="capability-card" key={ins.id}>
                <div className="capability-top">
                  <strong>{ins.title}</strong>
                  <span className={`cap-badge ${ins.severity === "high" ? "cap-restricted" : ins.severity === "medium" ? "cap-readonly" : "cap-info"}`}>
                    {ins.severity} · {ins.evidenceKind}
                  </span>
                </div>
                <p>{ins.detail}</p>
                <div className="drill-actions">
                  <button type="button" className="secondary-button mini-btn" onClick={() => onNavigate(ins.recommendedAction)}>
                    Open {ins.recommendedAction}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-inline">No operational risk signals detected right now.</div>
        )}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <div className="panel-title-row">
              <h2>Policy-gated automation rules</h2>
              <span className="count-chip">{rules.length}</span>
            </div>
            <p>Explicit operator trigger and strict per-day run caps govern every dry-run execution.</p>
          </div>
        </div>
        {isAdmin && (
          <form className="inline-form" onSubmit={(e) => void createRule(e)}>
            <div className="form-grid">
              <label>
                Rule name
                <input required placeholder="e.g. Daily stale fixture check" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label>
                Rule type
                <select value={ruleType} onChange={(e) => setRuleType(e.target.value as AutomationRule["ruleType"])}>
                  <option value="inventory_stale_refresh">Inventory stale refresh check</option>
                  <option value="quota_threshold_alert">Quota threshold evaluation</option>
                  <option value="backup_snapshot_schedule">Backup snapshot posture check</option>
                </select>
              </label>
              <label>
                Approval gate
                <select value={approvalMode} onChange={(e) => setApprovalMode(e.target.value as AutomationRule["approvalMode"])}>
                  <option value="manual_approval">Manual operator approval</option>
                  <option value="dry_run_bounded">Bounded dry-run policy</option>
                </select>
              </label>
              <label>
                Daily run cap (1–50)
                <input type="number" min={1} max={50} required value={dailyRunCap} onChange={(e) => setDailyRunCap(e.target.value)} />
              </label>
            </div>
            <div className="inline-form-actions">
              <small>Only owners and admins can register automation rules; runs remain dry-run-only.</small>
              <button className="primary-button compact-btn">Create policy rule</button>
            </div>
          </form>
        )}
        {message && <div className="environment-banner panel-banner">{message}</div>}
        {error && <div className="error-banner panel-banner" role="alert">{error}</div>}
        {rules.length ? (
          <div className="data-table">
            <div className="data-table-head rules-cols">
              <span>RULE NAME</span><span>TYPE</span><span>APPROVAL GATE</span><span>CAP / DAY</span><span>DRY-RUN</span>
            </div>
            {rules.map((rule) => (
              <div className="data-table-row rules-cols" key={rule.id}>
                <span><strong>{rule.name}</strong><small className="cell-sub">Last run: {formatDateTime(rule.lastRunAt)}</small></span>
                <span>{rule.ruleType.replaceAll("_", " ")}</span>
                <span><span className="php-tag">{rule.approvalMode.replaceAll("_", " ")}</span></span>
                <span>{rule.dailyRunCap}</span>
                <span>
                  <button
                    type="button"
                    className="secondary-button mini-btn"
                    disabled={!canMutate}
                    onClick={() => void runRuleDryRun(rule.id)}
                  >
                    Run dry-run
                  </button>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-inline">No automation rules configured yet.</div>
        )}

        {runs.length > 0 && (
          <div className="data-table">
            <div className="data-table-head runs-cols">
              <span>RECENT RULE RUN</span><span>STATUS</span><span>EVALUATION SUMMARY</span><span>RECORDED</span>
            </div>
            {runs.map((run) => (
              <div className="data-table-row runs-cols" key={run.id}>
                <span><strong>{run.ruleName}</strong></span>
                <span><span className="cap-badge cap-supported">{run.status}</span></span>
                <span className="path-cell">{JSON.stringify(run.summary)}</span>
                <span>{formatDateTime(run.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {report && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Agency portfolio readiness report</h2>
              <p>Unified inventory, resilience, and capability boundary snapshot ({report.organization.name}).</p>
            </div>
            <button type="button" className="secondary-button compact-btn" onClick={downloadReport}>
              Download agency report JSON
            </button>
          </div>
          <div className="report-grid">
            <div className="report-stat"><small>Accounts / Sites</small><strong>{report.portfolio.accountsCount} / {report.portfolio.sitesTotal}</strong></div>
            <div className="report-stat"><small>Disk utilization</small><strong>{report.portfolio.utilizationPercent}%</strong></div>
            <div className="report-stat"><small>Verified site snapshots</small><strong>{report.readiness.verifiedSiteSnapshots}</strong></div>
            <div className="report-stat"><small>SQLite backups / drills</small><strong>{report.readiness.completedSystemBackups} / {report.readiness.completedRestoreDrills}</strong></div>
            <div className="report-stat"><small>Storage policies</small><strong>{report.readiness.storageOffloadPolicies}</strong></div>
            <div className="report-stat"><small>Live connections</small><strong>{report.measurementBoundary.liveProviderConnections}</strong></div>
          </div>
        </section>
      )}
    </div>
  );
}

