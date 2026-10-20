import json
import tempfile
import unittest
from pathlib import Path

from dev_build_origin import check, git, write


class BuildOriginTests(unittest.TestCase):
    def test_old_checkout_cannot_replace_newer_dev(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            self.assertEqual(git(repo, "init").returncode, 0)
            git(repo, "config", "user.name", "Build test")
            git(repo, "config", "user.email", "build-test@local.invalid")
            (repo / "VERSION").write_text("fixture")
            git(repo, "add", "VERSION")
            self.assertEqual(git(repo, "-c", "commit.gpgsign=false", "commit", "-m", "base").returncode, 0)
            base = git(repo, "rev-parse", "HEAD").stdout.strip()
            manifest = repo / "origin.json"
            write(repo, manifest)
            check(repo, manifest)
            (repo / "VERSION").write_text("newer")
            git(repo, "add", "VERSION")
            git(repo, "-c", "commit.gpgsign=false", "commit", "-m", "newer")
            check(repo, manifest)  # A descendant can update the installed base.
            write(repo, manifest)
            git(repo, "checkout", "--detach", base)
            with self.assertRaisesRegex(ValueError, "阻止旧代码覆盖"):
                check(repo, manifest)
            self.assertEqual((repo / "VERSION").read_text(), "fixture")

    def test_first_install_and_corrupt_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            manifest = repo / "origin.json"
            check(repo, manifest)
            manifest.write_text(json.dumps({"gitHead": "invalid"}))
            with self.assertRaisesRegex(ValueError, "来源记录无效"):
                check(repo, manifest)


if __name__ == "__main__":
    unittest.main()
