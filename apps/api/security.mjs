import { isIP } from "node:net";
import { resolve, sep } from "node:path";

const SENSITIVE_KEYS = new Set([
  "password",
  "password_hash",
  "password_salt",
  "token",
  "token_hash",
  "secret",
  "encrypted_secret",
  "api_key",
  "apikey",
  "authorization",
  "cookie",
  "set-cookie",
  "recovery_codes",
  "recoverycodes",
  "private_key",
  "mfa_key",
]);

function isBlockedIPv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedIPv6(ip) {
  // Canonicalize a *validated* IPv6 literal before any prefix check. In
  // particular ::ffff:10.0.0.1, ::ffff:a00:1 and the fully expanded form
  // denote the same address, but only dotted IPv4 was screened previously.
  let normalized;
  try {
    normalized = new URL(`https://[${ip}]/`).hostname.slice(1, -1).toLowerCase();
  } catch {
    return true;
  }
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  // WHATWG URL normalizes IPv4-mapped IPv6 into two trailing hexadecimal
  // groups. Recover all four IPv4 octets before applying the IPv4 deny list.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (mapped) {
    const hi = Number.parseInt(mapped[1], 16);
    const lo = Number.parseInt(mapped[2], 16);
    return isBlockedIPv4([hi >> 8, hi & 255, lo >> 8, lo & 255].join("."));
  }
  return false;
}

export function isBlockedNetworkAddress(hostOrIp) {
  // A fully-qualified DNS hostname can end in a root dot. Trim it before
  // applying suffix / address checks, or localhost. and *.internal. would
  // evade the same restriction as their ordinary DNS spellings. Normalize
  // IDNA-recognized alternative dot characters for direct helper callers.
  const clean = String(hostOrIp ?? "").trim().replace(/^\[|\]$/g, "")
    .replace(/[\u3002\uFF0E\uFF61]/gu, ".")
    .replace(/\.+$/u, "").toLowerCase();
  if (!clean) return true;
  if (clean === "localhost" || clean.endsWith(".localhost") ||
      clean.endsWith(".local") || clean.endsWith(".internal") ||
      clean.endsWith(".localdomain")) {
    return true;
  }
  const version = isIP(clean);
  if (version === 4) return isBlockedIPv4(clean);
  if (version === 6) return isBlockedIPv6(clean);
  return false;
}

// Accept only a bare cPanel API hostname. A URL-shaped "host" such as
// cp.example.org/path could otherwise resolve to HTTPS port 443 when callers
// append :2083, silently moving a credentialed UAPI request off its fixed port.
// Do not infer safety from a syntactically valid arbitrary URL alone.
export function validateCpanelApiHost(input) {
  if (typeof input !== "string" || input.length < 1 || input.length > 253 ||
      input !== input.trim()) {
    return { valid: false, reason: "invalid_cpanel_host" };
  }
  const bracketedIpv6 = /^\\[[0-9a-f:.]+\\]$/i.test(input);
  const dnsOrIpv4 = /^[\\p{L}\\p{N}._-]+$/u.test(input);
  if (!bracketedIpv6 && !dnsOrIpv4) {
    return { valid: false, reason: "invalid_cpanel_host" };
  }
  const endpoint = validateExternalEndpoint(`https://${input}:2083`, { requireHttps: true });
  if (!endpoint.valid) return endpoint;
  // Explicitly enforce the provider port even if URL interpretation changes.
  if (new URL(endpoint.origin).port !== "2083") {
    return { valid: false, reason: "invalid_cpanel_host" };
  }
  return endpoint;
}

