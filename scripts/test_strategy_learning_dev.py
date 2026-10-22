#!/usr/bin/env python3
"""Exercise signed Lake Dev with synthetic model SSE and real loopback reads.

Creates fresh private Homes, never reads production configuration/credentials.
A/B/C are deterministic control-flow samples, not evidence of model benefit.
Build with the standard Dev script first. --hold-for-ui keeps the native window
open for manual QA; quit only that Dev app to continue the restart check.
"""
import argparse
import hashlib
import json
import os
import pathlib
import plistlib
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parents[1]
BODY = 'P8_VISIBLE_ASSET: 以实际健康检查响应区分已知与待核实；不要把一次采样当作整个业务恢复。'
FLAGS = ('masterEnabled', 'applyEnabled', 'learnEnabled', 'correctEnabled', 'onlineCorrectEnabled')


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def wait_for(check, seconds=40):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(.1)
    raise TimeoutError('Lake fixture wait expired')


class FixtureServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, *_):
        # Do not echo model requests or auth headers into CI/terminal logs.
        self.errors += 1


def serve(handler):
    server = FixtureServer(('127.0.0.1', 0), handler)
    server.errors = 0
    server.counts = {'provider': 0, 'health': 0, 'auxiliary': 0}
    server.mode = 'A'
    server.assets = False
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class Health(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        require(self.path == '/health', 'unexpected health path')
        self.server.counts['health'] += 1
        if self.server.counts['health'] == 1:
            self.close_connection = True
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"healthy":true,"observation":"P8_REAL_HEALTH"}')


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"data":[]}')

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        messages = data['messages']
        raw = json.dumps(messages, ensure_ascii=False)
        require(data['max_tokens'] == 1024, 'unexpected auxiliary model request')
        require((BODY in raw) == self.server.assets, 'actual prompt asset selection differs')
        self.server.counts['provider'] += 1
        tools = [m for m in messages if m['role'] == 'tool']
        names = {t['function']['name'] for t in data.get('tools', [])}
        online = self.server.mode in ('C', 'Exit', 'Simple')
        require(('revise_readonly_strategy' in names) == online, 'correction catalog differs')
        arguments = {'command': f'curl -sS --max-time 2 http://127.0.0.1:{self.server.health.server_port}/health'}

        def call(identity, tool, args):
            return {'tool_calls': [{'index': 0, 'id': identity, 'type': 'function',
                                   'function': {'name': tool, 'arguments': json.dumps(args, ensure_ascii=False)}}]}

        finish = 'tool_calls'
        if self.server.mode == 'Simple':
            require(not tools, 'simple conversation unexpectedly used a tool')
            delta, finish = {'content': '已收到。'}, 'stop'
        elif not tools:
            delta = call('p8_initial', 'shell', arguments)
        elif not online:
            delta, finish = {'content': '本次健康检查未取得响应，保留失败，没有重新采样。'}, 'stop'
        elif len(tools) == 1:
            # Exit exercise revokes the settings while this request is in flight.
            self.server.entered.set()
            require(self.server.release.wait(40), 'exit exercise was not released')
            delta = call('p8_revision', 'revise_readonly_strategy', {
                'sourceId': 'p8_initial', 'refutedHypothesis': '首次健康检查已取得完整结果。',
                'changes': '对同一已授权端点独立只读采样，保留原失败。',
                'expectedInformation': '实际健康响应。', 'stopCondition': '权限、范围、在途状态或额度变化则停止。',
                'tool': 'shell', 'arguments': json.dumps(arguments)})
        elif len(tools) == 2:
            delta = call('p8_fresh', 'shell', arguments)
        else:
            require(len(tools) == 3 and 'P8_REAL_HEALTH' in tools[-1]['content'], 'missing actual health evidence')
            delta, finish = {'content': '新采样实际返回 healthy=true，原失败仍保留；不代表业务整体恢复。'}, 'stop'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        payload = {'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}],
                   'usage': {'prompt_tokens': 120, 'completion_tokens': 80, 'total_tokens': 200}}
        try:
            self.wfile.write(('data: ' + json.dumps(payload, ensure_ascii=False) + '\n\ndata: [DONE]\n\n').encode())
        except (BrokenPipeError, ConnectionResetError):
            require(self.server.mode == 'Exit', 'unexpected provider disconnect')


