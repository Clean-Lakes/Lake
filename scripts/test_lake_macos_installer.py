#!/usr/bin/env python3
"""Exercise the shipped installer against isolated fake apps and launchers."""
import pathlib
import plistlib
import shlex
import subprocess
import tempfile
import unittest

INSTALLER = pathlib.Path(__file__).resolve().parents[1] / "client/macos/Resources/install-update.sh"


class InstallerTests(unittest.TestCase):
    def scenario(self, behavior, missing_stage=False, typescript=False, migration="exit 0", missing_home=False):
        with tempfile.TemporaryDirectory(prefix="lake installer ' spaces ") as directory:
            root = pathlib.Path(directory)
            target, stage, backup, work = (root / name for name in ["Lake.app", "next.app", "backup.app", "work"])
            target.mkdir()
            (target / "version").write_text("old")
            if not missing_stage:
                stage.mkdir()
                (stage / "version").write_text("new")
            work.mkdir()
            home = root / "isolated-home"
            home.mkdir()
            (home / "original-record").write_text("preserved")
            migration_args = root / "migration-args"
            if typescript and not missing_stage:
                resources = stage / "Contents/Resources"
                resources.mkdir(parents=True)
                (stage / "Contents/Info.plist").write_bytes(plistlib.dumps({"LakeBackendRuntime": "typescript"}))
                backend = resources / "lake"
                backend.write_text("#!/bin/sh\nprintf '%s\\n' \"$@\" > " + shlex.quote(str(migration_args)) + "\n" + migration + "\n")
                backend.chmod(0o700)
            (work / "update.zip").write_text("synthetic package")
            (work / "unpacked").mkdir()
            (work / "unpacked" / "bundle").write_text("synthetic extracted app")
            opener = root / "open-test"
            opener.write_text("#!/bin/sh\n" + behavior + "\n")
            opener.chmod(0o700)
            child = subprocess.Popen(["/bin/sleep", "0.2"])
            # Use the PID of a real process which exits; also verify the helper waits for it.
            arguments = ["/bin/sh", str(INSTALLER), str(child.pid), "0", str(stage),
                str(target), str(backup), str(work), "0.3.0", str(opener), "2"]
            if typescript:
                arguments += ["" if missing_home else str(home), "" if missing_home else str(home / "web-agent"), "1" if migration.startswith("exec") else "10"]
            process = subprocess.Popen(arguments)
            child.wait()
            code = process.wait(timeout=15)
            if code == 0:
                self.assertFalse(work.exists(), "successful update left its package cache")
            if typescript:
                self.assertEqual((home / "original-record").read_text(), "preserved")
                if missing_home:
                    self.assertFalse(migration_args.exists())
                else:
                    self.assertEqual(migration_args.read_text().splitlines(), ["web", "--production", "--migrate-legacy", "--import-only", "--home", str(home), "--data", str(home / "web-agent"), "--port", "0"])
            return code, (target / "version").read_text(), backup.exists(), (work / "error").exists()

    def test_success_removes_old_app_and_downloads(self):
        result = self.scenario('if [ "$#" -gt 2 ]; then printf 0.3.0 > "$5"; fi')
        self.assertEqual(result, (0, "new", False, False))

    def test_launch_failure_restores_old_app(self):
        result = self.scenario('if [ "$#" -gt 2 ]; then exit 1; fi')
        self.assertEqual(result, (1, "old", False, True))

    def test_no_ready_receipt_restores_old_app(self):
        result = self.scenario('exit 0')
        self.assertEqual(result, (1, "old", False, True))

    def test_wrong_version_receipt_restores_old_app(self):
        result = self.scenario('if [ "$#" -gt 2 ]; then printf 9.9.9 > "$5"; fi')
        self.assertEqual(result, (1, "old", False, True))

    def test_failed_replacement_restores_old_app(self):
        result = self.scenario('exit 0', missing_stage=True)
        self.assertEqual(result, (1, "old", False, True))

    def test_typescript_preparation_uses_exact_production_home_before_readiness(self):
        self.assertEqual(self.scenario('if [ "$#" -gt 2 ]; then printf 0.3.0 > "$5"; fi', typescript=True), (0, "new", False, False))

    def test_typescript_migration_failure_restores_old_app_and_retains_original_data(self):
        self.assertEqual(self.scenario('exit 0', typescript=True, migration="exit 1"), (1, "old", False, True))

    def test_typescript_migration_timeout_restores_old_app(self):
        self.assertEqual(self.scenario('exit 0', typescript=True, migration="exec /bin/sleep 30"), (1, "old", False, True))

    def test_typescript_missing_home_never_guesses_a_production_directory(self):
        self.assertEqual(self.scenario('exit 0', typescript=True, missing_home=True), (1, "old", False, True))


if __name__ == "__main__":
    unittest.main()
