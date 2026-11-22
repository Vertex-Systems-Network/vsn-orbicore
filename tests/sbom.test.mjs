import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildLockfileSbom } from "../scripts/generate-sbom.mjs";

test("ORB-015: lockfile SBOM is deterministic, complete for installed package entries, and consistently references components", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const bom = buildLockfileSbom(pkg, lock);
  const paths = Object.keys(lock.packages).filter((path) => path && path.includes("node_modules/"));
  assert.equal(bom.bomFormat, "CycloneDX");
  assert.equal(bom.specVersion, "1.5");
  assert.equal(bom.version, 1);
  assert.equal(bom.components.length, paths.length);
  assert.equal(bom.dependencies.length, paths.length + 1);
  assert.equal(Number(bom.properties[0].value), 0, "all required dependencies must resolve");
  const refs = new Set([bom.metadata.component["bom-ref"], ...bom.components.map((component) => component["bom-ref"])]);
  assert.equal(refs.size, bom.components.length + 1);
  for (const relation of bom.dependencies) {
    assert.ok(refs.has(relation.ref), "unknown source reference");
    assert.deepEqual([...relation.dependsOn].sort(), relation.dependsOn);
    for (const target of relation.dependsOn) assert.ok(refs.has(target), "unknown dependency reference");
  }
  const canIUse = bom.components.find((component) => component.name === "caniuse-lite");
  assert.deepEqual(canIUse.licenses, [{ expression: "CC-BY-4.0" }]);
  assert.equal(JSON.stringify(bom), JSON.stringify(buildLockfileSbom(pkg, lock)));
  assert.equal(bom.compositions[0].aggregate, "incomplete", "lockfile only is not a deployed-system inventory");
});

test("ORB-015: nested resolution is deterministic; optional peers are not reported as broken", () => {
  const pkg = { name: "test-app", version: "1.0.0" };
  const lock = {
    packages: {
      "": { name: "test-app", version: "1.0.0", dependencies: { a: "^1", b: "^1" } },
      "node_modules/a": {
        version: "1.0.0", dependencies: { b: "^2" }, 
        peerDependencies: { missingPeer: "^1" },
        peerDependenciesMeta: { missingPeer: { optional: true } },
        optionalDependencies: { missingPlatformPackage: "^1" },
      },
      "node_modules/b": { version: "1.0.0" },
      "node_modules/a/node_modules/b": { version: "2.0.0" },
    },
  };
  const bom = buildLockfileSbom(pkg, lock);
  const a = bom.dependencies.find((record) => record.ref === "lockfile:node_modules/a");
  assert.deepEqual(a.dependsOn, ["lockfile:node_modules/a/node_modules/b"]);
  assert.equal(Number(bom.properties[0].value), 0);
  lock.packages["node_modules/a"].dependencies.criticalMissing = "^1";
  assert.equal(Number(buildLockfileSbom(pkg, lock).properties[0].value), 1);
  assert.throws(() => buildLockfileSbom({ name: "wrong", version: "1.0.0" }, lock), /Root package metadata/);
});

test("ORB-010: CI runs an official-schema validation gate before distributing the generated BOM", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const exporter = workflow.indexOf("run: node scripts/generate-sbom.mjs");
  const validator = workflow.indexOf("run: python scripts/verify-cyclonedx-schema.py .data/ci/orbicore-sbom.cdx.json");
  const publish = workflow.indexOf("name: Upload SBOM artifact");
  assert.ok(exporter >= 0 && validator > exporter && publish > validator, "schema validation must precede publishing");
  assert.match(workflow, /jsonschema==4\.25\.1/, "validator version must be pinned");
  assert.match(workflow.slice(publish, publish + 90), /if: success\(\)/, "invalid BOM must not be published");
});
