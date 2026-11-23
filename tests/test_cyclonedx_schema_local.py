"""Verify immutable vendored CycloneDX schemas without a network connection."""
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

CHECKER = Path(__file__).resolve().parents[1] / "scripts" / "verify-cyclonedx-schema.py"
spec = importlib.util.spec_from_file_location("orbicore_offline_schema_validator", CHECKER)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class OfflineSchemaPinTests(unittest.TestCase):
    def test_three_official_schema_files_match_pinned_git_blobs(self):
        self.assertEqual(len(checker.SCHEMA_SHA), 3)
        for name, sha in checker.SCHEMA_SHA.items():
            parsed = checker.load_pinned_schema(name, sha)
            self.assertEqual(parsed["$id"], checker.SCHEMA_ROOT + name)
            self.assertEqual(parsed["$schema"], "http://json-schema.org/draft-07/schema#")

    def test_corrupted_schema_fails_closed(self):
        name = "spdx.schema.json"
        original = (checker.PINNED_SCHEMA_DIR / name).read_bytes()
        with tempfile.TemporaryDirectory() as location:
            root = Path(location)
            (root / name).write_bytes(original.replace(b"0BSD", b"INVALID", 1))
            with patch.object(checker, "PINNED_SCHEMA_DIR", root):
                with self.assertRaisesRegex(ValueError, "differs from pinned official blob"):
                    checker.load_pinned_schema(name, checker.SCHEMA_SHA[name])

    def test_missing_file_does_not_trigger_download(self):
        with tempfile.TemporaryDirectory() as location:
            with patch.object(checker, "PINNED_SCHEMA_DIR", Path(location)):
                with self.assertRaises(FileNotFoundError):
                    checker.load_pinned_schema("bom-1.5.schema.json", checker.SCHEMA_SHA["bom-1.5.schema.json"])

    def test_unknown_schema_file_rejected(self):
        with self.assertRaisesRegex(ValueError, "Unrecognized CycloneDX schema"):
            checker.load_pinned_schema("other-schema.json", "deadbeef")


if __name__ == "__main__":
    unittest.main()
