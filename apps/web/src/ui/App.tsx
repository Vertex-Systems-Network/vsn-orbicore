import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Icon } from "./icons";
import type { HostingAccount, Job, Overview, Site } from "./types";

type User = { id: string; email: string; role: string; organizationId: string; mfaEnabled?: boolean | number };

function AuthGate({ bootstrapRequired, onAuthenticated }: { bootstrapRequired: boolean; onAuthenticated: (user: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [mfaChallenge, setMfaChallenge] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(mfaChallenge ? "/api/auth/mfa/challenge" : bootstrapRequired ? "/api/auth/bootstrap" : "/api/auth/login", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(mfaChallenge ? { challenge: mfaChallenge, code: mfaCode } : bootstrapRequired ? { token, email, password } : { email, password }),
      });
      const data = await response.json() as { user?: User; error?: string; mfaRequired?: boolean; challenge?: string };
      if (response.status === 202 && data.mfaRequired && data.challenge) {
        setMfaChallenge(data.challenge);
        setPassword("");
        return;
      }
      if (!response.ok || !data.user) throw new Error(data.error === "password_policy" ? "Choose a password with at least 12 characters." : data.error === "invalid_bootstrap_token" ? "The setup token is incorrect or has already been used." : "Could not sign in. Check the details and try again.");
      onAuthenticated(data.user);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The local API is unavailable.");
    } finally { setBusy(false); }
  };

  return <main className="auth-screen"><form className="auth-card" onSubmit={(event) => void submit(event)}>
    <div className="brand-lockup auth-brand"><span className="brand-symbol"><i /><i /><i /></span><span><strong>ORBICORE</strong><small>BY VSN</small></span></div>
    <div className="eyebrow"><span className="live-indicator" /> LOCAL ADMINISTRATION</div>
    <h1>{bootstrapRequired ? "Set up your workspace" : mfaChallenge ? "Verify your sign-in" : "Welcome back"}</h1>
    <p>{bootstrapRequired ? "Create the first workspace owner. The one-time setup token is stored in .data/first-admin.token." : mfaChallenge ? "Enter a current authenticator code or a one-time recovery code." : "Sign in to your hosting workspace."}</p>
    {!mfaChallenge && bootstrapRequired && <label>One-time setup token<input autoComplete="off" type="password" required value={token} onChange={(event) => setToken(event.target.value)} /></label>}
    {!mfaChallenge && <label>Email address<input autoComplete="username" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>}
    {!mfaChallenge && <label>Password<input autoComplete={bootstrapRequired ? "new-password" : "current-password"} type="password" minLength={bootstrapRequired ? 12 : undefined} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>}
    {mfaChallenge && <><label>Authenticator or recovery code<input autoComplete="one-time-code" inputMode="text" autoFocus required value={mfaCode} onChange={(event) => setMfaCode(event.target.value)} /></label><small>TOTP is a compatibility fallback and is not phishing-resistant. Use a saved recovery code only once.</small><button type="button" className="auth-restart" onClick={() => { setMfaChallenge(""); setMfaCode(""); setError(null); }}>Start sign-in again</button></>}
    {error && <div className="auth-error" role="alert">{error}</div>}
    <button className="primary-button auth-submit" disabled={busy}>{busy ? "Please wait..." : mfaChallenge ? "Verify and sign in" : bootstrapRequired ? "Create workspace owner" : "Sign in"}</button>
    <small className="auth-footnote">Local-only prototype. Use a unique password; provider credentials are not configured here.</small>
  </form></main>;
}

