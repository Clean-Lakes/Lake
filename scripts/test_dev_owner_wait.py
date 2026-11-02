import io
import multiprocessing
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock

from dev_acceptance import Lake, home_owner_released


def hold_fixture_owner(path, ready, release):
    import fcntl
    with open(path, 'a+b') as owner:
        fcntl.flock(owner.fileno(), fcntl.LOCK_EX)
        ready.set()
        release.wait(10)


@unittest.skipUnless(os.name == 'posix', 'native fixture ownership uses Unix flock')
class DevOwnerWaitTests(unittest.TestCase):
    def test_native_parent_exit_does_not_finish_until_backend_releases_owner(self):
        with tempfile.TemporaryDirectory(prefix='lake-owner-wait-test.') as directory:
            home = Path(directory)
            (home / 'security').mkdir()
            lock = home / 'security/owner.lock'
            context = multiprocessing.get_context('spawn')
            ready, release = context.Event(), context.Event()
            backend = context.Process(target=hold_fixture_owner, args=(str(lock), ready, release))
            backend.start()
            self.assertTrue(ready.wait(5))
            self.assertFalse(home_owner_released(home))
            fixture = Lake.__new__(Lake)
            fixture.home = home
            fixture.process = Mock()
            fixture.process.poll.return_value = 0  # Native parent has exited.
            fixture.log = io.StringIO()
            completed = threading.Event()
            failures = []

            def stop():
                try:
                    fixture.stop()
                except Exception as error:
                    failures.append(error)
                finally:
                    completed.set()

            worker = threading.Thread(target=stop)
            worker.start()
            try:
                self.assertFalse(completed.wait(0.15), 'parent exit incorrectly proved backend shutdown')
                self.assertTrue(lock.exists(), 'probe removed the live owner lock')
                release.set()
                self.assertTrue(completed.wait(5), 'fixture did not observe actual backend release')
                self.assertEqual(failures, [])
                self.assertTrue(home_owner_released(home))
                self.assertTrue(fixture.log.closed)
            finally:
                release.set()
                worker.join(5)
                backend.join(5)
                if backend.is_alive():
                    backend.terminate()
                    backend.join(5)
            self.assertEqual(backend.exitcode, 0)

    def test_missing_owner_from_failed_start_is_already_released(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertTrue(home_owner_released(Path(directory)))


if __name__ == '__main__':
    unittest.main()
