import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function packageName(path, metadata) {
  if (typeof metadata.name === "string" && metadata.name) return metadata.name;
  return path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
}

function findInstalledPath(packages, parentPath, dependencyName) {
  let cursor = parentPath;
  while (true) {
    const candidate = cursor ? cursor + "/node_modules/" + dependencyName : "node_modules/" + dependencyName;
    if (Object.hasOwn(packages, candidate)) return candidate;
    if (!cursor) return null;
    const parentAt = cursor.lastIndexOf("/node_modules/");
    cursor = parentAt < 0 ? "" : cursor.slice(0, parentAt);
  }
}

function normalizedDependencies(meta, isRoot) {
  return Object.keys({
    ...(meta.dependencies ?? {}),
    ...(meta.optionalDependencies ?? {}),
    ...(meta.peerDependencies ?? {}),
    ...(isRoot ? meta.devDependencies ?? {} : {}),
  }).sort();
}

function componentFromEntry(path, meta) {
  if (typeof meta.version !== "string" || !meta.version) {
    throw new Error("Missing locked version at " + path);
  }
  const component = {
    type: "library",
    name: packageName(path, meta),
    version: meta.version,
    "bom-ref": "lockfile:" + path,
  };
  if (typeof meta.license === "string" && meta.license && meta.license !== "UNKNOWN") {
    component.licenses = [{ expression: meta.license }];
  }
  if (typeof meta.integrity === "string") {
    const match = /^sha(256|384|512)-([A-Za-z0-9+/=]+)$/.exec(meta.integrity);
    if (match) {
      const alg = "SHA-" + match[1];
      component.hashes = [{ alg, content: Buffer.from(match[2], "base64").toString("hex") }];
    }
  }
  return component;
}

/**
 * Deterministic, lockfile-scoped CycloneDX JSON 1.5 SBOM.
 * This inventories the npm dependency graph; optional/peer and runtime loaded
 * dependencies can differ, so do not claim it is a complete deployed-system BOM.
 */
export function buildLockfileSbom(packageJson, lockfile) {
  if (!lockfile || typeof lockfile.packages !== "object" || !Object.hasOwn(lockfile.packages, "")) {
    throw new Error("A package-lock.json with a root package and lockfile packages is required");
  }
  const packages = lockfile.packages;
  const paths = Object.keys(packages).filter((path) => path && path.includes("node_modules/")).sort();
  const rootMeta = packages[""];
  if (rootMeta.name !== packageJson.name || rootMeta.version !== packageJson.version) {
    throw new Error("Root package metadata differs from package-lock.json");
  }
  const rootRef = "application:" + packageJson.name + "@" + packageJson.version;
  const components = paths.map((path) => componentFromEntry(path, packages[path]));
  const unresolved = [];
  const roots = ["", ...paths];
  const dependencies = roots.map((path) => {
    const meta = packages[path];
    const dependedOn = normalizedDependencies(meta, path === "").map((dependencyName) => {
      const targetPath = findInstalledPath(packages, path, dependencyName);
      if (!targetPath) {
        unresolved.push({ parent: path || ".", dependency: dependencyName });
        return null;
      }
      return "lockfile:" + targetPath;
    }).filter(Boolean);
    return { ref: path ? "lockfile:" + path : rootRef, dependsOn: [...new Set(dependedOn)].sort() };
  });
  const knownRefs = new Set([rootRef, ...components.map((c) => c["bom-ref"])]);
  for (const dependency of dependencies) {
    if (!knownRefs.has(dependency.ref) || dependency.dependsOn.some((ref) => !knownRefs.has(ref))) {
      throw new Error("SBOM dependency graph contains an unknown reference");
    }
  }
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      component: {
        type: "application",
        name: packageJson.name,
        version: packageJson.version,
        "bom-ref": rootRef,
      },
      properties: [{ name: "vsn:inventory-scope", value: "npm-package-lock" }],
    },
    components,
    dependencies,
    // An npm lockfile does not prove shipped/runtime assets or optional install behavior.
    compositions: [{ aggregate: "incomplete" }],
    properties: [{ name: "vsn:unresolved-dependency-count", value: String(unresolved.length) }],
  };
}

export function generateSbom(rootDir = resolve("."), outputPath = resolve(".data/ci/orbicore-sbom.cdx.json")) {
  const pkg = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(resolve(rootDir, "package-lock.json"), "utf8"));
  const bom = buildLockfileSbom(pkg, lock);
  const serialized = JSON.stringify(bom, null, 2) + "\n";
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serialized, { mode: 0o644 });
  return {
    path: outputPath,
    sha256: createHash("sha256").update(serialized).digest("hex"),
    components: bom.components.length,
    dependencyEntries: bom.dependencies.length,
    unresolvedDependencies: Number(bom.properties[0].value),
    specVersion: bom.specVersion,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = generateSbom(resolve("."), resolve(process.argv[2] ?? ".data/ci/orbicore-sbom.cdx.json"));
  console.log(JSON.stringify(result));
  // A missing installed dependency is an invalid graph for this source package.
  if (result.unresolvedDependencies !== 0) process.exitCode = 1;
}
