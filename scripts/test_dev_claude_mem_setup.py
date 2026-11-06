import os
from pathlib import Path
import tempfile
import unittest
from setup_lake_claude_mem import private_path


class ClaudeMemDevIsolation(unittest.TestCase):
    def test_rejects_release_home_and_descendants(self):
        with tempfile.TemporaryDirectory() as directory:
            release = Path(directory) / ".lake"
            release.mkdir()
            for target in (release, release / "claude-mem"):
                with self.assertRaises(ValueError):
                    private_path(target, release)

    def test_rejects_symlinked_engine(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "actual").mkdir()
            (root / "engine").symlink_to(root / "actual")
            with self.assertRaises(ValueError):
                private_path(root / "engine", root / ".lake")

    def test_uses_private_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            private_path(root / "index", root / ".lake")
            self.assertEqual((root / "index").stat().st_mode & 0o777, 0o700)
            self.assertEqual((root / "index").stat().st_uid, os.getuid())
