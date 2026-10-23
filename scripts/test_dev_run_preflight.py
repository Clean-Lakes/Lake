import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dev_run_preflight import check_dev_home


class DevRunPreflightTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.dev = self.root / ".lake-dev"
        self.release = self.root / ".lake"
        self.release.mkdir()

    def runtime(self, data):
        (self.dev / "web-agent").mkdir(parents=True)
        (self.dev / "web-agent/runtime.json").write_text(json.dumps(data))

    def test_new_home_is_not_created_by_check(self):
        check_dev_home(self.dev, self.release)
        self.assertFalse(self.dev.exists())

    def test_dev_or_data_symlink_is_rejected_without_touching_release(self):
        sentinel = self.release / "sentinel"
        sentinel.write_text("unchanged")
        self.dev.symlink_to(self.release, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "正式数据"):
            check_dev_home(self.dev, self.release)
        self.dev.unlink()
        self.dev.mkdir()
        (self.dev / "web-agent").symlink_to(self.release, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "正式数据"):
            check_dev_home(self.dev, self.release)
        self.assertEqual(sentinel.read_text(), "unchanged")

    def test_live_backend_blocks_before_build_without_exposing_token(self):
        self.runtime({"pid": os.getpid(), "token": "fixture-secret"})
        with self.assertRaisesRegex(ValueError, "仍在运行") as error:
            check_dev_home(self.dev, self.release)
        self.assertNotIn("fixture-secret", str(error.exception))

    def test_stale_backend_record_can_be_replaced(self):
        self.runtime({"pid": 12345})
        with patch("dev_run_preflight.os.kill", side_effect=ProcessLookupError):
            check_dev_home(self.dev, self.release)

    def test_permission_denied_does_not_assume_process_dead(self):
        self.runtime({"pid": 12345})
        with patch("dev_run_preflight.os.kill", side_effect=PermissionError):
            with self.assertRaisesRegex(ValueError, "仍在运行"):
                check_dev_home(self.dev, self.release)

    def test_invalid_pid_is_not_used_as_process_group(self):
        self.runtime({"pid": -1, "token": "fixture-secret"})
        with patch("dev_run_preflight.os.kill") as kill:
            with self.assertRaisesRegex(ValueError, "记录无效"):
                check_dev_home(self.dev, self.release)
            kill.assert_not_called()


if __name__ == "__main__":
    unittest.main()
