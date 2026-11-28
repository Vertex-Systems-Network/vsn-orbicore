import { createHash } from "node:crypto";
import { CAPABILITY_PROFILES, isCapabilityProfileName, validateCpanelApiHost, validateExternalEndpoint } from "./security.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// A provider-controlled success body must never be read without a byte cap.
// This limit applies to decoded stream bytes, not only Content-Length.
export const MAX_UAPI_RESPONSE_BYTES = 2 * 1024 * 1024;

export class LiveCpanelAdapterBoundary {
  constructor({ fetchImpl = fetch, timeoutMs = 5000 } = {}) {
    this.mode = "disabled_local_prototype";
    this.live = false;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async _callUapi(connectionRef, moduleName, funcName) {
    // An explicit boolean grant is required. Never coerce untrusted
    // configuration values or credential objects into an authorization header.
    if (connectionRef?.authorized !== true ||
        typeof connectionRef.username !== "string" ||
        typeof connectionRef.apiToken !== "string" ||
        !connectionRef.username.trim() || !connectionRef.apiToken.trim() ||
        /[^\x21-\x7e]|:/.test(connectionRef.username) ||
        /[^\x21-\x7e]/.test(connectionRef.apiToken)) {
      return {
        ok: false,
        live: true,
        error: "live_credentials_not_authorized",
        reason: "Live cPanel connection is blocked until owner-authorized sandbox tokens are explicitly provisioned.",
      };
    }
    const endpoint = validateCpanelApiHost(connectionRef.host);
    if (!endpoint.valid) {
      return { ok: false, live: true, error: endpoint.reason, reason: "Host rejected by outbound SSRF policy." };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const targetUrl = `${endpoint.origin}/execute/${encodeURIComponent(moduleName)}/${encodeURIComponent(funcName)}`;
      const res = await this.fetchImpl(targetUrl, {
        method: "GET",
        headers: {
          Authorization: `cpanel ${connectionRef.username}:${connectionRef.apiToken}`,
          Accept: "application/json",
        },
        // A redirect could cross the SSRF allow boundary even when the
        // original HTTPS endpoint passed validation. Never follow it.
        redirect: "manual",
        signal: controller.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        return { ok: false, live: true, error: "uapi_redirect_denied" };
      }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, live: true, error: "revoked_or_denied_token", status: res.status };
      }
      if (!res.ok) {
        return { ok: false, live: true, error: "uapi_http_error", status: res.status };
      }
      const declaredLength = res.headers?.get("content-length");
      if (declaredLength !== null && declaredLength !== undefined &&
          Number(declaredLength) > MAX_UAPI_RESPONSE_BYTES) {
        controller.abort();
        return { ok: false, live: true, error: "uapi_response_too_large" };
      }
      const reader = res.body?.getReader?.();
      if (!reader) return { ok: false, live: true, error: "invalid_uapi_response" };
      const chunks = [];
      let totalBytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!(value instanceof Uint8Array)) {
            controller.abort();
            return { ok: false, live: true, error: "invalid_uapi_response" };
          }
          totalBytes += value.byteLength;
          if (totalBytes > MAX_UAPI_RESPONSE_BYTES) {
            controller.abort();
            // A malicious stream may keep sending data. Cancellation is
            // best-effort and must not stall the error response.
            void reader.cancel().catch(() => {});
            return { ok: false, live: true, error: "uapi_response_too_large" };
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
      let payload;
      try {
        payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, totalBytes)));
      } catch {
        return { ok: false, live: true, error: "invalid_uapi_response" };
      }
      // cPanel direct /execute responses contain status/data at the top level;
      // some documented UAPI transports use a result envelope. Never accept
      // an HTTP 200 with missing/malformed UAPI success metadata as success.
      const result = payload && typeof payload === "object" && !Array.isArray(payload) && "result" in payload
        ? payload.result : payload;
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        return { ok: false, live: true, error: "invalid_uapi_response" };
      }
      // A malformed error field is not evidence of a successful call.
      // Accept omitted/null errors for compatibility, or an explicit array.
      if (result.errors != null && !Array.isArray(result.errors)) {
        return { ok: false, live: true, error: "invalid_uapi_response" };
      }
      const messagesCount = Array.isArray(result.errors) ? result.errors.length : 0;
      if (result.status === 0 || messagesCount > 0) {
        return { ok: false, live: true, error: "uapi_call_failed", messagesCount };
      }
      if (result.status !== 1) {
        return { ok: false, live: true, error: "invalid_uapi_response" };
      }
      return { ok: true, live: true, data: result.data ?? null };
    } catch {
      return { ok: false, live: true, error: "provider_unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }

  async discoverCapabilities(connectionRef) {
    const quotaCheck = await this._callUapi(connectionRef, "Quota", "get_quota_info");
    if (!quotaCheck.ok) return quotaCheck;
    return {
      ok: true,
      live: true,
      host: connectionRef.host,
      source: "cpanel_uapi_read_only",
      // The quota probe proves only that this read-only function returned
      // UAPI success. A mock profile is not an account permission grant.
      capabilities: CAPABILITY_PROFILES.cpanel_uapi_standard.map(({ capability }) =>
        capability === "quotas.read"
          ? { capability, level: "read_only", note: "Quota::get_quota_info returned UAPI success; quota values were not validated." }
          : { capability, level: "unknown", note: "Not probed; no permission inferred from quota response." },
      ),
      fetchedAt: new Date().toISOString(),
    };
  }

  async fetchInventory(connectionRef) {
    const domainsRes = await this._callUapi(connectionRef, "DomainInfo", "domains_data");
    if (!domainsRes.ok) {
      return { ...domainsRes, accounts: [], sites: [] };
    }
    const data = domainsRes.data;
    // HTTP + UAPI status=1 is not proof of a usable domain snapshot.
    // Do not silently report an empty inventory or fabricate a file path
    // when the provider returned missing/malformed domain records.
    const malformed = () => ({
      ok: false, live: true, error: "invalid_uapi_inventory_response",
      accounts: [], sites: [],
    });
    if (!data || typeof data !== "object" || Array.isArray(data) ||
        !data.main_domain || typeof data.main_domain !== "object" ||
        Array.isArray(data.main_domain) ||
        (data.addon_domains != null && !Array.isArray(data.addon_domains)) ||
        (data.sub_domains != null && !Array.isArray(data.sub_domains))) {
      return malformed();
    }
    const list = [
      data.main_domain,
      ...(data.addon_domains ?? []),
      ...(data.sub_domains ?? []),
    ];
    if (!list.every((d) => d && typeof d === "object" && !Array.isArray(d) &&
      typeof d.domain === "string" && d.domain.trim().length > 0)) {
      return malformed();
    }
    return {
      ok: true,
      live: true,
      source: "cpanel_uapi_read_only",
      fetchedAt: new Date().toISOString(),
      sites: list.map((d) => {
        const documentRoot = typeof d.documentroot === "string" && d.documentroot.trim()
          ? d.documentroot : null;
        const phpVersion = typeof d.phpversion === "string" && d.phpversion.trim()
          ? d.phpversion : null;
        return {
          domain: d.domain,
          documentRoot,
          phpVersion,
          metadataComplete: documentRoot !== null && phpVersion !== null,
          kind: d.type === "main_domain" ? "Primary" : "Domain",
        };
      }),
    };
  }

  async healthCheck(connectionRef) {
    const ping = await this._callUapi(connectionRef, "Variables", "get_user_information");
    return ping.ok
      ? { status: "reachable_read_only", live: true, checkedAt: new Date().toISOString() }
      : { status: ping.error === "revoked_or_denied_token" ? "unauthorized" : "disabled", live: true, error: ping.error };
  }
}

export function createMockCpanelAdapter(fixture) {
  return {
    mode: "mock_fixture",
    live: false,

    discoverCapabilities({ accountId, label, capabilityProfile = "cpanel_uapi_standard" }) {
      const profileName = isCapabilityProfileName(capabilityProfile) ? capabilityProfile : "cpanel_uapi_standard";
      return {
        accountId,
        accountLabel: label,
        profileName,
        capabilities: CAPABILITY_PROFILES[profileName],
        source: "mock_fixture",
        live: false,
        fetchedAt: new Date().toISOString(),
      };
    },

    fetchInventory({ accountId, fixtureAccount, dbSites = [] }) {
      const sites = fixtureAccount ? fixtureAccount.sites : dbSites;
      return {
        source: "mock_fixture",
        live: false,
        provider: fixture?.metadata?.provider ?? "cPanel",
        providerVersion: fixture?.metadata?.providerVersion ?? "unknown",
        accountId,
        sites: sites.map((site) => ({
          id: site.id,
          domain: site.domain,
          kind: site.kind,
          documentRoot: site.document_root ?? site.documentRoot,
          phpVersion: site.php_version ?? site.phpVersion,
          status: site.status,
        })),
        fetchedAt: new Date().toISOString(),
      };
    },

    healthCheck({ host }) {
      const endpoint = validateExternalEndpoint(host, { requireHttps: false });
      return {
        status: endpoint.valid ? "simulated_reachable" : "blocked_host",
        host: endpoint.valid ? endpoint.hostname : host,
        live: false,
        source: "mock_fixture",
        checkedAt: new Date().toISOString(),
      };
    },

    inspectSiteHealth({ site, account, snapshots = [], wpState = null }) {
      const profileName = isCapabilityProfileName(account?.capabilityProfile)
        ? account.capabilityProfile
        : "cpanel_uapi_standard";
      const capabilities = CAPABILITY_PROFILES[profileName];
      const backupCap = capabilities.find((item) => item.capability === "backups.user_archive");
      const dnsCap = capabilities.find((item) => item.capability === "dns.zone_edit");
      const whmCap = capabilities.find((item) => item.capability === "whm.account_transfer");

      const isWordPress = /wordpress|woo/i.test(site.kind);
      const needsPhpUpdate = site.phpVersion === "8.1";
      const attention = site.status === "attention";

      const sslStatus = attention
        ? { state: "expiring_soon", issuer: "cPanel Simulated AutoSSL", validUntil: "2026-12-01T00:00:00Z", note: "Simulated renewal check advised before cutover." }
        : { state: "valid", issuer: "cPanel Simulated AutoSSL", validUntil: "2027-02-15T00:00:00Z", note: "Certificate matches domain hostname (fixture)." };

      const dnsAlignment = {
        registrarManagedExternally: dnsCap?.level !== "supported",
        recordStatus: attention ? "ttl_high" : "aligned",
        note: dnsCap?.level === "supported"
          ? "Reseller zone read/edit permitted under simulated WHM scope."
          : "DNS zone is read-only/external; registrar changes stay outside cPanel user credentials.",
      };

      const defaultPending = attention ? 3 : 0;
      const wordpress = isWordPress
        ? {
          detected: true,
          simulatedCoreVersion: wpState?.coreVersion ?? "6.7.2",
          activePluginsCount: site.kind === "WooCommerce" ? 14 : 7,
          pendingUpdates: wpState ? wpState.pendingUpdates : defaultPending,
          stagingUrl: wpState?.stagingUrl ?? null,
          stagingCreatedAt: wpState?.stagingCreatedAt ?? null,
          lastRestorePointSha256: wpState?.lastRestorePointSha256 ?? null,
          lastAction: wpState?.lastAction ?? null,
          canRollback: Boolean(wpState?.previousCoreVersion),
          adminCredentialAssumption: "never_inferred_from_cpanel",
          note: "WP-CLI / consent agent required for live plugin/core changes.",
        }
        : {
          detected: false,
          simulatedCoreVersion: null,
          activePluginsCount: 0,
          pendingUpdates: 0,
          stagingUrl: null,
          stagingCreatedAt: null,
          lastRestorePointSha256: null,
          lastAction: null,
          canRollback: false,
          adminCredentialAssumption: "not_applicable",
          note: `${site.kind} workload without WordPress runtime.`,
        };

      const operations = [
        {
          id: "backup_dry_run",
          label: "Dry-run site archive",
          permitted: backupCap?.level === "supported",
          level: backupCap?.level ?? "unknown",
          reason: backupCap?.level === "supported"
            ? "Simulated site archive & checksum verification allowed under user quota."
            : backupCap?.note ?? "Site archive disabled by account plan policy.",
        },
        {
          id: "wp_preflight",
          label: isWordPress ? "WordPress health preflight" : "Runtime compatibility check",
          permitted: true,
          level: "supported",
          reason: isWordPress
            ? "Runs read-only plugin/PHP/checksum preflight without modifying wp-content."
            : "Evaluates runtime & PHP alignment from fixture inventory.",
        },
        {
          id: "dns_ssl_check",
          label: "Verify SSL & DNS alignment",
          permitted: true,
          level: dnsCap?.level ?? "read_only",
          reason: "Inspects certificate expiry and registrar delegation boundary without changing zone records.",
        },
      ];

      return {
        site,
        account: {
          id: account.id,
          label: account.label,
          host: account.host,
          capabilityProfile: profileName,
          source: account.source,
        },
        sslStatus,
        dnsAlignment,
        wordpress,
        phpGuidance: {
          current: site.phpVersion,
          recommended: needsPhpUpdate ? "8.3" : site.phpVersion,
          status: needsPhpUpdate ? "upgrade_recommended" : "current",
        },
        capabilityBoundary: {
          canPackageFullAccount: whmCap?.level === "supported",
          canArchiveSite: backupCap?.level === "supported",
          canEditDnsZones: dnsCap?.level === "supported",
        },
        operations,
        snapshots,
        live: false,
        source: "mock_fixture",
      };
    },

    executeDryRunSiteAction({ site, account, action }) {
      const profileName = account?.capabilityProfile && account.capabilityProfile in CAPABILITY_PROFILES
        ? account.capabilityProfile
        : "cpanel_uapi_standard";
      const capabilities = CAPABILITY_PROFILES[profileName];
      const backupCap = capabilities.find((item) => item.capability === "backups.user_archive");

      if (action === "backup_dry_run" && backupCap?.level !== "supported") {
        return {
          allowed: false,
          reason: "capability_restricted",
          message: backupCap?.note ?? "Site archive is disabled for this hosting account profile.",
        };
      }

      const now = new Date().toISOString();
      const checksumSha256 = sha256(`${account.id}:${site.id}:${action}:${now}`);
      const details = action === "backup_dry_run"
        ? { dryRun: true, archiveTarget: `${site.documentRoot}.dryrun.tar.gz`, verifiedChecksum: checksumSha256, live: false }
        : action === "wp_preflight"
          ? { dryRun: true, phpVersion: site.phpVersion, integrityOk: site.status === "active", wpCore: /wordpress|woo/i.test(site.kind) ? "6.7.2" : "n/a", live: false }
          : { dryRun: true, sslValid: site.status === "active", dnsZoneChangeAttempted: false, live: false };

      return {
        allowed: true,
        checksumSha256,
        details,
        createdAt: now,
      };
    },
  };
}
