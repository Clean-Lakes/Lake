import json
import tempfile
import unittest
from pathlib import Path

from dev_build_origin import check, git, write


class BuildOriginTests(unittest.TestCase):
    def test_squash_preserves_installed_baseline_without_ancestry(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            git(repo, "init")
            git(repo, "config", "user.name", "Build test")
            git(repo, "config", "user.email", "build-test@local.invalid")
            (repo / "VERSION").write_text("fixture")
            (repo / "docs").mkdir()
            (repo / "docs/validation.md").write_text("before validation")
            git(repo, "add", ".")
            git(repo, "-c", "commit.gpgsign=false", "commit", "-m", "base")
            base = git(repo, "rev-parse", "HEAD").stdout.strip()
            git(repo, "checkout", "-b", "feature")
            (repo / "runtime.go").write_text("validated implementation")
            git(repo, "add", "runtime.go")
            git(repo, "-c", "commit.gpgsign=false", "commit", "-m", "feature")
            installed = git(repo, "rev-parse", "HEAD").stdout.strip()
            manifest = Path(directory).parent / (repo.name + "-origin.json")
            try:
                write(repo, manifest)
                git(repo, "checkout", "-b", "integration", base)
                git(repo, "merge", "--squash", "feature")
                (repo / "docs/validation.md").write_text("retained integration evidence")
                git(repo, "add", "docs/validation.md")
                git(repo, "-c", "commit.gpgsign=false", "commit", "-m", "squash")
                self.assertNotEqual(git(repo, "merge-base", "--is-ancestor", installed, "HEAD").returncode, 0)
                check(repo, manifest)
                # Normal updates on top of the equivalent squash are allowed.
                (repo / "runtime.go").write_text("subsequent implementation")
                git(repo, "add", "runtime.go")
                git(repo, "-c", "commit.gpgsign=false", "commit", "-m", "next")
                check(repo, manifest)
                # The same content claim cannot prove an installed dirty tree.
                data = json.loads(manifest.read_text())
                data["dirty"] = True
                manifest.write_text(json.dumps(data))
                with self.assertRaisesRegex(ValueError, "阻止旧代码覆盖"):
                    check(repo, manifest)
                data["dirty"] = False
                manifest.write_text(json.dumps(data))
                # A divergent checkout with modified/deleted installed source
                # has no equivalent baseline, even if it adds other new files.
                git(repo, "checkout", "-b", "divergent", base)
                (repo / "runtime.go").write_text("older implementation")
                git(repo, "add", "runtime.go")
                git(repo, "-c", "commit.gpgsign=false", "commit", "-m", "divergent")
                with self.assertRaisesRegex(ValueError, "阻止旧代码覆盖"):
                    check(repo, manifest)
                git(repo, "rm", "runtime.go")
                git(repo, "-c", "commit.gpgsign=false", "commit", "-m", "remove")
                with self.assertRaisesRegex(ValueError, "阻止旧代码覆盖"):
                    check(repo, manifest)
            finally:
                manifest.unlink(missing_ok=True)

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