function MfaSetup({ enabled, onEnabled, onDisabled, onClose }: { enabled: boolean; onEnabled: () => void; onDisabled: () => void; onClose: () => void }) {
  const [secret, setSecret] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const begin = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/mfa/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: currentPassword }) });
      const data = await response.json() as { secret?: string; error?: string };
      if (!response.ok || !data.secret) throw new Error(data.error === "mfa_key_unavailable" ? "Set ORBICORE_MFA_ENCRYPTION_KEY to a base64-encoded 32-byte key and restart the API." : data.error === "reauthentication_required" ? "Enter your current password to confirm this security change." : "Could not start MFA enrollment.");
      setSecret(data.secret);
      setCurrentPassword("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "MFA setup failed."); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/mfa/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
      const data = await response.json() as { recoveryCodes?: string[] };
      if (!response.ok || !data.recoveryCodes) throw new Error("Code not accepted. Check your authenticator and try again.");
      setRecoveryCodes(data.recoveryCodes); onEnabled();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "MFA verification failed."); }
    finally { setBusy(false); }
  };
  const disable = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/mfa/disable", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: currentPassword, code }) });
      const data = await response.json() as { disabled?: boolean };
      if (!response.ok || !data.disabled) throw new Error("Password and a current, unused authenticator code are required.");
      onDisabled();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not disable MFA."); }
    finally { setBusy(false); }
  };
  return <div className="mfa-backdrop"><section className="mfa-panel" role="dialog" aria-modal="true" aria-labelledby="mfa-title">
    <button className="mfa-close" onClick={onClose} aria-label="Close security setup">×</button><div className="eyebrow">ACCOUNT SECURITY</div><h2 id="mfa-title">Authenticator setup</h2>
    {recoveryCodes.length ? <><p>Save these recovery codes offline. They are shown once and each works once.</p><ul className="recovery-codes">{recoveryCodes.map((item) => <li key={item}>{item}</li>)}</ul><button className="primary-button" onClick={onClose}>I saved the codes</button></> : enabled ? <><p>Disabling MFA requires your current password and a new, unused authenticator code. All sessions will be revoked.</p><label>Current password<input type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label><label>Current authenticator code<input autoComplete="one-time-code" inputMode="numeric" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} /></label><button className="primary-button" disabled={busy || !currentPassword || code.length !== 6} onClick={() => void disable()}>{busy ? "Verifying…" : "Disable MFA and sign out"}</button></> : !secret ? <><p>Time-based codes are a compatibility fallback and are not phishing-resistant. Confirm your password before binding a new authenticator.</p><label>Current password<input type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label><button className="primary-button" disabled={busy || !currentPassword} onClick={() => void begin()}>{busy ? "Starting…" : "Start enrollment"}</button></> : <><p>Enter this key into an authenticator app, then verify a current six-digit code.</p><code className="mfa-secret">{secret}</code><label>Six-digit code<input autoComplete="one-time-code" inputMode="numeric" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} /></label><button className="primary-button" disabled={busy || code.length !== 6} onClick={() => void confirm()}>{busy ? "Verifying…" : "Verify and enable"}</button></>}
    {error && <div className="auth-error" role="alert">{error}</div>}
  </section></div>;
}

const navGroups = [
  { label: "WORKSPACE", items: [{ label: "Overview", icon: "grid" }, { label: "Hosting accounts", icon: "server" }, { label: "Websites", icon: "globe" }] },
  { label: "OPERATIONS", items: [{ label: "Migrations", icon: "move" }, { label: "Storage", icon: "database" }, { label: "Jobs & activity", icon: "clock" }] },
] as const;

const formatBytes = (bytes: number) => {
  if (!bytes) return "0 GB";
  const gb = bytes / 1024 ** 3;
  return `${gb >= 100 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
};

const formatRelative = (value: string | null) => {
  if (!value) return "Never synced";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hr${hours === 1 ? "" : "s"} ago`;
};

function StatusBadge({ status }: { status: string }) {
  const label = status === "healthy" ? "Operational" : status === "attention" ? "Attention" : status === "completed" ? "Completed" : status;
  return <span className={`status-badge status-${status}`}><span className="status-dot" />{label}</span>;
}

function AccountRow({ account, onSelect, selected }: { account: HostingAccount; onSelect: () => void; selected: boolean }) {
  const usage = account.quotaBytes ? Math.min(100, (account.usedBytes / account.quotaBytes) * 100) : 0;
  return <button className={`account-row ${selected ? "selected" : ""}`} onClick={onSelect} aria-label={`View ${account.label}`}>
    <span className="account-cell account-name-cell"><span className="account-avatar">{account.label.slice(0, 1)}</span><span className="account-name-copy"><strong>{account.label}</strong><small>{account.username} · {account.host}</small></span></span>
    <span className="provider-cell"><span className="provider-mark">cP</span>cPanel</span>
    <span className="sites-cell"><strong>{account.siteCount}</strong><small>websites</small></span>
    <span className="usage-cell"><span className="usage-number">{formatBytes(account.usedBytes)} <small>/ {formatBytes(account.quotaBytes)}</small></span><span className="usage-track"><span style={{ width: `${usage}%` }} /></span></span>
    <span className="sync-cell">{formatRelative(account.lastSyncedAt)}<small>{account.source === "mock_fixture" ? "Fixture data" : "Provider data"}</small></span>
    <span className="row-status"><StatusBadge status={account.health} /></span>
    <span className="row-arrow"><Icon name="arrow" /></span>
  </button>;
}

