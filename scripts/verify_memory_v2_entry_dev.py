#!/usr/bin/env python3
"""Signed-backend retirement acceptance using a private synthetic Home, no model/UI."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile
import urllib.error
import urllib.request

from dev_acceptance import Lake, require

ROOT = Path(__file__).resolve().parents[1]


def rejected(call, status, code=None):
    try:
        call()
    except urllib.error.HTTPError as error:
        require(error.code == status, 'unexpected API status')
        if code:
            require(json.load(error).get('code') == code, 'unexpected retirement code')
    else:
        raise AssertionError('retired or unqualified request accepted')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', required=True, type=Path)
    args = parser.parse_args()
    binary = ROOT / 'bin/lake'
    origin = json.loads((ROOT / 'bin/lake-dev-run-origin.json').read_text())
    digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    require(not origin['dirty'] and origin['backendSHA256'] == digest, 'clean signed build required')
    if platform.system() == 'Darwin':
        subprocess.run(['codesign', '--verify', '--strict', str(binary)], check=True)
    report = {'sourceCommit': origin['gitHead'], 'backendSHA256': digest,
              'status': 'running', 'nativeUIEvaluated': False, 'modelConfigured': False, 'checks': []}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    env = {key: value for key, value in os.environ.items() if not key.startswith('LAKE_')}
    lake = None
    temporary = tempfile.TemporaryDirectory(prefix='lake-memory-v2-entries-')
    try:
        home = Path(temporary.name)
        os.chmod(home, 0o700)
        lake = Lake(binary, home, env)
        require(not lake.api('/api/bootstrap')['modelConfigured'], 'fixture has a model/credentials')
        project = lake.api('/api/projects', 'POST', {'name': 'V2 entry retirement'})['id']
        base = '/api/projects/' + project
        require(lake.api(base+'/memory-settings')['memorySchemaVersion'] == 1, 'current format changed')
        key = base+'/memory/current-rule'
        lake.api(key, 'PUT', {'type': 'project', 'description': 'Synthetic current rule',
                             'body': 'Check the backup before release.', 'expectedRevision': 0})
        before = lake.api(key)
        count = 0
        suffixes = ['/memory-classification', '/memory-candidates',
                    '/memory-candidates/old/decision', '/memory/current-rule/sources/old']
        for suffix in suffixes:
            for method in ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']:
                rejected(lambda: lake.api(base+suffix, method, None if method == 'GET' else 'not an object'),
                         410, 'memory_v2_retired')
                count += 1
            rejected(lambda: lake.api('/api/projects/missing-project'+suffix), 404)
            rejected(lambda: urllib.request.urlopen(lake.runtime['origin']+base+suffix, timeout=10), 401)
        require(lake.api(key) == before, 'retired route changed current data')
        other = lake.api('/api/projects', 'POST', {'name': 'Other scope'})['id']
        rejected(lambda: lake.api('/api/projects/'+other+'/memory/current-rule'), 404)
        report['retiredRequests'] = count
        report['checks'] += ['current_v1_crud', 'all_retired_methods_410', 'authentication_401',
                             'missing_project_404', 'cross_project_body_404', 'retired_calls_no_mutation']
        lake.stop()
        lake = Lake(binary, home, env)
        require(lake.api(key) == before, 'restart changed current data')
        lake.api(key, 'DELETE', {'expectedRevision': before['revision']})
        forgotten = lake.api(key+'?includeDeleted=true')
        require(not forgotten.get('body') and not forgotten.get('sources'), 'forget retained content')
        report['checks'] += ['restart_parity', 'current_forget_clears_content']
        lake.stop()
        lake = None
        report['status'] = 'passed'
    except Exception as error:
        report['status'], report['failureType'] = 'failed', type(error).__name__
        raise
    finally:
        try:
            if lake:
                lake.stop()
        finally:
            temporary.cleanup()
            args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
            os.chmod(args.report, 0o600)
    print('Memory V2 entry retirement acceptance passed; private Home, no model or UI.')


if __name__ == '__main__':
    main()
