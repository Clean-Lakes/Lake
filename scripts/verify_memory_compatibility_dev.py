#!/usr/bin/env python3
"""Isolated signed-backend compatibility acceptance; no real provider or UI.

Creates a private Home, a loopback model and a stopped synthetic V6 archive fixture.
Optionally verifies an explicitly supplied old binary refuses V7 on a stopped copy.
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
        require(BODY not in raw, 'retired adopted preference injected')
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
                if name.startswith(('strategy', 'natural', 'legacyAsset')) or name in ('native_corrections', 'native_artifacts'):
                    rows = sorted(json.dumps(row, ensure_ascii=False, default=str) for row in db.execute('SELECT * FROM "'+name+'"'))
                    result[key][name] = hashlib.sha256('\n'.join(rows).encode()).hexdigest()
    return result


def retired(lake, path, method='POST', data=None):
    try:
        lake.api(path, method, {} if data is None else data)
    except urllib.error.HTTPError as error:
        require(error.code == 410 and json.load(error).get('code') == 'strategy_assets_retired', 'wrong retirement response')
    else:
        raise AssertionError('retired write accepted')


def seed_v6(home, project):
    """Construct the stopped historical format, never re-enable a product API."""
    digest = None
    for name in ['strategy_schema.sql', 'strategy_learning_schema.sql', 'strategy_experiment_schema.sql',
                 'strategy_optimization_schema.sql', 'strategy_review_schema.sql', 'strategy_reuse_schema.sql']:
        text = (ROOT/'internal/web'/name).read_text().replace('\r\n', '\n')
        digest = hashlib.sha256((text if digest is None else digest+'\n'+text).encode()).hexdigest()
    scope, at = 'project:'+project, '2026-10-29T00:00:00Z'
    with sqlite3.connect(home/'web-agent/lake-web.sqlite') as db:
        db.execute('PRAGMA foreign_keys=ON')
        db.executescript('DROP TABLE legacyAssetArchive; DROP TABLE legacyAssetSettingsArchive; DROP TABLE strategySchemaMeta; CREATE TABLE strategySchemaMeta(version INTEGER PRIMARY KEY CHECK(version=6),schemaHash TEXT NOT NULL);')
        db.execute('INSERT INTO strategySchemaMeta VALUES(6,?)', (digest,))
        db.execute("INSERT OR IGNORE INTO strategyScopes VALUES(?,'project',?,'local',1)", (scope, project))
        for asset, body in [('adopted', BODY), ('draft', 'C4_UNADOPTED')]:
            source, content_hash = 'source-'+asset, hashlib.sha256(body.encode()).hexdigest()
            db.execute("INSERT INTO strategyAssets VALUES(?,?,'user_preference',?,1,?,'')", (asset, scope, 'Exact legacy '+asset, at))
            db.execute("INSERT INTO strategySourceEvents VALUES(?,?,?,'manual_authoring','','',?,'Synthetic archival source','available',?)", (source, scope, source, content_hash, at))
            db.execute("INSERT INTO strategyRevisions VALUES(?,1,0,?,?,?,'user_confirmed','local_user',?)", (asset, hashlib.sha256(b'{}').hexdigest(), content_hash, hashlib.sha256(json.dumps([source], separators=(',', ':')).encode()).hexdigest(), at))
            db.execute("INSERT INTO strategyRevisionContent VALUES(?,1,?,'{}')", (asset, body))
            db.execute("INSERT INTO strategyRevisionSources VALUES(?,1,?)", (asset, source))
        db.execute("INSERT INTO strategyBindings VALUES('adopted',?,1,1,1,0,'')", (scope,))
        db.execute("INSERT INTO naturalMemoryLinks VALUES(?,'adopted',1,1,?,'legacy-binding','mapped',?)", (scope, hashlib.sha256(BODY.encode()).hexdigest(), at))
        old = dict(scope={'kind': 'user'}, revision=1, epoch=1, masterEnabled=True, applyEnabled=True,
                   learnEnabled=False, correctEnabled=False, onlineCorrectEnabled=False)
        db.execute("INSERT INTO strategySettings VALUES('user',1,1,?,?)", (json.dumps(old), at))
        db.execute("INSERT INTO strategyJobs(id,scopeKey,accessProjectId,kind,expectedRevision,status,globalEpoch,projectEpoch,sourceSetHash,runtimeId,dispatchState,expiresAtMs,errorCode,createdAt,updatedAt) VALUES('unknown-call',?,?,'proposal',0,'awaiting_reconciliation',1,1,'source-hash','original-runtime','unknown',9999999999999,'strategy_execution_retired',?,?)", (scope, project, at, at))


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
        lake.stop()
        lake = None
        seed_v6(home, project)
        lake = Lake(binary, home, env)
        archive = root/'retired-assets.json'
        subprocess.run([str(binary), 'memory', 'export-retired-assets', '--home', str(home), '--output', str(archive)], check=True, stdout=subprocess.DEVNULL)
        exported = json.loads(archive.read_text())
        require(exported['runtimeUse'] is False, 'archive unexpectedly active')
        require(len(exported['tables']['legacyAssetArchive']) == 2, 'missing archived asset')
        require(any(v['body'] == BODY for v in exported['tables']['strategyRevisionContent']), 'exact legacy body lost')
        require(exported['tables']['naturalMemoryLinks'][0]['state'] == 'mapped', 'N1 history lost')
        require(json.loads(exported['tables']['legacyAssetSettingsArchive'][0]['body'])['applyEnabled'], 'original choice not archived')
        with sqlite3.connect(home/'web-agent/lake-web.sqlite') as db:
            old = json.loads(db.execute("SELECT body FROM strategySettings WHERE scopeKey='user'").fetchone()[0])
            require(not old['masterEnabled'] and not old['applyEnabled'], 'old application remains enabled')
            require(db.execute('SELECT COUNT(*) FROM naturalPreferenceEntries').fetchone()[0] == 0, 'legacy silently converted')
            require(db.execute("SELECT runtimeId,dispatchState FROM strategyJobs WHERE id='unknown-call'").fetchone() == ('original-runtime', 'unknown'), 'unknown call identity changed')
        for suffix in ['/assets', '/settings', '/sources', '/proposals', '/experiments', '/experiments/old/resume', '/experiments/old/save-candidate', '/usage']:
            retired(lake, base+suffix)
        retired(lake, '/api/strategy/settings', 'PATCH', {'masterEnabled': True, 'applyEnabled': True})
        for suffix in ['/legacy', '/legacy/adopted/carry', '/preferences/adopted', '/changes/old/undo']:
            retired(lake, memory+suffix)
        report['checks'] += ['v6_exact_archive', 'old_switches_disabled', 'no_implicit_conversion', 'unknown_identity_preserved', 'all_legacy_routes_410']
        # Repeat actual HTTP/ADK tasks across clean backend restarts.
        for turn in range(2):
            sid = lake.session(project, 'C4 new turn '+str(turn))
            view = lake.send_and_finish(sid, 'Please answer once without using tools.')
            require(view['status'] == 'completed', 'ordinary turn failed')
            require(not any(c['type'] == 'strategy_correction' for c in view['cards']), 'new correction card')
            retired(lake, base+'/usage?sessionId='+sid, 'GET')
            lake.stop()
            lake = None
            before = row_hashes(home)
            lake = Lake(binary, home, env)
            require(row_hashes(home) == before, 'restart changed compatibility content')
            with sqlite3.connect(home/'web-agent/lake-web.sqlite') as db:
                require(db.execute("SELECT body FROM strategyRevisionContent WHERE assetId='adopted'").fetchone()[0] == BODY, 'restart lost exact archived content')
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
            try:
                Lake(args.previous_binary, copied, env)
            except AssertionError:
                pass
            else:
                raise AssertionError('previous binary accepted retired V7')
            require(before == row_hashes(copied), 'rejected old binary modified the archive')
            lake = Lake(binary, copied, env)
            lake.api('/api/bootstrap')
            lake.stop()
            lake = None
            require(before == row_hashes(copied), 'current binary restart changed archived content')
            report['previousBinaryRoundTrip'] = 'passed_v7_rejected_without_data_change'
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
    print('Legacy asset exit isolated acceptance passed; no real provider or working Home used.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