function JobRow({ job }: { job: Job }) {
  const done = job.status === "completed";
  return <li className="job-row"><span className={`job-icon ${done ? "job-success" : "job-running"}`}><Icon name={done ? "check" : "refresh"} /></span><span className="job-copy"><strong>{done ? "Inventory refreshed" : "Inventory refresh"}</strong><small>{job.accountLabel} · {formatRelative(job.completedAt || job.createdAt)}</small></span><span className={`job-state ${done ? "" : "state-pending"}`}>{done ? "Done" : job.status}</span></li>;
}

export function App() {
  const [actor, setActor] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [bootstrapRequired, setBootstrapRequired] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [query, setQuery] = useState("");
  const activeNav = "Overview";
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMfaSetup, setShowMfaSetup] = useState(false);

  const loadOverview = useCallback(async () => {
    try {
      const response = await fetch("/api/overview");
      if (!response.ok) throw new Error("The local API could not load the overview.");
      const data = (await response.json()) as Overview;
      setOverview(data);
      setError(null);
      setSelectedAccountId((current) => current ?? data.accounts[0]?.id ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the overview.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me").then(async (response) => {
      if (response.ok) {
        const data = await response.json() as { user: User };
        if (!cancelled) setActor(data.user);
      } else {
        const status = await fetch("/api/auth/bootstrap-status").then((result) => result.json()) as { required: boolean };
        if (!cancelled) setBootstrapRequired(status.required);
      }
    }).catch(() => {
      if (!cancelled) setError("The local API is unavailable. Start the API service and try again.");
    }).finally(() => { if (!cancelled) setAuthLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { if (actor) void loadOverview(); }, [actor, loadOverview]);

  useEffect(() => {
    if (!selectedAccountId) { setSites([]); return; }
    let cancelled = false;
    fetch(`/api/accounts/${encodeURIComponent(selectedAccountId)}/sites`)
      .then((response) => { if (!response.ok) throw new Error("Could not load websites."); return response.json() as Promise<{ sites: Site[] }>; })
      .then((data) => { if (!cancelled) setSites(data.sites); })
      .catch(() => { if (!cancelled) setSites([]); });
    return () => { cancelled = true; };
  }, [selectedAccountId, overview?.counts.sites]);

  useEffect(() => {
    if (!refreshing || !overview) return;
    const timer = window.setInterval(() => { void loadOverview(); }, 1000);
    return () => window.clearInterval(timer);
  }, [refreshing, overview, loadOverview]);

  const filteredAccounts = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return overview?.accounts ?? [];
    return (overview?.accounts ?? []).filter((account) => `${account.label} ${account.host} ${account.username}`.toLowerCase().includes(normalized));
  }, [overview, query]);

  const runRefresh = async () => {
    if (!overview || refreshing) return;
    setRefreshing(true);
    try {
      const ids = overview.accounts.map((account) => account.id);
      await Promise.all(ids.map((accountId) => fetch("/api/jobs/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId }) })));
      await loadOverview();
      window.setTimeout(() => setRefreshing(false), 1500);
    } catch {
      setError("Refresh could not be queued. Your current inventory is unchanged.");
      setRefreshing(false);
    }
  };

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setActor(null);
    setOverview(null);
    setSites([]);
  };

  const activeAccount = overview?.accounts.find((account) => account.id === selectedAccountId);
  const jobs: Job[] = overview?.jobs ?? [];
  const utilization = overview?.storage.quotaBytes ? Math.round((overview.storage.usedBytes / overview.storage.quotaBytes) * 100) : 0;

  if (authLoading) return <main className="auth-screen"><div className="auth-card auth-loading"><span className="loader" /> Checking your local session...</div></main>;
  if (!actor) return <AuthGate bootstrapRequired={bootstrapRequired} onAuthenticated={(user) => { setActor(user); setError(null); }} />;

  return <div className="app-shell">
    <aside className="sidebar" aria-label="Primary navigation">
      <div className="brand-lockup"><span className="brand-symbol"><i /><i /><i /></span><span><strong>ORBICORE</strong><small>BY VSN</small></span></div>
      <button className="org-switcher" aria-label="Current workspace: Pella Global"><span className="org-avatar">P</span><span><strong>Pella Global</strong><small>Agency workspace</small></span><span className="chevron">⌄</span></button>
      <nav className="primary-nav">
        {navGroups.map((group) => <div className="nav-group" key={group.label}><span className="nav-group-label">{group.label}</span>{group.items.map((item) => <button key={item.label} disabled={item.label !== "Overview"} title={item.label === "Overview" ? undefined : "Not available in this local demo"} className={`nav-item ${activeNav === item.label ? "active" : ""}`}><Icon name={item.icon} /><span>{item.label}</span>{item.label === "Jobs & activity" && jobs.length > 0 && <em>{jobs.length}</em>}</button>)}</div>)}
      </nav>
      <div className="sidebar-bottom">{["owner", "admin"].includes(actor.role) && <button className="nav-item settings-item" onClick={() => setShowMfaSetup(true)}><span className="settings-gear">⚿</span><span>{actor.mfaEnabled ? "Manage MFA" : "Set up MFA"}</span></button>}<div className="user-profile"><span className="user-avatar">{actor.email.slice(0, 1).toUpperCase()}</span><span><strong>{actor.email}</strong><small>{actor.role} · local workspace</small></span><button className="logout-button" onClick={() => void logout()} title="Sign out" aria-label="Sign out">↗</button></div></div>
    </aside>

    <main className="main-content">
      <header className="topbar">
        <div className="breadcrumbs"><span>Workspace</span><span className="crumb-divider">/</span><strong>{activeNav}</strong></div>
        <div className="topbar-actions"><label className="global-search"><Icon name="search" /><input aria-label="Search accounts" placeholder="Search accounts..." value={query} onChange={(event) => setQuery(event.target.value)} /><kbd>⌘ K</kbd></label><button className="icon-button alert-button" aria-label="Notifications" disabled title="Notifications are not available in this local demo"><Icon name="bell" /><i /></button><span className="topbar-avatar" aria-label="Alex Morgan">AM</span></div>
      </header>

      <div className="page-container">
        <section className="page-heading"><div><div className="eyebrow"><span className="live-indicator" /> CONTROL CENTER <span className="eyebrow-divider">·</span> {new Intl.DateTimeFormat("en", { weekday: "long", month: "long", day: "numeric" }).format(new Date())}</div><h1>Good morning, Alex</h1><p className="page-subtitle">Here’s what’s happening across your hosting infrastructure.</p></div><div className="heading-actions"><button className="secondary-button" disabled title="Account connection is not available in the local demo"><Icon name="plus" /> Add account</button><button className="primary-button" onClick={() => void runRefresh()} disabled={loading || refreshing || !overview}><Icon className={refreshing ? "spinning" : ""} name="refresh" />{refreshing ? "Refreshing..." : "Refresh inventory"}</button></div></section>

        <div className="environment-banner" role="status"><span className="banner-icon">i</span><span><strong>Demo workspace</strong> — showing synthetic cPanel fixture data. No hosting accounts are connected.</span><button disabled title="Not available in this local demo">Connection guide <Icon name="arrow" /></button></div>

        {error && <div className="error-banner" role="alert"><strong>Could not refresh live data.</strong> {error}<button onClick={() => void loadOverview()}>Try again</button></div>}

        <section className="metric-grid" aria-label="Hosting overview metrics">
          <article className="metric-card"><div className="metric-card-top"><span>Hosting accounts</span><span className="metric-icon mint"><Icon name="server" /></span></div><div className="metric-value">{loading ? "—" : overview?.counts.accounts ?? 0}</div><div className="metric-foot"><span className="metric-neutral"><Icon name="clock" /> Fixture data</span><span>Across this workspace</span></div></article>
          <article className="metric-card"><div className="metric-card-top"><span>Websites tracked</span><span className="metric-icon blue"><Icon name="globe" /></span></div><div className="metric-value">{loading ? "—" : overview?.counts.sites ?? 0}</div><div className="metric-foot"><span className="metric-neutral"><Icon name="check" /> Inventory snapshot</span><span>Last read: {formatRelative(overview?.accounts[0]?.lastSyncedAt ?? null)}</span></div></article>
          <article className="metric-card"><div className="metric-card-top"><span>Storage utilization</span><span className="metric-icon amber"><Icon name="database" /></span></div><div className="metric-value">{loading ? "—" : formatBytes(overview?.storage.usedBytes ?? 0)}<small> / {formatBytes(overview?.storage.quotaBytes ?? 0)}</small></div><div className="metric-foot"><span className="metric-neutral">{utilization}% used</span><span>Across connected accounts</span></div><div className="metric-progress"><span style={{ width: `${utilization}%` }} /></div></article>
          <article className="metric-card"><div className="metric-card-top"><span>Account health</span><span className="metric-icon green"><Icon name="check" /></span></div><div className="metric-value health-value">{loading ? "—" : overview?.counts.healthy ?? 0}<small> / {overview?.counts.accounts ?? 0} healthy</small></div><div className="metric-foot"><span className="health-legend"><i /> Operational</span><span><i className="attention-dot" /> {overview?.counts.attention ?? 0} needs attention</span></div></article>
        </section>

        <section className="content-grid">
          <article className="panel accounts-panel"><div className="panel-heading"><div><div className="panel-title-row"><h2>Hosting accounts</h2><span className="count-chip">{overview?.counts.accounts ?? 0}</span></div><p>Manage and monitor your connected infrastructure.</p></div></div>
            <div className="account-table-head"><span>ACCOUNT</span><span>PROVIDER</span><span>SITES</span><span>STORAGE USAGE</span><span>LAST SYNC</span><span>HEALTH</span><span aria-hidden="true" /></div>
            <div className="account-rows">{loading ? <div className="loading-state"><span className="loader" /> Loading inventory...</div> : filteredAccounts.length ? filteredAccounts.map((account) => <AccountRow key={account.id} account={account} selected={selectedAccountId === account.id} onSelect={() => setSelectedAccountId(account.id)} />) : <div className="empty-state"><strong>No matching accounts</strong><span>Try a different search term.</span></div>}</div>
            <div className="panel-footer"><span>Showing <strong>{filteredAccounts.length}</strong> of <strong>{overview?.counts.accounts ?? 0}</strong> accounts</span><span>Fixture inventory</span></div>
          </article>

          <article className="panel activity-panel"><div className="panel-heading"><div><h2>Recent activity</h2><p>Latest operations across your workspace.</p></div></div><div className="activity-content">{jobs.length ? <ul className="job-list">{jobs.slice(0, 4).map((job) => <JobRow key={job.id} job={job} />)}</ul> : <div className="activity-empty"><span className="empty-clock"><Icon name="clock" /></span><strong>No recent activity</strong><span>Refresh inventory to create a local demo job.</span></div>}</div><div className="activity-footer"><span className="activity-status"><i /> Job worker ready</span><span>Local demo queue</span></div></article>
        </section>

        <section className="panel site-panel"><div className="panel-heading"><div><div className="panel-title-row"><h2>Websites</h2><span className="count-chip">{activeAccount ? sites.length : 0}</span></div><p>{activeAccount ? `Latest discovered sites from ${activeAccount.label}.` : "Select an account to view discovered sites."}</p></div></div>
          {sites.length ? <div className="site-table"><div className="site-table-head"><span>WEBSITE</span><span>TYPE</span><span>DOCUMENT ROOT</span><span>PHP</span><span>STATUS</span></div>{sites.slice(0, 4).map((site) => <div className="site-row" key={site.id}><span><span className="site-favicon">{site.domain.slice(0, 1).toUpperCase()}</span><strong>{site.domain}</strong></span><span>{site.kind}</span><span className="path-cell">{site.documentRoot}</span><span className="php-tag">{site.phpVersion}</span><span><StatusBadge status={site.status === "active" ? "healthy" : site.status} /></span></div>)}</div> : <div className="empty-inline">{loading ? "Loading websites..." : "No websites discovered for this account."}</div>}
        </section>

        <footer className="page-footer"><span>VSN ORBICORE <b>·</b> Local demo build</span><span>Inventory source: {overview?.source === "mock_fixture" ? "synthetic fixture" : "provider"} <b>·</b> Live connections: {overview?.liveConnections ?? 0}</span></footer>
      </div>
    </main>
    {showMfaSetup && <MfaSetup enabled={Boolean(actor.mfaEnabled)} onClose={() => setShowMfaSetup(false)} onEnabled={() => setActor((current) => current ? { ...current, mfaEnabled: true } : current)} onDisabled={() => { setShowMfaSetup(false); setActor(null); }} />}
  </div>;
}
