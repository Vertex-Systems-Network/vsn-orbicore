import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const ALLOWED_LICENSES = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "BlueOak-1.0.0"]);
// Reviewed per-package/data-license exceptions, pinned to the inspected lockfile version.
// Each exception must have a matching attribution notice in docs/THIRD_PARTY_NOTICES.md.
const REVIEWED_LICENSE_EXCEPTIONS = new Map([
  ["caniuse-lite@1.0.30001823", "CC-BY-4.0"],
]);

const SECRET_PATTERNS = [
  { name: "private_key_pem", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "aws_access_key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "github_pat", regex: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "cpanel_token_auth_header", regex: /Authorization:\s*cpanel\s+[a-z0-9_-]+:[A-Za-z0-9]{16,}/i },
];

function walkFiles(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, files);
    else if ([".js", ".mjs", ".ts", ".tsx", ".json", ".sql", ".yml", ".yaml"].includes(extname(entry.name))) files.push(full);
  }
  return files;
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
      } else if (license !== "UNKNOWN" && !ALLOWED_LICENSES.has(license)) {
        const parts = license.split(/\s+OR\s+|\s+AND\s+/).map((s) => s.replace(/[()]/g, "").trim());
        if (!parts.some((p) => ALLOWED_LICENSES.has(p))) {
          disallowedLicenses.push({ name, version: meta.version, license });
        }
      }
    }
  } else {
    for (const [name, version] of Object.entries({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) })) {
      components.push({ name, version, license: "manifest_only" });
    }
  }

  const secretFindings = [];
  for (const targetDir of ["apps", "scripts", "tests", "db"]) {
    for (const file of walkFiles(join(rootDir, targetDir))) {
      const content = readFileSync(file, "utf8");
      for (const pat of SECRET_PATTERNS) {
        if (pat.regex.test(content)) {
          secretFindings.push({ file: file.replace(`${rootDir}/`, ""), rule: pat.name });
        }
      }
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
