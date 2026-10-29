#!/usr/bin/env python3
"""Isolated signed-backend compatibility acceptance; no real provider or UI.

Creates a fresh private Home, a loopback model and synthetic manual preferences.
Optionally round-trips a stopped copy through an explicitly supplied old binary.
Never opens the user's working database or copies credentials. No packaging/CI.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from dev_acceptance import Lake, require

ROOT = Path(__file__).resolve().parents[1]
BODY = 'C4_VISIBLE_MANUAL_PREFERENCE: 先陈述事实，再说明限制。'


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"data":[]}')

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        raw = json.dumps(body, ensure_ascii=False)
        names = {v['function']['name'] for v in body.get('tools', [])}
        require('revise_readonly_strategy' not in names, 'retired tool registered')
        require(raw.count(BODY) == 1, 'manual preference missing or duplicated')
        require('C4_UNADOPTED' not in raw, 'unadopted content leaked into request')
        self.server.requests += 1
        payload = {'choices': [{'index': 0, 'delta': {'content': 'C4 synthetic task completed.'}, 'finish_reason': 'stop'}],
                   'usage': {'prompt_tokens': 120, 'completion_tokens': 12, 'total_tokens': 132}}
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        self.wfile.write(('data: '+json.dumps(payload)+'\n\ndata: [DONE]\n\n').encode())


class FixtureServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, *_):
        self.errors += 1  # Never print a request or an authorization header.


def row_hashes(home):
    result = {}
    for key, rel in [('web', 'lake-web.sqlite'), ('adk', 'adk/sessions.sqlite')]:
        path = home / 'web-agent' / rel
        with sqlite3.connect('file:'+str(path)+'?mode=ro', uri=True) as db:
            require(db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'database integrity failed')
            names = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
            result[key] = {}
            for name in names:
                if name.startswith(('strategy', 'natural')) or name in ('native_corrections', 'native_artifacts'):
                    rows = sorted(json.dumps(row, ensure_ascii=False, default=str) for row in db.execute('SELECT * FROM "'+name+'"'))
                    result[key][name] = hashlib.sha256('\n'.join(rows).encode()).hexdigest()
    return result


def retired(lake, path, method='POST', data=None):
    try:
        lake.api(path, method, {} if data is None else data)
    except urllib.error.HTTPError as error:
        require(error.code == 410 and json.load(error).get('code') == 'strategy_execution_retired', 'wrong retirement response')
    else:
        raise AssertionError('retired write accepted')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', required=True, type=Path)
    parser.add_argument('--previous-binary', type=Path, help='Explicit old binary; only opens an isolated stopped copy, no tasks')
    args = parser.parse_args()
    binary = ROOT / 'bin/lake'
    origin = json.loads((ROOT / 'bin/lake-dev-run-origin.json').read_text())
    require(not origin['dirty'] and origin['backendSHA256'] == hashlib.sha256(binary.read_bytes()).hexdigest(), 'clean signed build required')
    if platform.system() == 'Darwin':
        subprocess.run(['codesign', '--verify', '--strict', str(binary)], check=True)
    if args.previous_binary:
        require(args.previous_binary.is_file() and args.previous_binary.resolve() != binary.resolve(), 'distinct previous binary required')
        if platform.system() == 'Darwin':
            subprocess.run(['codesign', '--verify', '--strict', str(args.previous_binary)], check=True)
    root = Path(tempfile.mkdtemp(prefix='lake-c4-compatibility-'))
    os.chmod(root, 0o700)
    home = root / 'current'
    home.mkdir(mode=0o700)
    env = {k: v for k, v in os.environ.items() if not k.startswith('LAKE_')}
    report = {'schemaVersion': 1, 'kind': 'memory_compatibility_dev', 'sourceCommit': origin['gitHead'],
              'status': 'running', 'syntheticProvider': True, 'realModelBenefitEvaluated': False,
              'nativeUIEvaluated': False, 'previousBinaryRoundTrip': 'not_requested', 'checks': []}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    provider = FixtureServer(('127.0.0.1', 0), Provider)
    provider.errors, provider.requests = 0, 0
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    lake = None
    try:
        lake = Lake(binary, home, env)
        require(not lake.api('/api/bootstrap')['modelConfigured'], 'fresh Home has credentials/model')
        project = lake.api('/api/projects', 'POST', {'name': 'C4 synthetic compatibility'})['id']
        base = '/api/projects/'+project+'/strategy'
        memory = '/api/projects/'+project+'/natural-memory'
        lake.api('/api/projects/'+project+'/sre', 'PUT', {'enabled': False})
        lake.api('/api/projects/'+project+'/memory-settings', 'PATCH', {'expectedRevision': 0, 'useEnabled': False, 'extractionEnabled': False})
        lake.api('/api/settings/model', 'PUT', {'url': f'http://127.0.0.1:{provider.server_port}', 'name': 'C4 loopback fixture', 'protocol': 'openai'})
        asset = lake.api(base+'/assets', 'POST', {'expectedRevision': 0, 'title': 'C4 exact preference', 'kind': 'user_preference', 'body': BODY, 'applicability': {}})['assetId']
        ref = lake.api(base+'/assets/'+asset+'/revisions/1')['value']['ref']
        lake.api(base+'/assets/'+asset+'/bindings', 'POST', {'action': 'adopt', 'ref': ref, 'expectedRevision': 0, 'priority': 0, 'exclusionGroup': ''})
        lake.api(base+'/assets', 'POST', {'expectedRevision': 0, 'title': 'C4 draft', 'kind': 'user_preference', 'body': 'C4_UNADOPTED', 'applicability': {}})
        settings = lake.api('/api/strategy/settings')['settings']
        values = {k: False for k in ['learnEnabled', 'correctEnabled', 'onlineCorrectEnabled']}
        values.update(expectedRevision=settings['revision'], masterEnabled=True, applyEnabled=True, budget=settings['budget'])
        lake.api('/api/strategy/settings', 'PATCH', values)
        preview = lake.api(memory+'/legacy/'+asset+'/preview')
        require(preview['eligible'], 'simple adopted preference cannot be carried')
        lake.api(memory+'/legacy/'+asset+'/carry', 'POST', {'expectedRevision': 0, 'previewToken': preview['previewToken']})
        require(lake.api(memory+'/preferences/'+asset)['body'] == BODY, 'carry changed exact content')
        for suffix in ['/sources', '/proposals', '/experiments', '/experiments/old/resume', '/experiments/old/save-candidate']:
            retired(lake, base+suffix)
        values['expectedRevision'] += 1
        values.update(learnEnabled=True, correctEnabled=True, onlineCorrectEnabled=True, onlineConsentVersion=2)
        retired(lake, '/api/strategy/settings', 'PATCH', values)
        report['checks'] += ['legacy_content_exact', 'carry_without_duplicate_runtime', 'unadopted_not_applied', 'retired_writes_410']
        # Repeat actual HTTP/ADK tasks across clean backend restarts.
        for turn in range(2):
            sid = lake.session(project, 'C4 new turn '+str(turn))
            view = lake.send_and_finish(sid, 'Please answer once without using tools.')
            require(view['status'] == 'completed', 'ordinary turn failed')
            require(not any(c['type'] == 'strategy_correction' for c in view['cards']), 'new correction card')
            require(lake.api(base+'/usage?sessionId='+sid)['items'] == [], 'new experimental manifest')
            lake.stop()
            lake = None
            before = row_hashes(home)
            lake = Lake(binary, home, env)
            require(row_hashes(home) == before, 'restart changed compatibility content')
            require(lake.api(base+'/assets/'+asset+'/revisions/1')['value']['ref'] == ref, 'restart lost exact adopted version')
            ns = lake.api(memory+'/settings')
            require(not ns['autoEnabled'] and not ns['recallSettings']['useEnabled'], 'restart inherited automatic/recall consent')
        report['preservedTableCounts'] = {key: len(value) for key, value in before.items()}
        with sqlite3.connect('file:'+str(home/'web-agent/adk/sessions.sqlite')+'?mode=ro', uri=True) as db:
            report['newExperimentalManifests'] = db.execute("SELECT COUNT(*) FROM native_artifacts WHERE file_name LIKE 'prompt-manifest-%'").fetchone()[0]
            report['newCorrections'] = db.execute('SELECT COUNT(*) FROM native_corrections').fetchone()[0]
        require(report['newExperimentalManifests'] == 0 and report['newCorrections'] == 0, 'new retired execution records')
        report['checks'] += ['two_new_turns_across_restart', 'no_new_manifests_or_corrections', 'restart_hash_parity', 'independent_consent_off']
        lake.stop()
        lake = None
        if args.previous_binary:
            copied = root / 'round-trip'
            shutil.copytree(home, copied)  # Home has only synthetic fixture data, no imported credentials.
            before = row_hashes(copied)
            for executable in [args.previous_binary, binary]:
                lake = Lake(executable, copied, env)
                lake.api('/api/bootstrap')  # No task, model reconfiguration or resource operation.
                lake.stop()
                lake = None
            require(before == row_hashes(copied), 'old-binary read-only round trip changed content')
            report['previousBinaryRoundTrip'] = 'passed_readonly_copy_only'
            report['previousBinarySHA256'] = hashlib.sha256(args.previous_binary.read_bytes()).hexdigest()
        require(provider.requests == 2 and provider.errors == 0, 'extra model requests or invalid provider path')
        report['providerRequests'] = provider.requests
        report['status'] = 'passed'
    except Exception as error:
        report['status'] = 'failed'
        report['failureType'] = type(error).__name__
        raise
    finally:
        if lake:
            lake.stop()
        provider.shutdown()
        provider.server_close()
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
        os.chmod(args.report, 0o600)
    print('C4 isolated compatibility acceptance passed; no real provider or working Home used.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
