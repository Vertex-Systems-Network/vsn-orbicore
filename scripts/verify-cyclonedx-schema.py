#!/usr/bin/env python3
"""Validate an npm-lockfile SBOM against authentic, byte-pinned CycloneDX 1.5 schemas.

CI-only tool: no live provider, secret, or deployed runtime discovery.
The upstream schema files are downloaded from an immutable upstream commit.
Each payload must also match its expected Git blob SHA-1 before parsing.
"""
from __future__ import annotations

import copy
import hashlib
import json
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from jsonschema import Draft7Validator, FormatChecker
from referencing import Registry, Resource

SPEC_COMMIT = "5fee6af48d43c751dc6a5b31138f06af2b10bac5"
SPEC_REPO = "https://raw.githubusercontent.com/CycloneDX/specification"
SCHEMA_SHA = {
    "bom-1.5.schema.json": "d9c4d08031d45ecf0c4b2f6fcac8eeb8c9e78a65",
    "spdx.schema.json": "566c4a32518c60778e55a56ccf71bf781320b279",
    "jsf-0.82.schema.json": "f46bfb1e52731ad1280123ff3e2bd29bd18d4bc2",
}
SCHEMA_ROOT = "http://cyclonedx.org/schema/"
MAX_SCHEMA_BYTES = 512 * 1024


def fetch_schema(name: str, expected_sha: str) -> dict:
    url = f"{SPEC_REPO}/{SPEC_COMMIT}/schema/{name}"
    request = Request(url, headers={"User-Agent": "vsn-orbicore-ci-cyclonedx-validator"})
    with urlopen(request, timeout=25) as response:
        data = response.read(MAX_SCHEMA_BYTES + 1)
    if len(data) > MAX_SCHEMA_BYTES:
        raise ValueError(f"Upstream {name} schema exceeds the pinned size limit")
    blob = b"blob " + str(len(data)).encode("ascii") + b"\0" + data
    actual_sha = hashlib.sha1(blob).hexdigest()  # Git's immutable blob object ID
    if actual_sha != expected_sha:
        raise ValueError(f"Upstream {name} schema differs from pinned official blob")
    parsed = json.loads(data)
    if parsed.get("$id") != SCHEMA_ROOT + name:
        raise ValueError(f"Upstream {name} has an unexpected schema identifier")
    if parsed.get("$schema") != "http://json-schema.org/draft-07/schema#":
        raise ValueError(f"Upstream {name} does not declare JSON Schema draft-07")
    return parsed


def load_validator() -> Draft7Validator:
    schemas = {name: fetch_schema(name, sha) for name, sha in SCHEMA_SHA.items()}
    registry = Registry()
    for schema in schemas.values():
        registry = registry.with_resource(schema["$id"], Resource.from_contents(schema))
    root = schemas["bom-1.5.schema.json"]
    Draft7Validator.check_schema(root)
    return Draft7Validator(root, registry=registry, format_checker=FormatChecker())


def validation_summary(validator: Draft7Validator, bom: dict) -> list[str]:
    return [
        "/".join(str(part) for part in error.absolute_path) + ":" + str(error.validator)
        for error in validator.iter_errors(bom)
    ]


def graph_checks(bom: dict, lockfile: dict) -> None:
    if bom.get("specVersion") != "1.5":
        raise ValueError("SBOM must use CycloneDX specification 1.5")
    if bom.get("compositions") != [{"aggregate": "incomplete"}]:
        raise ValueError("Lockfile data cannot claim deployed-system completeness")
    if {"name": "vsn:inventory-scope", "value": "npm-package-lock"} not in bom.get("metadata", {}).get("properties", []):
        raise ValueError("SBOM is not identified as a lockfile-only inventory")
    if any(p.get("name") == "vsn:unresolved-dependency-count" and p.get("value") != "0"
           for p in bom.get("properties", [])):
        raise ValueError("Required npm graph dependencies remain unresolved")
    root = bom["metadata"]["component"]["bom-ref"]
    refs = [root] + [item["bom-ref"] for item in bom["components"]]
    if len(set(refs)) != len(refs):
        raise ValueError("SBOM has duplicate bom-ref components")
    dependency_refs = [d["ref"] for d in bom["dependencies"]]
    if set(dependency_refs) != set(refs) or len(dependency_refs) != len(refs):
        raise ValueError("SBOM dependency entries do not cover exactly the locked components")
    if any(ref not in refs for item in bom["dependencies"] for ref in item["dependsOn"]):
        raise ValueError("SBOM dependency references a missing component")
    locked = [path for path in lockfile["packages"] if path and "node_modules/" in path]
    if len(bom["components"]) != len(locked):
        raise ValueError("SBOM component count differs from the npm lockfile")


def assert_negative_fixtures(validator: Draft7Validator, bom: dict) -> None:
    # Test the actual official validator, not an independent set of assertions.
    broken_format = copy.deepcopy(bom)
    broken_format["bomFormat"] = "not-CycloneDX"
    unexpected_field = copy.deepcopy(bom)
    unexpected_field["unexpectedSecretField"] = "not-allowed"
    broken_component = copy.deepcopy(bom)
    broken_component["components"][0].pop("name", None)
    for label, fixture in [
        ("invalid-format", broken_format),
        ("unexpected-top-level-property", unexpected_field),
        ("missing-component-name", broken_component),
    ]:
        if not validation_summary(validator, fixture):
            raise AssertionError(f"Official schema failed to reject {label} negative fixture")


def main() -> int:
    if len(sys.argv) != 2:
        raise ValueError("Usage: python scripts/verify-cyclonedx-schema.py <sbom.cdx.json>")
    bom_path = Path(sys.argv[1])
    if not bom_path.is_file():
        raise ValueError("Generated SBOM is missing; generation must run before validation")
    bom = json.loads(bom_path.read_text(encoding="utf-8"))
    lockfile = json.loads(Path("package-lock.json").read_text(encoding="utf-8"))
    validator = load_validator()
    problems = validation_summary(validator, bom)
    if problems:
        raise ValueError("Official CycloneDX 1.5 schema rejected generated BOM: " + ", ".join(problems[:10]))
    graph_checks(bom, lockfile)
    assert_negative_fixtures(validator, bom)
    print(json.dumps({
        "cyclonedxSchemaValidated": True,
        "schemaVersion": "1.5",
        "officialSchemaCommit": SPEC_COMMIT,
        "lockedSchemaFiles": len(SCHEMA_SHA),
        "componentCount": len(bom["components"]),
        "negativeFixturesRejected": 3,
        "deploymentScope": "npm-lockfile-only",
    }))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, AssertionError, HTTPError, URLError, OSError, KeyError, TypeError) as error:
        print(f"CycloneDX schema validation failed: {error}", file=sys.stderr)
        sys.exit(1)