class Lake:
    def __init__(self, binary, home, env, native=None):
        self.home = home
        log = home / ('native.log' if native else 'backend.log')
        self.log = log.open('a')
        os.chmod(log, 0o600)
        runtime = home / 'web-agent/runtime.json'
        previous = runtime.stat().st_mtime_ns if runtime.exists() else 0
        command = [str(native), '--lake-home', str(home)] if native else [str(binary), 'web', '--home', str(home), '--port', '0']
        self.process = subprocess.Popen(command, env=env, stdout=self.log, stderr=self.log)

        def ready():
            require(self.process.poll() is None, 'Lake process exited before ready')
            try:
                if runtime.stat().st_mtime_ns != previous:
                    return json.loads(runtime.read_text())
            except (OSError, json.JSONDecodeError):
                pass
        try:
            self.runtime = wait_for(ready)
        except Exception:
            self.stop()
            raise

    def api(self, path, method='GET', data=None):
        headers = {'Authorization': 'Bearer ' + self.runtime['token']}
        if data is not None:
            headers.update({'Content-Type': 'application/json', 'Idempotency-Key': str(uuid.uuid4())})
        request = urllib.request.Request(self.runtime['origin'] + path, method=method, headers=headers,
                                         data=None if data is None else json.dumps(data).encode())
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)

    def switches(self, mode):
        settings = self.api('/api/strategy/settings')['settings']
        values = dict(zip(FLAGS, (mode != 'A', mode != 'A', False, mode in ('C', 'Exit'), mode in ('C', 'Exit'))))
        values.update(expectedRevision=settings['revision'], budget=settings['budget'])
        self.api('/api/strategy/settings', 'PATCH', values)

    def session(self, project, title):
        session = self.api('/api/projects/' + project + '/sessions', 'POST', {'title': title})
        self.api('/api/sessions/' + session['id'] + '/ai/configure', 'POST', {
            'asset_ref': session['resourceIds'][0], 'runtime': 'local', 'profile': 'core',
            'silentCommands': True, 'silentTerminalCreation': True, 'contextBudgetMode': 'manual',
            'contextWindow': 64000, 'maxOutput': 1024, 'maxSteps': 20})
        return session['id']

    def snapshot(self, session):
        return self.api('/api/sessions/' + session + '/ai/snapshot')

    def finish(self, session):
        def done():
            view = self.snapshot(session)
            require(view['status'] != 'waiting_approval', 'unexpected approval in readonly fixture')
            return view if view['status'] in ('completed', 'failed', 'cancelled', 'interrupted') else None
        return wait_for(done, 70)

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=25)
        self.log.close()


def setup(lake, provider):
    require(not lake.api('/api/bootstrap')['modelConfigured'], 'fresh Home contains model configuration')
    settings = lake.api('/api/strategy/settings')['settings']
    require(not any(settings[key] for key in FLAGS), 'strategy defaults are not off')
    project = lake.api('/api/projects', 'POST', {'name': 'P8 隔离验收'})['id']
    lake.api('/api/projects/' + project + '/sre', 'PUT', {'enabled': False})
    lake.api('/api/projects/' + project + '/memory-settings', 'PATCH',
             {'useEnabled': False, 'extractionEnabled': False, 'expectedRevision': 0})
    lake.api('/api/settings/model', 'PUT', {'url': f'http://127.0.0.1:{provider.server_port}',
                                          'name': 'P8 deterministic control fixture', 'protocol': 'openai'})
    asset = lake.api('/api/strategy/assets', 'POST', {
        'expectedRevision': 0, 'title': 'P8 可见健康检查方法', 'kind': 'report_guidance', 'body': BODY,
        'applicability': {'profiles': ['core'], 'resourceKinds': ['local'], 'domainTags': []}})
    ref = lake.api('/api/strategy/assets/' + asset['assetId'] + '/revisions/1')['value']['ref']
    lake.api('/api/strategy/assets/' + asset['assetId'] + '/bindings', 'POST', {
        'action': 'adopt', 'ref': ref, 'expectedRevision': 0, 'priority': 500, 'exclusionGroup': ''})
    return project, ref


