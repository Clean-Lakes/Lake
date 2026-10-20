#!/usr/bin/env python3
"""Validate trusted PR metadata without executing PR head code."""

import json
import os
import sys


def validate(event, repository):
    if not repository:
        raise ValueError('GITHUB_REPOSITORY is required')
    pr = event.get('pull_request')
    if not isinstance(pr, dict):
        raise ValueError('a pull_request event is required')
    base, head = pr.get('base', {}), pr.get('head', {})
    if (base.get('repo') or {}).get('full_name') != repository:
        raise ValueError('base repository does not match the current repository')
    target, source = base.get('ref'), head.get('ref')
    if not source:
        raise ValueError('head branch is missing')
    if target == 'master':
        if source != 'develop' or (head.get('repo') or {}).get('full_name') != repository:
            raise ValueError('master only accepts a same-repository develop release PR; target ordinary PRs at develop')
    elif target == 'develop':
        if source in ('master', 'develop'):
            raise ValueError('develop requires a work branch; use sync/<topic> for production history synchronization')
    else:
        raise ValueError('ordinary PRs must target develop; release PRs must target master')
    return f'Allowed PR route: {source} -> {target}'


def main():
    try:
        with open(os.environ['GITHUB_EVENT_PATH'], encoding='utf-8') as source:
            event = json.load(source)
        print(validate(event, os.environ.get('GITHUB_REPOSITORY')))
        return 0
    except (KeyError, ValueError, OSError, TypeError, AttributeError) as error:
        print(f'Branch policy rejected this PR: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
