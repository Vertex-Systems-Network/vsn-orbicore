import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const ALLOWED_LICENSES = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "BlueOak-1.0.0"]);
// Reviewed per-package/data-license exceptions, pinned to the inspected lockfile version.
// Each exception must have a matching attribution notice in docs/THIRD_PARTY_NOTICES.md.
const REVIEWED_LICENSE_EXCEPTIONS = new Map([
  ["caniuse-lite@1.0.30001823", "CC-BY-4.0"],
]);

const SECRET_PATTERNS = [
  { name: "private_key_pem", regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/ },
  { name: "aws_access_key", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "github_pat", regex: /\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/ },
  { name: "gitlab_pat", regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { name: "stripe_live_secret", regex: /\bsk_live_[A-Za-z0-9]{24,}\b/ },
  { name: "npm_auth_token", regex: /(?:^|\n)\s*(?:\/\/[^\s]+\/:)?_authToken\s*=\s*[A-Za-z0-9._=-]{20,}/ },
  { name: "cpanel_token_auth_header", regex: /Authorization:\s*cpanel\s+[a-z0-9_-]+:[A-Za-z0-9]{16,}/i },
];

const SCAN_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".json", ".jsonc",
  ".sql", ".yml", ".yaml", ".md", ".mdx", ".txt", ".toml",
  ".py", ".sh", ".bash", ".zsh", ".ps1", ".conf", ".ini", ".cfg",
  ".pem", ".key", ".tf", ".hcl", ".properties", ".xml", ".html",
  ".css", ".scss", ".lock", ".graphql", ".gql", ".rb", ".php",
]);
const SCAN_FILENAMES = new Set(["Dockerfile", "Makefile", ".npmrc", ".pypirc"]);
const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", ".data", "coverage", ".next"]);

function eligibleForScan(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return SCAN_EXTENSIONS.has(extname(name))
    || SCAN_FILENAMES.has(name)
    || name === ".env" || name.startsWith(".env.");
}

function walkFallback(dir, root, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) walkFallback(full, root, files);
    else if (entry.isFile()) files.push(relative(root, full).split("\\").join("/"));
  }
  return files;
}

// Scan the actual committed checkout, including docs, workflows, .env variants
// and root-level configs. Generated/untracked runtime files must never be part
// of the GitHub CI source integrity claim. Fixture roots without Git use a
// symlink-safe recursive fallback so unit tests exercise the same rules.
function trackedSourceFiles(root) {
  try {
    const output = execFileSync("git", ["ls-files", "-z", "--cached"], {
      cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
    });
    return output.split("\0").filter(Boolean).sort();
  } catch {
    return walkFallback(root, root).sort();
  }
}

export function isAllowedSpdxExpression(expression) {
  if (typeof expression !== "string" || !expression.trim()) return false;
  const tokens = expression.match(/\(|\)|\bAND\b|\bOR\b|[A-Za-z0-9.+-]+/g);
  if (!tokens || tokens.join("") !== expression.replace(/\s+/g, "")) return false;
  let index = 0;
  const factor = () => {
    if (tokens[index] === "(") {
      index++;
      const value = orExpr();
      if (tokens[index] !== ")") throw new Error("Unclosed license group");
      index++;
      return value;
    }
    const token = tokens[index++];
    if (!token || token === ")" || token === "AND" || token === "OR") throw new Error("Malformed SPDX license token");
    return ALLOWED_LICENSES.has(token);
  };
  const andExpr = () => {
    let value = factor();
    while (tokens[index] === "AND") {
      index++;
      const other = factor();
      value = value && other; // AND requires ALL terms to be permitted.
    }
    return value;
  };
  const orExpr = () => {
    let value = andExpr();
    while (tokens[index] === "OR") {
      index++;
      const other = andExpr();
      value = value || other; // OR permits one complete approved branch.
    }
    return value;
  };
  try {
    const approved = orExpr();
    return index === tokens.length && approved;
  } catch {
    return false;
  }
}

export function runSupplyChainGate(rootDir = resolve(".")) {
  const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
  const lockPath = join(rootDir, "package-lock.json");
  const components = [];
  const disallowedLicenses = [];
  const reviewedLicenseExceptions = [];

  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    for (const [pkgPath, meta] of Object.entries(lock.packages ?? {})) {
      if (!pkgPath || !pkgPath.startsWith("node_modules/")) continue;
      const name = pkgPath.replace(/^node_modules\//, "");
      const license = meta.license ?? "UNKNOWN";
      components.push({ name, version: meta.version ?? "unknown", license });
      if (REVIEWED_LICENSE_EXCEPTIONS.get(`${name}@${meta.version}`) === license) {
        reviewedLicenseExceptions.push({ name, version: meta.version, license });
      } else if (license !== "UNKNOWN" && !isAllowedSpdxExpression(license)) {
        disallowedLicenses.push({ name, version: meta.version, license });
      }
    }
  } else {
    for (const [name, version] of Object.entries({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) })) {
      components.push({ name, version, license: "manifest_only" });
    }
  }

  const secretFindings = [];
  let scannedFiles = 0;
  const root = resolve(rootDir);
  for (const path of trackedSourceFiles(root)) {
    const normalized = path.split("\\").join("/");
    if (!eligibleForScan(normalized)) continue;
    const full = resolve(root, normalized);
    if (full !== root && !full.startsWith(root + "/")) {
      secretFindings.push({ file: normalized, rule: "invalid_source_path" });
      continue;
    }
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) continue; // Never follow a tracked link out of this checkout.
    if (!stat.isFile()) continue;
    if (stat.size > MAX_SCAN_BYTES) {
      secretFindings.push({ file: normalized, rule: "source_file_exceeds_scan_limit" });
      continue;
    }
    const content = readFileSync(full, "utf8");
    scannedFiles++;
    for (const pat of SECRET_PATTERNS) {
      if (pat.regex.test(content)) secretFindings.push({ file: normalized, rule: pat.name });
    }
  }

  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    metadata: { component: { name: pkg.name, version: pkg.version, type: "application" } },
    componentsCount: components.length,
    components: components.slice(0, 200),
  };

  return {
    passed: secretFindings.length === 0 && disallowedLicenses.length === 0,
    secretFindings,
    scannedFiles,
    scanScope: "git-tracked-recognized-text-files",
    disallowedLicenses,
    reviewedLicenseExceptions,
    sbomSummary: {
      bomFormat: sbom.bomFormat,
      specVersion: sbom.specVersion,
      componentsCount: sbom.componentsCount,
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = runSupplyChainGate();
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exit(1);
}