def reports(view):
    return [card['data'] for card in view['cards'] if card['type'] == 'strategy_correction']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=pathlib.Path, default=pathlib.Path.home() / 'Applications/Lake Dev.app')
    parser.add_argument('--report', type=pathlib.Path, required=True)
    parser.add_argument('--hold-for-ui', action='store_true', required=True)
    args = parser.parse_args()
    info = plistlib.loads((args.app / 'Contents/Info.plist').read_bytes())
    require(info['CFBundleIdentifier'] == 'com.cleanlakes.lake.desktop.dev', 'only Lake Dev is allowed')
    origin = json.loads((args.app / 'Contents/Resources/build-origin.json').read_text())
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    require(origin['gitHead'] == head and not origin['dirty'], 'build must match clean HEAD')
    binary = args.app / 'Contents/Resources/lake'
    require(hashlib.sha256(binary.read_bytes()).hexdigest() == origin['backendSHA256'], 'backend hash mismatch')
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(args.app)], check=True)
    # Fresh Homes only, with no imported Skills/memory/secrets or inherited model overrides.
    env = {k: v for k, v in os.environ.items() if not k.startswith('LAKE_')}
    root = pathlib.Path(tempfile.mkdtemp(prefix='lake-p8-acceptance-'))
    os.chmod(root, 0o700)
    report = {'schemaVersion': 1, 'kind': 'deterministic_dev_acceptance', 'commit': head,
              'buildDirty': False, 'modelBenefitEvaluated': False, 'home': str(root), 'status': 'running',
              'runs': [], 'nativeUI': 'pending' if args.hold_for_ui else 'not_run'}
    args.report.parent.mkdir(parents=True, exist_ok=True)

    def save():
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        os.chmod(args.report, 0o600)
    save()
    provider, health = serve(Provider), serve(Health)
    provider.health = health
    provider.entered, provider.release = threading.Event(), threading.Event()
    lake = None
    try:
        # Rotate order and reset actual service state and Home for every arm.
        for repetition, order in enumerate(('ABC', 'BCA', 'CAB'), 1):
            for mode in order:
                provider.mode, provider.assets = mode, mode != 'A'
                provider.counts = dict.fromkeys(provider.counts, 0)
                provider.entered.clear()
                provider.release.set()
                health.counts['health'] = 0
                home = root / f'{repetition}-{mode}'
                home.mkdir(mode=0o700)
                lake = Lake(binary, home, env)
                project, ref = setup(lake, provider)
                lake.switches(mode)
                session = lake.session(project, f'P8 {mode} #{repetition}')
                start = time.monotonic()
                lake.api('/api/sessions/' + session + '/messages', 'POST', {'text': '检查已授权的本机健康端点，保留实际失败与响应。'})
                view = lake.finish(session)
                require(view['status'] == 'completed', 'paired task did not complete')
                correction = reports(view)
                require(health.counts['health'] == (2 if mode == 'C' else 1), 'unexpected resource operation count')
                require(provider.counts['provider'] == (4 if mode == 'C' else 2), 'unexpected provider count')
                require(len(correction) == (1 if mode == 'C' else 0), 'unexpected correction report')
                if correction:
                    result = correction[0]
                    require(result['recovered'] and not result['openChecks'] and result['stopReason'] == 'completed', 'failed gap closure')
                    require(result['requests'] == 3 and result['tokensCharged'] == 600 and not result['usageUnknown'], 'incorrect bounded budget')
                    require(result['selectedAssets'] == [ref] and len(result['revisions']) == 1, 'asset/revision mismatch')
                with sqlite3.connect('file:' + str(home / 'web-agent/adk/sessions.sqlite') + '?mode=ro', uri=True) as db:
                    parts = db.execute("select part from native_artifacts where file_name like 'prompt-manifest-%'").fetchall()
                    require(len(parts) == provider.counts['provider'], 'manifest count differs from actual dispatches')
                    for part, in parts:
                        manifest = json.loads(json.loads(part)['text'])
                        require((manifest.get('selectedAssets') or []) == ([ref] if mode != 'A' else []), 'manifest asset references differ')
                    operations = db.execute('select call_id,status,risk from native_operations where session_id=? order by started_at', (session,)).fetchall()
                    expected_ops = [('p8_initial', 'failed', 'readonly')]
                    if mode == 'C':
                        expected_ops.append(('p8_fresh', 'succeeded', 'readonly'))
                    require(operations == expected_ops, 'actual operation ledger differs')
                if mode == 'C':
                    lake.stop()
                    lake = Lake(binary, home, env)
                    require(reports(lake.snapshot(session)) == correction, 'completed report changed after restart')
                    require(health.counts['health'] == 2 and provider.counts['provider'] == 4, 'completed restart replayed work')
                report['runs'].append({'repetition': repetition, 'arm': mode, 'sessionId': session,
                                       'healthReads': health.counts['health'], 'modelRequests': provider.counts['provider'],
                                       'fixtureTokens': provider.counts['provider'] * 200,
                                       'seconds': round(time.monotonic() - start, 3), 'assetHash': ref['contentHash'],
                                       'manifestVerified': True, 'ledgerVerified': True,
                                       'completedRestartVerified': mode == 'C',
                                       'outcome': 'gap_closed' if correction else 'source_failure_retained'})
                lake.stop()
                lake = None
                save()
        # Native exit drill: revoke while a correction model request is in flight.
        home = root / 'native-exit'
        home.mkdir(mode=0o700)
        provider.mode, provider.assets = 'Exit', True
        provider.counts = dict.fromkeys(provider.counts, 0)
        provider.entered.clear()
        provider.release.clear()
        health.counts['health'] = 0
        lake = Lake(binary, home, env, args.app / 'Contents/MacOS/Lake')
        project, ref = setup(lake, provider)
        lake.switches('Exit')
        session = lake.session(project, 'P8 运行中关闭与退出演练')
        lake.api('/api/sessions/' + session + '/messages', 'POST', {'text': '检查已授权本机健康端点，遇到停止须保留原记录。'})
        require(provider.entered.wait(40), 'correction phase never entered')
        lake.switches('A')
        provider.assets = False
        provider.release.set()
        stopped = lake.finish(session)
        require(stopped['status'] in ('cancelled', 'failed', 'interrupted'), 'revoked correction falsely completed')
        require(health.counts['health'] == 1, 'revocation allowed a new resource read')
        retained = reports(stopped)
        require(len(retained) == 1, 'missing durable correction audit')
        require(lake.api('/api/strategy/assets/' + ref['assetId'] + '/revisions/1')['value']['ref'] == ref, 'switch-off changed asset')
        # Re-enable; ordinary no-tool work must not resume the old correction.
        lake.switches('C')
        provider.mode, provider.assets = 'Simple', True
        simple = lake.session(project, 'P8 无关对话不触发纠错')
        before = provider.counts['provider']
        lake.api('/api/sessions/' + simple + '/messages', 'POST', {'text': '只回复收到，不需要工具。'})
        require(lake.finish(simple)['status'] == 'completed', 'ordinary turn failed')
        require(provider.counts['provider'] == before + 1 and health.counts['health'] == 1, 're-enable replayed old work')
        require(not reports(lake.snapshot(simple)), 'unrelated conversation started correction')
        report['exitDrill'] = {'revokedStatus': stopped['status'], 'healthReads': 1,
                               'assetPreserved': True, 'reenableReplayed': False,
                               'simpleRequests': 1, 'retainedStopReason': retained[0]['stopReason']}
        report['uiSessionId'], report['uiProjectId'] = session, project
        report['uiHome'] = str(home)
        save()
        print('Native Dev ready for manual QA; report: ' + str(args.report), flush=True)
        if args.hold_for_ui:
            wait_for(lambda: lake.process.poll() is not None, 1800)
        else:
            # Native shutdown must run AppKit's normal quit path. Automated
            # callers without UI should omit native acceptance, not kill it.
            raise RuntimeError('Quit Lake Dev normally; rerun with --hold-for-ui')
        lake.log.close()
        lake = None
        # Normal native quit shuts its owned backend down. The restart uses the
        # same signed backend and Home; fixtures remain alive to detect replay.
        previous_reads = health.counts['health']
        previous_requests = provider.counts['provider']
        lake = Lake(binary, home, env)
        require(reports(lake.snapshot(session)) == retained, 'restart changed the correction audit')
        with sqlite3.connect('file:' + str(home / 'web-agent/adk/sessions.sqlite') + '?mode=ro', uri=True) as db:
            operations = db.execute('select call_id,status,risk from native_operations where session_id=?', (session,)).fetchall()
            require(operations == [('p8_initial', 'failed', 'readonly')], 'source operation was lost or replayed')
            require(db.execute('pragma integrity_check').fetchone()[0] == 'ok', 'native DB integrity failed')
            count = db.execute('select count(*) from native_operations').fetchone()[0]
            for _ in range(12):
                require(reports(lake.snapshot(session)) == retained, 'idle changed the audit')
                time.sleep(.25)
            require(db.execute('select count(*) from native_operations').fetchone()[0] == count, 'restart dispatched operations')
        with sqlite3.connect('file:' + str(home / 'web-agent/lake-web.sqlite') + '?mode=ro', uri=True) as db:
            require(db.execute('pragma integrity_check').fetchone()[0] == 'ok', 'web DB integrity failed')
        require(health.counts['health'] == previous_reads and provider.counts['provider'] == previous_requests, 'restart replayed requests')
        require(provider.errors == 0 and health.errors == 0, 'fixture handler failed')
        report['restart'] = {'sameReport': True, 'operationCountUnchanged': True,
                             'modelRequestsUnchanged': True, 'nativeIntegrity': 'ok', 'webIntegrity': 'ok'}
        report['nativeUI'] = 'manual_review_required'
        report['status'] = 'passed'
        save()
        print('Deterministic control flow, exit and restart passed; no model-benefit claim.', flush=True)
    except Exception as error:
        report['status'], report['error'] = 'failed', type(error).__name__
        save()
        raise
    finally:
        provider.release.set()
        if lake is not None:
            # A native window is intentionally left available on a failure for
            # inspection; quit it through Lake Dev, never touch production.
            if lake.process.args[0] == str(binary):
                lake.stop()
        provider.shutdown()
        health.shutdown()


if __name__ == '__main__':
    main()