export function validateExternalEndpoint(input, { allowedHosts = null, requireHttps = true } = {}) {
  if (typeof input !== "string" || input.length < 4 || input.length > 512) {
    return { valid: false, reason: "invalid_endpoint_length" };
  }
  let parsed;
  try {
    parsed = new URL(input.includes("://") ? input : `https://${input}`);
  } catch {
    return { valid: false, reason: "invalid_url" };
  }
  if (requireHttps && parsed.protocol !== "https:") {
    return { valid: false, reason: "https_required" };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { valid: false, reason: "unsupported_protocol" };
  }
  if (parsed.username || parsed.password) {
    return { valid: false, reason: "embedded_credentials_forbidden" };
  }
  const hostname = parsed.hostname.toLowerCase();
  if (isBlockedNetworkAddress(hostname)) {
    return { valid: false, reason: "blocked_private_or_loopback_host" };
  }
  if (Array.isArray(allowedHosts) && allowedHosts.length > 0) {
    const matched = allowedHosts.some((allowed) => {
      const target = allowed.toLowerCase();
      return hostname === target || hostname.endsWith(`.${target}`);
    });
    if (!matched) return { valid: false, reason: "host_not_in_allowlist" };
  }
  return { valid: true, hostname, origin: parsed.origin };
}

export function resolveContainedPath(baseDir, untrustedPath) {
  if (typeof untrustedPath !== "string" || untrustedPath.includes("\0") || untrustedPath.trim() === "") {
    throw Object.assign(new Error("Invalid filesystem path."), { code: "INVALID_PATH" });
  }
  const normalizedBase = resolve(baseDir);
  const relative = untrustedPath.replace(/^[/\\]+/, "");
  const resolved = resolve(normalizedBase, relative);
  if (resolved !== normalizedBase && !resolved.startsWith(`${normalizedBase}${sep}`)) {
    throw Object.assign(new Error("Path escapes permitted base directory."), { code: "PATH_TRAVERSAL" });
  }
  return resolved;
}

export function redactSecrets(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, depth + 1));
  if (typeof value !== "object") return value;
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = redactSecrets(entry, depth + 1);
    }
  }
  return output;
}

export const CAPABILITY_PROFILES = {
  cpanel_uapi_standard: [
    { capability: "domains.read", level: "supported", note: "UAPI DomainInfo::domains_data" },
    { capability: "websites.inventory", level: "supported", note: "Document roots & PHP versions" },
    { capability: "quotas.read", level: "supported", note: "Quota::get_quota_info" },
    { capability: "backups.user_archive", level: "supported", note: "Site/home backup within user quota" },
    { capability: "dns.zone_edit", level: "read_only", note: "Requires ZoneEditor API & registrar delegation" },
    { capability: "whm.account_transfer", level: "requires_whm", note: "Not available from cPanel user credentials" },
    { capability: "filesystem.ssh_rsync", level: "requires_ssh", note: "Disabled by default on shared cPanel" },
    { capability: "storage.block_mount", level: "not_available", note: "Shared hosting disks cannot be mounted" },
  ],
  cpanel_uapi_restricted: [
    { capability: "domains.read", level: "supported", note: "UAPI DomainInfo::domains_data" },
    { capability: "websites.inventory", level: "supported", note: "Read-only site listing" },
    { capability: "quotas.read", level: "supported", note: "Disk/inode summary" },
    { capability: "backups.user_archive", level: "not_available", note: "Disabled by hosting plan policy" },
    { capability: "dns.zone_edit", level: "not_available", note: "External DNS provider manages records" },
    { capability: "whm.account_transfer", level: "requires_whm", note: "Not available from cPanel user credentials" },
    { capability: "filesystem.ssh_rsync", level: "requires_ssh", note: "Shell access disabled" },
    { capability: "storage.block_mount", level: "not_available", note: "Shared hosting disks cannot be mounted" },
  ],
  whm_reseller: [
    { capability: "domains.read", level: "supported", note: "WHM + UAPI delegation" },
    { capability: "websites.inventory", level: "supported", note: "Multi-account site discovery" },
    { capability: "quotas.read", level: "supported", note: "Reseller & account quotas" },
    { capability: "backups.user_archive", level: "supported", note: "Scoped account archive" },
    { capability: "dns.zone_edit", level: "supported", note: "WHM DNS zone operations" },
    { capability: "whm.account_transfer", level: "supported", note: "Reseller-scoped account packaging" },
    { capability: "filesystem.ssh_rsync", level: "requires_ssh", note: "Requires explicit SSH key grant" },
    { capability: "storage.block_mount", level: "not_available", note: "Use S3-compatible object storage instead" },
  ],
};
