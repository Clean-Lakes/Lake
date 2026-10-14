#!/usr/bin/env python3
"""Exercise the shipped installer against isolated fake apps and launchers."""
import pathlib
import subprocess
import tempfile
import unittest

INSTALLER = pathlib.Path(__file__).resolve().parents[1] / "client/macos/Resources/install-update.sh"


class InstallerTests(unittest.TestCase):
    def scenario(self, behavior, missing_stage=False):
        with tempfile.TemporaryDirectory(prefix="lake installer ' spaces ") as directory:
            root = pathlib.Path(directory)
            target, stage, backup, work = (root / name for name in ["Lake.app", "next.app", "backup.app", "work"])
            target.mkdir()
            (target / "version").write_text("old")
            if not missing_stage:
                stage.mkdir()
                (stage / "version").write_text("new")
            work.mkdir()
            (work / "update.zip").write_text("synthetic package")
            (work / "unpacked").mkdir()
            (work / "unpacked" / "bundle").write_text("synthetic extracted app")
            opener = root / "open-test"
            opener.write_text("#!/bin/sh\n" + behavior + "\n")
            opener.chmod(0o700)
            child = subprocess.Popen(["/bin/sleep", "0.2"])
            # Use the PID of a real process which exits; also verify the helper waits for it.
            process = subprocess.Popen(["/bin/sh", str(INSTALLER), str(child.pid), "0", str(stage),
                str(target), str(backup), str(work), "0.3.0", str(opener), "2"])
            child.wait()
            code = process.wait(timeout=15)
            if code == 0:
                self.assertFalse(work.exists(), "successful update left its package cache")
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


if __name__ == "__main__":
    unittest.main()
