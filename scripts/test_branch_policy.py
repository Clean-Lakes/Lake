"""Regression coverage for fork spoofing and protected-branch PR routing."""

import copy
import unittest

from check_branch_policy import validate


REPO = 'Clean-Lakes/Lake'


def event(source='codex/change', target='develop', head_repo=REPO):
    return {'pull_request': {
        'base': {'ref': target, 'repo': {'full_name': REPO}},
        'head': {'ref': source, 'repo': {'full_name': head_repo}},
    }}


class BranchPolicyTests(unittest.TestCase):
    def test_ordinary_and_fork_work_target_develop(self):
        for source, repo in [('codex/change', REPO), ('fix/issue', 'contributor/Lake'), ('sync/v0.3.22', REPO)]:
            with self.subTest(source=source):
                validate(event(source=source, head_repo=repo), REPO)

    def test_only_internal_develop_can_target_master(self):
        validate(event(source='develop', target='master'), REPO)
        for source, repo in [('codex/change', REPO), ('fix/hotfix', REPO), ('develop', 'contributor/Lake')]:
            with self.subTest(source=source, repo=repo), self.assertRaises(ValueError):
                validate(event(source, 'master', repo), REPO)

    def test_protected_sources_require_work_branch(self):
        for source in ['master', 'develop']:
            with self.subTest(source=source), self.assertRaises(ValueError):
                validate(event(source), REPO)

    def test_missing_or_foreign_metadata_is_rejected(self):
        cases = [{}, {'pull_request': None}, event(target='main')]
        deleted_head = event('develop', 'master')
        deleted_head['pull_request']['head']['repo'] = None
        cases.append(deleted_head)
        foreign = copy.deepcopy(event())
        foreign['pull_request']['base']['repo']['full_name'] = 'other/Lake'
        cases.append(foreign)
        missing_head = event()
        del missing_head['pull_request']['head']['ref']
        cases.append(missing_head)
        for value in cases:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate(value, REPO)
        with self.assertRaises(ValueError):
            validate(event(), '')


if __name__ == '__main__':
    unittest.main()
