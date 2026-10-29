"""Offline reliability checks for compatibility reports and retired trial commands."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import verify_memory_compatibility as verifier


class CompatibilityToolTests(unittest.TestCase):
    def run_report(self, events):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / 'result.json'

            def run(command, **options):
                for event in events:
                    options['stdout'].write(json.dumps(event)+'\n')
                return SimpleNamespace(returncode=0)

            with patch.object(sys, 'argv', ['verify', '--report', str(report), '--packages', 'internal/ai', 'internal/web']), patch.object(verifier, 'git', return_value='test-sha'), patch.object(verifier.subprocess, 'check_output', return_value='go fixture'), patch.object(verifier.subprocess, 'run', side_effect=run), contextlib.redirect_stdout(io.StringIO()):
                code = verifier.main()
            return code, json.loads(report.read_text())

    def events(self, package, status='pass'):
        name = 'github.com/Clean-Lakes/Lake/'+package
        return [{'Package': name, 'Test': 'TestC4RestoredHistory', 'Action': status}, {'Package': name, 'Action': status}]

    def test_every_requested_package_needs_real_selected_passes(self):
        for events in [[], self.events('internal/ai'), self.events('internal/ai')+[{'Package': 'github.com/Clean-Lakes/Lake/internal/web', 'Action': 'pass'}]]:
            with self.subTest(events=events):
                code, report = self.run_report(events)
                self.assertEqual(code, 1)
                self.assertEqual(report['status'], 'failed')

    def test_child_failure_is_not_hidden_by_parent_or_process_success(self):
        events = self.events('internal/ai')+self.events('internal/web')+[{'Package': 'github.com/Clean-Lakes/Lake/internal/ai', 'Test': 'TestC4RestoredHistory/unknown', 'Action': 'fail'}]
        self.assertEqual(self.run_report(events)[0], 1)

    def test_report_contains_statuses_and_never_raw_test_output(self):
        events = self.events('internal/ai')+self.events('internal/web')+[{'Package': 'fixture', 'Action': 'output', 'Output': 'synthetic-private-payload'}]
        code, report = self.run_report(events)
        self.assertEqual(code, 0)
        self.assertEqual(report['kind'], 'memory_compatibility_regression')
        self.assertNotIn('synthetic-private-payload', json.dumps(report))
        self.assertFalse(report['modelBenefitEvaluated'])
        self.assertFalse(report['desktopEvaluated'])
        pattern = report['suites'][0]['command'][report['suites'][0]['command'].index('-run')+1]
        self.assertIn('TestNatural', pattern)
        self.assertIn('TestC[34]', pattern)

    def test_retired_trial_commands_exit_before_any_report_or_home_is_created(self):
        for name in ['test_strategy_learning_dev.py', 'test_strategy_reuse_dev.py']:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                report = Path(directory) / 'never-created.json'
                result = subprocess.run([sys.executable, str(Path(__file__).with_name(name)), '--report', str(report), '--running-home', str(Path(directory)/'no-home')], capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode, 2)
                self.assertIn('retired', result.stdout)
                self.assertFalse(report.exists())
                self.assertEqual(list(Path(directory).iterdir()), [])


if __name__ == '__main__':
    unittest.main()
